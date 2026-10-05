import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Gazetteer } from "../core/anchors.js";
import { AppError, toAppError } from "../core/errors.js";
import type { HotelMemory } from "../core/hotel-memory.js";
import { searchHotels, type HotelSearchDeps, type RankedHotel } from "../core/hotel-search.js";
import { cheapest, isSameHotel, nameSimilarity } from "../core/merge.js";
import type { HotelCandidate, PriceQuote } from "../core/types.js";
import { convertToInr } from "../providers/fx.js";
import type { TrivagoProvider } from "../providers/trivago.js";
import type { Xotelo } from "../providers/xotelo.js";
import { handle, readOnly } from "./common.js";
import { SourceOut, sourcesOut } from "./source-out.js";
import { occupancyFields, occupancyNote, validateOccupancy } from "./occupancy.js";
import { validateDates } from "./hotels.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

export interface RatesToolDeps {
  hotels: HotelSearchDeps;
  gazetteer: Gazetteer;
  xotelo: Pick<Xotelo, "rates" | "info">;
  trivago: Pick<TrivagoProvider, "lookup" | "info">;
  /** Called when an exchange-rate fetch fails during one request (set per request by the handler). */
  onFxError?: (e: AppError) => void;
  memory: HotelMemory;
  now: () => Date;
}

// Re-searching this close to the hotel finds it in every source without pulling in the neighbourhood.
const LOOKUP_RADIUS_KM = 0.4;

export function registerRatesTool(server: McpServer, deps: RatesToolDeps): void {
  server.registerTool(
    "get_hotel_rates",
    {
      title: "Compare a hotel's prices across sites",
      description:
        "Fetches current prices for one hotel from every source for the given dates, grouped by source: each " +
        "source's own name, rating, property type, amenities and link, with all its offers (booking site such " +
        "as Booking.com, Agoda or MakeMyTrip; price in INR and the original currency; taxes; refundability; " +
        "availability; room and meals as the source names them; link), cheapest first. The hotel is a hotel_id " +
        "from search_hotels or plan_stays, or a name with lat/lng. Does not book.",
      inputSchema: {
        hotel_id: z
          .string()
          .optional()
          .describe("hotel_id (or any of its also_ids) from search_hotels or plan_stays."),
        name: z.string().max(120).optional().describe("Hotel name, when not giving hotel_id."),
        lat: z.number().min(6).max(37.5).optional().describe("Hotel latitude, when not giving hotel_id."),
        lng: z.number().min(68).max(97.5).optional().describe("Hotel longitude, when not giving hotel_id."),
        check_in: isoDate.describe("Check-in date, YYYY-MM-DD (IST)."),
        check_out: isoDate.describe("Check-out date, YYYY-MM-DD."),
        ...occupancyFields,
      },
      outputSchema: {
        hotel: z
          .object({
            hotel_id: z.string().describe("Hotel id as source:source_id of the first source that listed it."),
            also_ids: z
              .array(z.string())
              .describe(
                "Ids (source:source_id) of the same hotel at other sources; each resolves to this hotel.",
              ),
            name: z.string().describe("Hotel name as the first source gives it."),
            lat: z.number().describe("Hotel latitude."),
            lng: z.number().describe("Hotel longitude."),
            stars: z.number().nullable().describe("Official hotel class, 1–5 stars (null if unknown)."),
            rating_10: z
              .number()
              .nullable()
              .describe(
                "Guest review score on a 0–10 scale, from the source with the most reviews (null if unrated).",
              ),
            review_count: z
              .number()
              .nullable()
              .describe("Number of guest reviews behind rating_10 (null if unknown)."),
          })
          .describe("The hotel the prices are for, as the sources list it."),
        check_in: z.string().describe("Check-in date, YYYY-MM-DD."),
        check_out: z.string().describe("Check-out date, YYYY-MM-DD."),
        sources: z
          .array(SourceOut)
          .describe(
            "Each source's own listing of the hotel (name, rating, details, link) with all its offers, cheapest source first.",
          ),
        cheapest_inr: z
          .number()
          .nullable()
          .describe("Lowest bookable per_night_inr across all sources (null if none in INR)."),
        priciest_inr: z
          .number()
          .nullable()
          .describe("Highest per_night_inr across all sources (null if none in INR)."),
        sources_ok: z
          .array(z.string())
          .describe("Ids of the sources that answered the re-search near the hotel."),
        sources_failed: z
          .array(
            z.object({
              source: z.string().describe("Id of the source that failed."),
              code: z.string().describe("Error code, e.g. UPSTREAM_UNAVAILABLE or RATE_LIMITED."),
              message: z.string().describe("What went wrong."),
            }),
          )
          .describe("Sources or lookups that did not answer, and why."),
        notes: z.array(z.string()).describe("Caveats about the prices."),
      },
      annotations: readOnly("Compare a hotel's prices across sites"),
    },
    handle(async (a) => {
      // Per request: exchange-rate failures in direct lookups are reported, not swallowed.
      const fxErrors: AppError[] = [];
      const rq: RatesToolDeps = { ...deps, onFxError: (e) => fxErrors.push(e) };
      validateDates(a.check_in, a.check_out, rq.now());
      validateOccupancy(a.adults, a.children_ages);
      const remembered = a.hotel_id ? rq.memory.get(a.hotel_id) : undefined;
      const known = remembered?.hotel;
      if (a.hotel_id && !known && (a.lat === undefined || a.lng === undefined || !a.name)) {
        throw new AppError(
          "NOT_FOUND",
          `hotel_id ${a.hotel_id} is not from a recent search.`,
          "Run search_hotels again, or pass the hotel's name, lat and lng.",
        );
      }
      if (!known && (a.lat === undefined || a.lng === undefined || !a.name)) {
        throw new AppError("INVALID_INPUT", "Give a hotel_id, or the hotel's name, lat and lng.");
      }
      const target = known ?? { hotel_id: "", also_ids: [], name: a.name!, lat: a.lat!, lng: a.lng! };
      const targetIds = new Set([target.hotel_id, ...target.also_ids].filter(Boolean));

      const partyQ = {
        check_in: a.check_in,
        check_out: a.check_out,
        adults: a.adults,
        children_ages: a.children_ages,
      };
      // Everything that only needs the hotel's known ids starts now, alongside the re-search, so a check
      // costs about one source's response time instead of several in a row.
      const startIds = [target.hotel_id, ...target.also_ids].filter(Boolean);
      const tvId = startIds.find((id) => id.startsWith("trivago:"));
      // Listings found by direct lookups, for their source's section when the re-search lacked them.
      const lookupListings: HotelCandidate[] = [];
      const xoId = startIds.find((id) => id.startsWith("xotelo:"));
      // Party lookups start early only for sources the earlier search had no price from (the re-search
      // usually returns the others); otherwise they run afterwards, and only if needed.
      const hadPrice = (src: string) => remembered?.hotel.prices.some((p) => p.source === src) ?? false;
      const tvParty =
        tvId && !hadPrice("trivago")
          ? settle(trivagoQuotes(rq, tvId, target.name, partyQ, (l) => lookupListings.push(l)))
          : undefined;
      const xoParty = xoId && !hadPrice("xotelo") ? settle(xoteloQuotes(rq, xoId, partyQ)) : undefined;

      const r = await searchHotels(
        rq.hotels,
        {
          lat: target.lat,
          lng: target.lng,
          radius_km: LOOKUP_RADIUS_KM,
          ...partyQ,
          // Text-only sources look the hotel up by name, with the nearest station for city context.
          hotel_name: target.name,
          place: rq.gazetteer.nearby(target).stations[0]?.name,
        },
        { sort: "distance", include_unpriced: true },
      );
      // Same listing by id, else the nearest listing that looks like the same property.
      let match: RankedHotel | undefined =
        r.hotels.find((h) => [h.hotel_id, ...h.also_ids].some((id) => targetIds.has(id))) ??
        r.hotels
          .filter((h) => isSameHotel(target, h))
          .sort(
            (x, y) =>
              nameSimilarity(target.name, y.name) - nameSimilarity(target.name, x.name) ||
              x.distance_km - y.distance_km,
          )[0];
      // The live re-search can miss a hotel (trivago returns a fixed 25 around a point). Fall back to the
      // prices the search returned for the same stay and party, and say so.
      const sameRequest =
        remembered &&
        remembered.check_in === a.check_in &&
        remembered.check_out === a.check_out &&
        remembered.adults === a.adults &&
        [...remembered.children_ages].sort().join(",") === [...a.children_ages].sort().join(",");
      let fromSearch = false;
      if (!match && sameRequest) {
        const h = remembered.hotel;
        match = {
          ...h,
          distance_km: 0,
          cheapest: cheapest(h.prices),
        };
        fromSearch = true;
      }
      if (!match) {
        throw new AppError(
          "NOT_FOUND",
          `No source lists "${target.name}" at these coordinates for ${a.check_in}–${a.check_out}.`,
          "Check the dates, or search_hotels again near the hotel.",
        );
      }

      // The live match may lack ids only the original search knew (e.g. trivago's, when its area search
      // missed the hotel this time); keep them so name lookups and direct rate calls can still run.
      const knownIds = [target.hotel_id, ...target.also_ids].filter((id) => id && id !== match!.hotel_id);
      const withIds: RankedHotel = { ...match, also_ids: [...new Set([...match.also_ids, ...knownIds])] };
      // Answer for the hotel that was asked about. The live re-check can return another source's listing of the
      // same place (e.g. "Treebo Trip Royal Inn" for trivago's "ROYAL INN"), with its own name, id and often a
      // thinner rating; keep the asked-for identity and the rating backed by more reviews.
      const rated = [known, match]
        .filter((h): h is NonNullable<typeof h> => !!h && h.rating_10 !== null)
        .sort((x, y) => (y.review_count ?? 0) - (x.review_count ?? 0))[0];
      const identityHotel = {
        ...match,
        hotel_id: known?.hotel_id ?? match.hotel_id,
        also_ids: [...new Set([...withIds.also_ids, match.hotel_id])].filter(
          (id) => id !== (known?.hotel_id ?? match.hotel_id),
        ),
        name: known?.name ?? match.name,
        lat: known?.lat ?? match.lat,
        lng: known?.lng ?? match.lng,
        stars: known?.stars ?? match.stars,
        rating_10: rated?.rating_10 ?? null,
        review_count: rated?.review_count ?? null,
      };
      const relisted =
        known && !fromSearch && match.hotel_id !== known.hotel_id && match.name !== known.name
          ? [
              `The live re-check lists this hotel as "${match.name}" (${match.hotel_id}), matched by name and location.`,
            ]
          : [];
      const prices: PriceQuote[] = [...match.prices];
      const sources_failed = [...r.sources_failed];
      const lookupNotes: string[] = [];
      // Fill in trivago and Xotelo from their direct lookups when the re-search lacks them; when falling back
      // to the search's prices, a live price beats a remembered one.
      for (const [source, started] of [
        ["trivago", tvParty],
        ["xotelo", xoParty],
      ] as const) {
        if (!fromSearch && prices.some((p) => p.source === source)) continue;
        // An id first seen in this re-search (hotel given by name and coordinates) is looked up now.
        const id = [withIds.hotel_id, ...withIds.also_ids].find((x) => x.startsWith(`${source}:`));
        const pending =
          started ??
          (id
            ? settle(
                source === "trivago"
                  ? trivagoQuotes(rq, id, target.name, partyQ, (l) => lookupListings.push(l))
                  : xoteloQuotes(rq, id, partyQ),
              )
            : undefined);
        if (!pending) continue;
        const res = await pending;
        if ("error" in res) {
          sources_failed.push({ source, code: res.error.code, message: res.error.message });
        } else if (res.value.length) {
          for (let i = prices.length - 1; i >= 0; i--) if (prices[i]!.source === source) prices.splice(i, 1);
          prices.push(...res.value);
        } else {
          lookupNotes.push(`${source} did not list this hotel for these dates on the live re-check.`);
        }
      }
      // The live match can be a nearby listing with a similar name and no prices; then the search's own prices
      // for the same stay and party are the better answer.
      let listedWithoutPrice = false;
      if (!fromSearch && prices.length === 0 && sameRequest && remembered.hotel.prices.length > 0) {
        prices.push(...remembered.hotel.prices);
        fromSearch = true;
        listedWithoutPrice = true;
      }

      const notes = [
        ...(fromSearch
          ? [
              listedWithoutPrice
                ? "On the live re-check the hotel was listed without a price, so these are the prices from the search that returned it (see fetched_at)."
                : "No source listed this hotel on the live re-check, so these are the prices from the search that returned it (see fetched_at).",
            ]
          : []),
        ...relisted,
        ...lookupNotes,
        occupancyNote(a.adults, a.children_ages),
        "Meta-search prices can differ at checkout; includes_taxes=null means the source does not say whether GST is included.",
      ];
      if (fxErrors[0])
        sources_failed.push({ source: "fx", code: fxErrors[0].code, message: fxErrors[0].message });
      const unconverted = prices.filter((p) => p.per_night_inr === null && p.currency !== "INR").length;
      if (unconverted > 0) {
        notes.push(
          `${unconverted} prices could not be converted to INR (no exchange rate); they are listed last in their source.`,
        );
      }

      const sources = sourcesOut(
        // A direct lookup is fresher than the search's listing of the same source, so it comes first.
        { ...identityHotel, listings: [...lookupListings, ...identityHotel.listings] },
        prices,
      );
      const inr = prices
        .filter((p) => p.available !== false)
        .map((p) => p.per_night_inr)
        .filter((v): v is number => v !== null);

      // Re-remembering the search's own prices would only extend how long stale prices are served.
      if (!fromSearch) {
        rq.memory.remember([identityHotel], {
          check_in: a.check_in,
          check_out: a.check_out,
          adults: a.adults,
          children_ages: a.children_ages,
        });
      }
      if (prices.length === 0) notes.push("No source has a live price for this hotel on these dates.");
      return {
        hotel: {
          hotel_id: identityHotel.hotel_id,
          also_ids: identityHotel.also_ids,
          name: identityHotel.name,
          lat: identityHotel.lat,
          lng: identityHotel.lng,
          stars: identityHotel.stars,
          rating_10: identityHotel.rating_10,
          review_count: identityHotel.review_count,
        },
        check_in: a.check_in,
        check_out: a.check_out,
        sources,
        cheapest_inr: inr.length ? Math.min(...inr) : null,
        priciest_inr: inr.length ? Math.max(...inr) : null,
        sources_ok: r.sources_ok,
        sources_failed,
        notes,
      };
    }),
  );
}

type Settled<T> = { value: T } | { error: AppError };

/** Resolves to a value or the normalised error, so parallel lookups can be awaited in any order. */
function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ value }),
    (err: unknown) => ({ error: toAppError(err) }),
  );
}

type Stay = { check_in: string; check_out: string; adults: number; children_ages: number[] };

/** trivago's prices for one hotel looked up by name and id-checked, in INR; [] if not listed. */
async function trivagoQuotes(
  deps: RatesToolDeps,
  id: string,
  name: string,
  q: Stay,
  onListing?: (listing: HotelCandidate) => void,
): Promise<PriceQuote[]> {
  if (!deps.hotels.registry.isEnabled(deps.trivago.info.id)) return [];
  const found = await deps.hotels.registry.run(
    deps.trivago.info.id,
    () => deps.trivago.lookup(id.slice("trivago:".length), name, undefined, q),
    deps.hotels.deadlineMs,
  );
  // Its listing (name, rating, amenities, link) feeds the trivago section when the re-search lacked it.
  if (found) onListing?.(found);
  return withInr(deps, found?.prices ?? []);
}

/** Xotelo's per-site prices for one hotel by its key, in INR; [] if disabled. */
async function xoteloQuotes(deps: RatesToolDeps, id: string, q: Stay): Promise<PriceQuote[]> {
  if (!deps.hotels.registry.isEnabled(deps.xotelo.info.id)) return [];
  const quotes = await deps.hotels.registry.run(
    deps.xotelo.info.id,
    () => deps.xotelo.rates(id.slice("xotelo:".length), q.check_in, q.check_out, q.adults, q.children_ages),
    deps.hotels.deadlineMs,
  );
  return withInr(deps, quotes);
}

/** INR conversion (non-INR converted, not dropped) for directly fetched quotes. */
async function withInr(deps: RatesToolDeps, quotes: PriceQuote[]): Promise<PriceQuote[]> {
  // A failed exchange-rate fetch leaves non-INR prices unconverted and is reported through onFxError.
  const fx = quotes.some((p) => p.currency !== "INR")
    ? await deps.hotels.fx.rates().catch((err: unknown) => {
        deps.onFxError?.(toAppError(err));
        return null;
      })
    : null;
  return quotes.map((p) => {
    const inr =
      p.currency === "INR" ? Math.round(p.per_night) : fx ? convertToInr(p.per_night, p.currency, fx) : null;
    return { ...p, per_night_inr: inr };
  });
}
