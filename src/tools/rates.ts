import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Gazetteer } from "../core/anchors.js";
import { AppError, toAppError } from "../core/errors.js";
import type { HotelMemory } from "../core/hotel-memory.js";
import {
  searchHotels,
  type HotelSearchDeps,
  type RankedHotel,
  type SourceFailure,
} from "../core/hotel-search.js";
import { cheapest, isSameHotel, nameSimilarity } from "../core/merge.js";
import {
  cheapestSingleRoom,
  occupancyLabel,
  SINGLE_ROOM_VERDICTS,
  singleRoomVerdict,
  VERDICT_MAX_GUESTS,
} from "../core/occupancy.js";
import type { PriceQuote } from "../core/types.js";
import { convertToInr } from "../providers/fx.js";
import type { TrivagoProvider } from "../providers/trivago.js";
import type { Xotelo } from "../providers/xotelo.js";
import { handle, readOnly } from "./common.js";
import { occupancyFields, occupancyNote, validateOccupancy } from "./occupancy.js";
import { validateDates } from "./hotels.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

const QuoteOut = z.object({
  seller: z.string(),
  source: z.string(),
  per_night_inr: z.number().nullable(),
  per_night: z.number(),
  currency: z.string(),
  total: z.number().nullable(),
  includes_taxes: z.boolean().nullable(),
  available: z.boolean().nullable(),
  refundable: z.boolean().nullable(),
  url: z.string().nullable(),
  room: z.string().nullable(),
  occupancy: z.enum(["confirmed", "likely", "unverified"]),
  occupancy_note: z.string().nullable(),
  single_room_check: z
    .object({
      verdict: z.enum(SINGLE_ROOM_VERDICTS),
      two_adult_per_night_inr: z.number().nullable(),
      ratio: z.number().nullable(),
    })
    .nullable()
    .describe("Present when check_single_room ran for this price."),
  fetched_at: z.string(),
});

export interface RatesToolDeps {
  hotels: HotelSearchDeps;
  gazetteer: Gazetteer;
  xotelo: Pick<Xotelo, "rates" | "info">;
  trivago: Pick<TrivagoProvider, "lookup" | "info">;
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
        "Fetches current prices for one hotel from every source for the given dates and lists them per " +
        "booking site (e.g. Booking.com, Agoda, Trip.com, MakeMyTrip, the hotel's own site), cheapest first, in " +
        "INR with the original currency, tax status, availability, links and, where the source names it, the " +
        'room type (e.g. "Family Room with 2 Double Beds"). The hotel is a hotel_id from ' +
        "search_hotels or plan_stays, or a name with lat/lng. Does not book.",
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
        check_single_room: z
          .boolean()
          .default(false)
          .describe(
            "For parties of 3+, re-price the sources whose prices are unverified as one room (trivago, Xotelo) " +
              "for 2 adults and compare each seller's price: about exactly double suggests two rooms.",
          ),
      },
      outputSchema: {
        hotel: z.object({
          hotel_id: z.string(),
          also_ids: z.array(z.string()),
          name: z.string(),
          lat: z.number(),
          lng: z.number(),
          stars: z.number().nullable(),
          rating_10: z.number().nullable(),
          review_count: z.number().nullable(),
        }),
        check_in: z.string(),
        check_out: z.string(),
        prices: z.array(QuoteOut),
        cheapest_inr: z.number().nullable(),
        priciest_inr: z.number().nullable(),
        sources_ok: z.array(z.string()),
        sources_failed: z.array(z.object({ source: z.string(), code: z.string(), message: z.string() })),
        notes: z.array(z.string()),
      },
      annotations: readOnly("Compare a hotel's prices across sites"),
    },
    handle(async (a) => {
      validateDates(a.check_in, a.check_out, deps.now());
      validateOccupancy(a.adults, a.children_ages);
      const guests = a.adults + a.children_ages.length;
      const remembered = a.hotel_id ? deps.memory.get(a.hotel_id) : undefined;
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
      const xoId = startIds.find((id) => id.startsWith("xotelo:"));
      const wantsBaseline = a.check_single_room && guests > 2 && guests <= VERDICT_MAX_GUESTS;
      // Party lookups start early only for sources the earlier search had no price from (the re-search
      // usually returns the others); otherwise they run afterwards, and only if needed.
      const hadPrice = (src: string) => remembered?.hotel.prices.some((p) => p.source === src) ?? false;
      const tvParty =
        tvId && !hadPrice("trivago") ? settle(trivagoQuotes(deps, tvId, target.name, partyQ)) : undefined;
      const xoParty = xoId && !hadPrice("xotelo") ? settle(xoteloQuotes(deps, xoId, partyQ)) : undefined;
      const tvBase =
        wantsBaseline && tvId
          ? settle(trivagoQuotes(deps, tvId, target.name, { ...partyQ, adults: 2, children_ages: [] }))
          : undefined;
      const xoBase =
        wantsBaseline && xoId
          ? settle(xoteloQuotes(deps, xoId, { ...partyQ, adults: 2, children_ages: [] }))
          : undefined;

      const r = await searchHotels(
        deps.hotels,
        {
          lat: target.lat,
          lng: target.lng,
          radius_km: LOOKUP_RADIUS_KM,
          ...partyQ,
          // Text-only sources look the hotel up by name, with the nearest station for city context.
          hotel_name: target.name,
          place: deps.gazetteer.nearby(target).stations[0]?.name,
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
          cheapest_single_room: cheapestSingleRoom(h.prices),
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
      const prices: PriceQuote[] = [...match.prices];
      const sources_failed = [...r.sources_failed];
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
                  ? trivagoQuotes(deps, id, withIds.name, partyQ)
                  : xoteloQuotes(deps, id, partyQ),
              )
            : undefined);
        if (!pending) continue;
        const res = await pending;
        if ("error" in res) {
          sources_failed.push({ source, code: res.error.code, message: res.error.message });
        } else if (res.value.length) {
          for (let i = prices.length - 1; i >= 0; i--) if (prices[i]!.source === source) prices.splice(i, 1);
          prices.push(...res.value);
        }
      }

      const notes = [
        ...(fromSearch
          ? [
              "No source listed this hotel on the live re-check, so these are the prices from the search that returned it (see fetched_at).",
            ]
          : []),
        occupancyNote(a.adults, a.children_ages),
        "Meta-search prices can differ at checkout; includes_taxes=null means the source does not say whether GST is included.",
      ];
      const checks = new Map<PriceQuote, z.infer<typeof SingleRoomCheck>>();
      const unverified = prices.filter((p) => p.occupancy === "unverified");
      if (a.check_single_room && unverified.length > 0) {
        try {
          const baseline = new Map<string, number>();
          const failures: SourceFailure[] = [];
          for (const [source, pending] of [
            ["trivago", tvBase],
            ["xotelo", xoBase],
          ] as const) {
            if (!pending) continue;
            const res = await pending;
            if ("error" in res) failures.push({ source, code: res.error.code, message: res.error.message });
            else
              for (const q of res.value)
                if (q.per_night_inr !== null) baseline.set(baselineKey(source, q.seller), q.per_night_inr);
          }
          // Only sources whose id wasn't known up front (rare) get a 2-adult re-search near the hotel; a
          // preloaded lookup that failed or found nothing is final (no second, slower attempt).
          const preloaded = new Set([...(tvBase ? ["trivago"] : []), ...(xoBase ? ["xotelo"] : [])]);
          const missing = new Set(unverified.map((p) => p.source).filter((src) => !preloaded.has(src)));
          if (missing.size) {
            const more = await twoAdultPrices(deps, withIds, a.check_in, a.check_out, missing);
            for (const [k, v] of more.prices) baseline.set(k, v);
            failures.push(...more.failures);
          }
          for (const p of unverified) {
            const base = baseline.get(baselineKey(p.source, p.seller)) ?? null;
            checks.set(p, {
              verdict: singleRoomVerdict(p.per_night_inr, base, guests),
              two_adult_per_night_inr: base,
              ratio:
                base && p.per_night_inr !== null ? Math.round((p.per_night_inr / base) * 100) / 100 : null,
            });
          }
          for (const f of failures) sources_failed.push({ ...f, source: `single_room_check:${f.source}` });
          if (fromSearch && baseline.size === 0) {
            notes.push(
              "single_room_check could not fetch 2-adult prices: the live re-check does not list this hotel, so its verdicts are unknown.",
            );
          }
          notes.push(
            guests > VERDICT_MAX_GUESTS
              ? `single_room_check gives no verdict for ${guests} guests: three or more rooms would not show as doubling.`
              : "single_room_check compares each unverified price with the same seller's 2-adult price for this hotel: ≤1.1x priced_as_2_adults (probably a two-person room), 1.1–1.85x plausible_single_room, 1.85–2.15x looks_like_2_rooms, 2.15–4x unusually_high, ≥4x implausible; unknown means no 2-adult price to compare.",
          );
        } catch (err) {
          const e = toAppError(err);
          sources_failed.push({ source: "single_room_check", code: e.code, message: e.message });
        }
      }

      const sorted = prices
        .map((p) => ({
          seller: p.seller ?? p.source,
          source: p.source,
          per_night_inr: p.per_night_inr,
          per_night: p.per_night,
          currency: p.currency,
          total: p.total,
          includes_taxes: p.includes_taxes,
          available: p.available,
          refundable: p.refundable,
          url: p.url,
          room: p.room,
          occupancy: p.occupancy ?? "likely",
          occupancy_note: p.occupancy_note ?? null,
          single_room_check: checks.get(p) ?? null,
          fetched_at: p.fetched_at,
        }))
        .sort((x, y) => (x.per_night_inr ?? Infinity) - (y.per_night_inr ?? Infinity));
      const inr = sorted.map((p) => p.per_night_inr).filter((v): v is number => v !== null);

      // Re-remembering the search's own prices would only extend how long stale prices are served.
      if (!fromSearch) {
        deps.memory.remember([match], {
          check_in: a.check_in,
          check_out: a.check_out,
          adults: a.adults,
          children_ages: a.children_ages,
        });
      }
      if (sorted.length === 0) notes.push("No source has a live price for this hotel on these dates.");
      return {
        hotel: {
          hotel_id: match.hotel_id,
          also_ids: match.also_ids,
          name: match.name,
          lat: match.lat,
          lng: match.lng,
          stars: match.stars,
          rating_10: match.rating_10,
          review_count: match.review_count,
        },
        check_in: a.check_in,
        check_out: a.check_out,
        prices: sorted,
        cheapest_inr: inr.length ? Math.min(...inr) : null,
        priciest_inr: inr.length ? Math.max(...inr) : null,
        sources_ok: r.sources_ok,
        sources_failed,
        notes,
      };
    }),
  );
}

const SingleRoomCheck = z.object({
  verdict: z.enum(SINGLE_ROOM_VERDICTS),
  two_adult_per_night_inr: z.number().nullable(),
  ratio: z.number().nullable(),
});

/**
 * Prices are compared per seller where a source lists several (Xotelo), but per source where it shows
 * only its cheapest advertiser (trivago), which can change with the party size.
 */
function baselineKey(source: string, seller: string | null): string {
  return source === "trivago" ? "trivago|*" : `${source}|${seller ?? ""}`;
}

/** Each seller's 2-adult, one-room price for this hotel, from the given sources only ("source|seller" → INR). */
async function twoAdultPrices(
  deps: RatesToolDeps,
  hotel: RankedHotel,
  checkIn: string,
  checkOut: string,
  sources: Set<string>,
): Promise<{ prices: Map<string, number>; failures: SourceFailure[] }> {
  const ids = new Set([hotel.hotel_id, ...hotel.also_ids]);
  const r = await searchHotels(
    { ...deps.hotels, providers: deps.hotels.providers.filter((p) => sources.has(p.info.id)) },
    {
      lat: hotel.lat,
      lng: hotel.lng,
      radius_km: LOOKUP_RADIUS_KM,
      check_in: checkIn,
      check_out: checkOut,
      adults: 2,
    },
    { sort: "distance", include_unpriced: true },
  );
  const failures = [...r.sources_failed];
  const same =
    r.hotels.find((h) => [h.hotel_id, ...h.also_ids].some((id) => ids.has(id))) ??
    r.hotels.find((h) => isSameHotel(hotel, h));
  const prices = new Map<string, number>();
  // searchHotels has already converted these to INR.
  for (const p of same?.prices ?? []) {
    if (p.per_night_inr !== null) prices.set(baselineKey(p.source, p.seller), p.per_night_inr);
  }
  // trivago's area search can leave the hotel out; look it up by name. A failure keeps the other baselines.
  if (sources.has("trivago") && !prices.has(baselineKey("trivago", null))) {
    try {
      const tvId = [hotel.hotel_id, ...hotel.also_ids].find((x) => x.startsWith("trivago:"));
      const live = tvId
        ? await trivagoQuotes(deps, tvId, hotel.name, {
            check_in: checkIn,
            check_out: checkOut,
            adults: 2,
            children_ages: [],
          })
        : [];
      for (const p of live)
        if (p.per_night_inr !== null) prices.set(baselineKey("trivago", p.seller), p.per_night_inr);
    } catch (err) {
      const e = toAppError(err);
      failures.push({ source: deps.trivago.info.id, code: e.code, message: e.message });
    }
  }
  // Xotelo prices only the nearest hotels in a search; ask for this one directly if needed. A failure here
  // keeps the other sources' baselines.
  const xoteloId = [hotel.hotel_id, ...hotel.also_ids].find((id) => id.startsWith("xotelo:"));
  if (sources.has("xotelo") && xoteloId && ![...prices.keys()].some((k) => k.startsWith("xotelo|"))) {
    try {
      const quotes = await deps.hotels.registry.run(deps.xotelo.info.id, () =>
        deps.xotelo.rates(xoteloId.slice("xotelo:".length), checkIn, checkOut, 2),
      );
      const fx = quotes.some((q) => q.currency !== "INR") ? await deps.hotels.fx.rates() : null;
      for (const q of quotes) {
        const inr =
          q.currency === "INR"
            ? Math.round(q.per_night)
            : fx
              ? convertToInr(q.per_night, q.currency, fx)
              : null;
        if (inr !== null) prices.set(baselineKey("xotelo", q.seller), inr);
      }
    } catch (err) {
      const e = toAppError(err);
      failures.push({ source: deps.xotelo.info.id, code: e.code, message: e.message });
    }
  }
  return { prices, failures };
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

/** trivago's prices for one hotel looked up by name and id-checked, labelled for the party; [] if not listed. */
async function trivagoQuotes(deps: RatesToolDeps, id: string, name: string, q: Stay): Promise<PriceQuote[]> {
  if (!deps.hotels.registry.isEnabled(deps.trivago.info.id)) return [];
  const found = await deps.hotels.registry.run(
    deps.trivago.info.id,
    () => deps.trivago.lookup(id.slice("trivago:".length), name, undefined, q),
    deps.hotels.deadlineMs,
  );
  return labelled(deps, found?.prices ?? [], q);
}

/** Xotelo's per-site prices for one hotel by its key, labelled for the party; [] if disabled. */
async function xoteloQuotes(deps: RatesToolDeps, id: string, q: Stay): Promise<PriceQuote[]> {
  if (!deps.hotels.registry.isEnabled(deps.xotelo.info.id)) return [];
  const quotes = await deps.hotels.registry.run(
    deps.xotelo.info.id,
    () => deps.xotelo.rates(id.slice("xotelo:".length), q.check_in, q.check_out, q.adults, q.children_ages),
    deps.hotels.deadlineMs,
  );
  return labelled(deps, quotes, q);
}

/** INR conversion (non-INR converted, not dropped) and occupancy labels for directly fetched quotes. */
async function labelled(deps: RatesToolDeps, quotes: PriceQuote[], q: Stay): Promise<PriceQuote[]> {
  const guests = q.adults + q.children_ages.length;
  const fx = quotes.some((p) => p.currency !== "INR") ? await deps.hotels.fx.rates().catch(() => null) : null;
  return quotes.map((p) => {
    const inr =
      p.currency === "INR" ? Math.round(p.per_night) : fx ? convertToInr(p.per_night, p.currency, fx) : null;
    const priced = { ...p, per_night_inr: inr };
    return { ...priced, ...occupancyLabel(priced, guests) };
  });
}
