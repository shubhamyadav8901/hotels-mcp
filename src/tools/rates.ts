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
  CHEAPEST_OFFER_ONLY,
  cheapestOneRoom,
  rankPrice,
  FIT_BASES,
  FIT_BASIS_TEXT,
  RATIO_MAX_GUESTS,
  roomCapacity,
  roomFit,
  ROOM_FIT_TEXT,
  ROOM_FITS,
  ROOM_STATUS_TEXT,
  ROOM_STATUSES,
  roomStatus,
} from "../core/occupancy.js";
import type { PriceQuote } from "../core/types.js";
import { convertToInr } from "../providers/fx.js";
import type { SerpApi } from "../providers/serpapi.js";
import type { TrivagoProvider } from "../providers/trivago.js";
import type { Xotelo } from "../providers/xotelo.js";
import { handle, readOnly } from "./common.js";
import { occupancyFields, occupancyNote, validateOccupancy } from "./occupancy.js";
import { validateDates } from "./hotels.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

/** Most room-list offers returned; Google's list for one hotel is usually far shorter. */
const ROOM_LIST_MAX = 60;

const RoomOfferOut = z.object({
  seller: z.string().describe("Booking site offering the room, e.g. Booking.com or Agoda."),
  room: z.string().describe("Room name as the booking site lists it on Google."),
  guests: z
    .number()
    .nullable()
    .describe(
      "Guests the site states this rate is for (Booking.com and Agoda state it); null when the site does not state it, and then the price is for the 2 adults the list was fetched for.",
    ),
  per_night_inr: z
    .number()
    .nullable()
    .describe("Per-night price in INR as Google lists it (null when Google gave it in another currency)."),
  url: z.string().nullable().describe("Link to the offer on the booking site (null if Google gives none)."),
});
type RoomOffer = z.infer<typeof RoomOfferOut>;

const QuoteOut = z.object({
  seller: z
    .string()
    .describe("Booking site the price is from; the source id when the source names no seller."),
  source: z.string().describe("Id of the data source that returned the price, e.g. trivago."),
  per_night_inr: z
    .number()
    .nullable()
    .describe("Per-night price converted to INR (null if no exchange rate)."),
  per_night: z.number().describe("Per-night price in the source's original currency."),
  currency: z.string().describe("ISO currency code of per_night and total, e.g. INR or USD."),
  total: z
    .number()
    .nullable()
    .describe("Price for the whole stay in the original currency (null when the source does not give it)."),
  includes_taxes: z
    .boolean()
    .nullable()
    .describe("Whether the price includes taxes such as GST (null when the source does not say)."),
  available: z
    .boolean()
    .nullable()
    .describe("Whether the source reports the room as bookable for these dates (null when it does not say)."),
  refundable: z
    .boolean()
    .nullable()
    .describe("Whether the rate is refundable (null when the source does not say)."),
  url: z.string().nullable().describe("Link to the offer or hotel page at the source, when given."),
  room: z.string().nullable().describe("Room type as the source names it (null when it does not say)."),
  room_guests: z
    .number()
    .nullable()
    .describe(
      "Guests the booking site states this rate is for (Booking.com and Agoda in Google's room list); null otherwise.",
    ),
  fit: z.enum(ROOM_FITS).describe(`Whether this price is ONE room for the whole party: ${ROOM_FIT_TEXT}`),
  fit_basis: z.enum(FIT_BASES).describe(FIT_BASIS_TEXT),
  fit_note: z
    .string()
    .nullable()
    .describe("The evidence behind fit in words (room name, ratio, what is unknown)."),
  fetched_at: z.string().describe("ISO time the source returned this price."),
});

export interface RatesToolDeps {
  hotels: HotelSearchDeps;
  gazetteer: Gazetteer;
  xotelo: Pick<Xotelo, "rates" | "info">;
  trivago: Pick<TrivagoProvider, "lookup" | "info">;
  /** Google's room list for one hotel; null without SerpApi. */
  serp: Pick<SerpApi, "rooms" | "info"> | null;
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
        "Fetches current prices for one hotel from every source for the given dates and lists them per " +
        "booking site (e.g. Booking.com, Agoda, Trip.com, MakeMyTrip, the hotel's own site), cheapest first, in " +
        "INR with the original currency, tax status, availability, links and, where the source names it, the " +
        'room type (e.g. "Family Room with 2 Double Beds"). The hotel is a hotel_id from ' +
        "search_hotels or plan_stays, or a name with lat/lng. Each price has fit (one_room, two_rooms or unknown) " +
        "with its evidence, and the hotel a room_status; verify_room gathers more room evidence. Does not book.",
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
        verify_room: z
          .boolean()
          .default(false)
          .describe(
            "For 3+ guests, gather room evidence: Google's room list for this hotel (1 SerpApi search from a " +
              "monthly quota, when enabled), where Booking.com and Agoda state each rate's guests, so rooms for " +
              "the party are found with prices and multi-room combos are named; and, for 3–4 guests, trivago's " +
              "and Xotelo's 2-adult prices from the same booking sites, from which their prices' fit is re-labelled.",
          ),
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
        prices: z
          .array(QuoteOut)
          .describe(
            "One entry per offer (per source and seller; with verify_room, also each relevant room from Google's room list), cheapest per_night_inr first (unconverted prices last).",
          ),
        room_list: z
          .array(RoomOfferOut)
          .nullable()
          .describe(
            `Every room offer on Google's page for this hotel (fetched for 2 adults; 1 SerpApi search), sorted by seller then per_night_inr, for judging rooms the fit rules don't recognise; at most ${ROOM_LIST_MAX} entries (notes say when more were cut); null when verify_room did not fetch it.`,
          ),
        room_status: z
          .enum(ROOM_STATUSES)
          .describe(`What the prices show about one room for the party: ${ROOM_STATUS_TEXT}`),
        cheapest_one_room_inr: z
          .number()
          .nullable()
          .describe("Lowest per_night_inr among prices that are one room for the party (null if none)."),
        cheapest_inr: z
          .number()
          .nullable()
          .describe(
            "Lowest per_night_inr among prices for the whole party, of any fit (null if none in INR).",
          ),
        priciest_inr: z
          .number()
          .nullable()
          .describe("Highest per_night_inr among prices (null if none in INR)."),
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
          .describe(
            "Sources or lookups that did not answer, and why; verify_room:<source> marks a failed verification lookup.",
          ),
        notes: z.array(z.string()).describe("Caveats about the prices and the room evidence."),
      },
      annotations: readOnly("Compare a hotel's prices across sites"),
    },
    handle(async (a) => {
      // Per request: exchange-rate failures in direct lookups are reported, not swallowed.
      const fxErrors: AppError[] = [];
      const rq: RatesToolDeps = { ...deps, onFxError: (e) => fxErrors.push(e) };
      validateDates(a.check_in, a.check_out, rq.now());
      validateOccupancy(a.adults, a.children_ages);
      const guests = a.adults + a.children_ages.length;
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
      const xoId = startIds.find((id) => id.startsWith("xotelo:"));
      const wantsBaseline = a.verify_room && guests > 2 && guests <= RATIO_MAX_GUESTS;
      // Party lookups start early only for sources the earlier search had no price from (the re-search
      // usually returns the others); otherwise they run afterwards, and only if needed.
      const hadPrice = (src: string) => remembered?.hotel.prices.some((p) => p.source === src) ?? false;
      const tvParty =
        tvId && !hadPrice("trivago") ? settle(trivagoQuotes(rq, tvId, target.name, partyQ)) : undefined;
      const xoParty = xoId && !hadPrice("xotelo") ? settle(xoteloQuotes(rq, xoId, partyQ)) : undefined;
      const tvBase =
        wantsBaseline && tvId
          ? settle(trivagoQuotes(rq, tvId, target.name, { ...partyQ, adults: 2, children_ages: [] }))
          : undefined;
      const xoBase =
        wantsBaseline && xoId
          ? settle(xoteloQuotes(rq, xoId, { ...partyQ, adults: 2, children_ages: [] }))
          : undefined;

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
        // Every price is shown here, two-room ones labelled.
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
          rank_price: rankPrice(h.prices),
          room_status: roomStatus(h.prices),
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
                  ? trivagoQuotes(rq, id, target.name, partyQ)
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
        ...lookupNotes,
        occupancyNote(a.adults, a.children_ages),
        "Meta-search prices can differ at checkout; includes_taxes=null means the source does not say whether GST is included.",
      ];
      let room_list: RoomOffer[] | null = null;
      if (a.verify_room && guests > 2) {
        const failures: SourceFailure[] = [];
        // Google's room list, fetched for 2 adults (the fullest list): Booking.com and Agoda state each rate's
        // guests, so a room for the party is found with its price, and multi-room combos are named.
        const token = [withIds.hotel_id, ...withIds.also_ids]
          .find((id) => id.startsWith("serpapi:"))
          ?.slice("serpapi:".length);
        const serp = rq.serp;
        if (!serp || !rq.hotels.registry.isEnabled(serp.info.id)) {
          notes.push(
            "verify_room: Google's room list needs SerpApi (SERPAPI_KEY with ENABLE_UNOFFICIAL_SOURCES), so only 2-adult price comparisons were made.",
          );
        } else if (!token) {
          notes.push(
            "verify_room: Google Hotels does not list this hotel, so its room list was not fetched.",
          );
        } else {
          try {
            const offers = await rq.hotels.registry.run(
              serp.info.id,
              () =>
                serp.rooms(token, {
                  check_in: a.check_in,
                  check_out: a.check_out,
                  adults: 2,
                  hotel_name: target.name,
                }),
              rq.hotels.deadlineMs,
            );
            const fetchedAt = rq.now().toISOString();
            const allRooms = offers
              .map((o): RoomOffer => ({
                seller: o.seller,
                room: o.room,
                guests: o.guests,
                per_night_inr: o.currency === "INR" ? Math.round(o.per_night) : null,
                url: o.url,
              }))
              .sort(
                (x, y) =>
                  x.seller.localeCompare(y.seller) ||
                  // Prices not in INR last; Infinity - Infinity would be NaN.
                  (x.per_night_inr ?? Number.MAX_VALUE) - (y.per_night_inr ?? Number.MAX_VALUE),
              );
            room_list = allRooms.slice(0, ROOM_LIST_MAX);
            if (allRooms.length > ROOM_LIST_MAX)
              notes.push(
                `verify_room: room_list shows the first ${ROOM_LIST_MAX} of Google's ${allRooms.length} room offers (by seller, then price).`,
              );
            const fromRooms = offers
              .map((o): PriceQuote => {
                const q: PriceQuote = {
                  source: "serpapi",
                  seller: o.seller,
                  per_night: o.per_night,
                  total: null,
                  currency: o.currency,
                  per_night_inr: o.currency === "INR" ? Math.round(o.per_night) : null,
                  includes_taxes: null,
                  available: null,
                  refundable: null,
                  url: o.url,
                  room: o.room,
                  room_guests: o.guests,
                  // Sites that don't state guests quote the list's 2 adults.
                  ...(o.guests === null ? { priced_for_guests: 2 } : {}),
                  fetched_at: fetchedAt,
                };
                return { ...q, ...roomFit(q, guests) };
              })
              // Keep the evidence about this party: rooms that fit it, rooms named as several, and named
              // rooms that sleep it but were priced for 2. Rates for fewer guests say nothing.
              .filter(
                (q) =>
                  q.fit !== "unknown" ||
                  (q.fit_basis === "room_name" && q.room !== null && (roomCapacity(q.room) ?? 0) >= guests),
              );
            prices.push(...fromRooms);
            const left =
              rq.hotels.registry.status().find((x) => x.id === serp.info.id)?.quota_remaining ?? null;
            notes.push(
              offers.length === 0
                ? "verify_room: Google listed no rooms for this hotel on these dates."
                : `verify_room: Google's room list had ${offers.length} offers; ${fromRooms.length} say something about one room for ${guests} (added as source serpapi, seller = booking site); the rest are rates for fewer guests or unnamed rooms.`,
              ...(left !== null
                ? [
                    `SerpApi searches left this month as counted since this server started (the SerpApi dashboard has the account's real count): ${left}.`,
                  ]
                : []),
            );
          } catch (err) {
            const e = toAppError(err);
            failures.push({ source: serp.info.id, code: e.code, message: e.message });
          }
        }

        // trivago and Xotelo name no room: compare each price with the same booking site's 2-adult price.
        const baseline = new Map<string, { inr: number; taxStated: boolean }>();
        for (const [source, pending] of [
          ["trivago", tvBase],
          ["xotelo", xoBase],
        ] as const) {
          if (!pending) continue;
          const res = await pending;
          if ("error" in res) failures.push({ source, code: res.error.code, message: res.error.message });
          else if (res.value.length === 0)
            notes.push(`verify_room: ${source} did not return a 2-adult price for this hotel.`);
          else
            for (const q of res.value)
              if (q.per_night_inr !== null)
                baseline.set(baselineKey(source, q.seller), {
                  inr: q.per_night_inr,
                  taxStated: q.includes_taxes !== null,
                });
        }
        // Only sources whose id wasn't known up front (rare) get a 2-adult re-search near the hotel; a
        // preloaded lookup that failed or found nothing is final (no second, slower attempt).
        const preloaded = new Set([...(tvBase ? ["trivago"] : []), ...(xoBase ? ["xotelo"] : [])]);
        const missing = new Set(
          prices.map((p) => p.source).filter((src) => CHEAPEST_OFFER_ONLY.has(src) && !preloaded.has(src)),
        );
        if (missing.size && guests <= RATIO_MAX_GUESTS) {
          try {
            const more = await twoAdultPrices(
              rq,
              { ...withIds, name: target.name },
              a.check_in,
              a.check_out,
              missing,
            );
            for (const [k, v] of more.prices) baseline.set(k, v);
            failures.push(...more.failures);
          } catch (err) {
            const e = toAppError(err);
            failures.push({ source: "two_adult_search", code: e.code, message: e.message });
          }
        }
        const notInr = prices.filter((p) => CHEAPEST_OFFER_ONLY.has(p.source) && p.currency !== "INR").length;
        if (notInr > 0)
          notes.push(
            `verify_room: ${notInr} trivago/Xotelo prices are not in INR, so they were not compared.`,
          );
        for (let i = 0; i < prices.length; i++) {
          const p = prices[i]!;
          if (!CHEAPEST_OFFER_ONLY.has(p.source) || p.currency !== "INR") continue;
          const base = baseline.get(baselineKey(p.source, p.seller));
          // A price that states tax against one that doesn't could be off by GST (12–18%). Without a usable
          // new baseline, keep the one the search attached.
          const sameBasis = base && base.taxStated === (p.includes_taxes !== null);
          const withBase = {
            ...p,
            two_adult_per_night: sameBasis ? base.inr : (p.two_adult_per_night ?? null),
          };
          prices[i] = { ...withBase, ...roomFit(withBase, guests) };
        }
        for (const f of failures) sources_failed.push({ ...f, source: `verify_room:${f.source}` });
      }

      if (fxErrors[0])
        sources_failed.push({ source: "fx", code: fxErrors[0].code, message: fxErrors[0].message });
      const unconverted = prices.filter((p) => p.per_night_inr === null && p.currency !== "INR").length;
      if (unconverted > 0) {
        notes.push(
          `${unconverted} prices could not be converted to INR (no exchange rate); they are listed last.`,
        );
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
          room_guests: p.room_guests ?? null,
          fit: p.fit ?? "unknown",
          fit_basis: p.fit_basis ?? "none",
          fit_note: p.fit_note ?? null,
          fetched_at: p.fetched_at,
        }))
        .sort((x, y) => (x.per_night_inr ?? Infinity) - (y.per_night_inr ?? Infinity));
      // Room-list prices quoted for fewer guests than the party are evidence, not the party's price.
      const inr = prices
        .filter((p) => p.priced_for_guests === undefined || p.priced_for_guests >= guests)
        .map((p) => p.per_night_inr)
        .filter((v): v is number => v !== null);

      // Re-remembering the search's own prices would only extend how long stale prices are served.
      if (!fromSearch) {
        rq.memory.remember([match], {
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
        room_list,
        room_status: roomStatus(prices),
        cheapest_one_room_inr: cheapestOneRoom(prices)?.per_night_inr ?? null,
        cheapest_inr: inr.length ? Math.min(...inr) : null,
        priciest_inr: inr.length ? Math.max(...inr) : null,
        sources_ok: r.sources_ok,
        sources_failed,
        notes,
      };
    }),
  );
}

/** 2-adult prices are compared per source and booking site: trivago's cheapest site can change with the party. */
function baselineKey(source: string, seller: string | null): string {
  return `${source}|${seller ?? ""}`;
}

/** Each seller's 2-adult, one-room price for this hotel, from the given sources only ("source|seller" → INR). */
async function twoAdultPrices(
  deps: RatesToolDeps,
  hotel: RankedHotel,
  checkIn: string,
  checkOut: string,
  sources: Set<string>,
): Promise<{ prices: Map<string, { inr: number; taxStated: boolean }>; failures: SourceFailure[] }> {
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
  const prices = new Map<string, { inr: number; taxStated: boolean }>();
  const add = (p: PriceQuote) => {
    if (p.per_night_inr !== null)
      prices.set(baselineKey(p.source, p.seller), {
        inr: p.per_night_inr,
        taxStated: p.includes_taxes !== null,
      });
  };
  // searchHotels has already converted these to INR.
  (same?.prices ?? []).forEach(add);
  const has = (source: string) => [...prices.keys()].some((k) => k.startsWith(`${source}|`));
  // trivago's area search can leave the hotel out; look it up by name. A failure keeps the other baselines.
  if (sources.has("trivago") && !has("trivago")) {
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
      live.forEach(add);
    } catch (err) {
      const e = toAppError(err);
      failures.push({ source: deps.trivago.info.id, code: e.code, message: e.message });
    }
  }
  // Xotelo prices only the nearest hotels in a search; ask for this one directly if needed. A failure here
  // keeps the other sources' baselines.
  const xoteloId = [hotel.hotel_id, ...hotel.also_ids].find((id) => id.startsWith("xotelo:"));
  if (sources.has("xotelo") && xoteloId && !has("xotelo")) {
    try {
      const live = await xoteloQuotes(deps, xoteloId, {
        check_in: checkIn,
        check_out: checkOut,
        adults: 2,
        children_ages: [],
      });
      live.forEach(add);
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

/** INR conversion (non-INR converted, not dropped) and room-fit labels for directly fetched quotes. */
async function labelled(deps: RatesToolDeps, quotes: PriceQuote[], q: Stay): Promise<PriceQuote[]> {
  const guests = q.adults + q.children_ages.length;
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
    const priced = { ...p, per_night_inr: inr };
    return { ...priced, ...roomFit(priced, guests) };
  });
}
