import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AppError, toAppError } from "../core/errors.js";
import { searchPlaceName, type Anchor, type Gazetteer } from "../core/anchors.js";
import type { HotelMemory } from "../core/hotel-memory.js";
import { searchHotels, type HotelSearchDeps, type RankedHotel } from "../core/hotel-search.js";
import { effectivePrice, OCCUPANCY_LEVELS, OCCUPANCY_LEVELS_TEXT } from "../core/occupancy.js";
import { travelMatrix, type TravelDeps } from "../core/travel.js";
import type { PriceQuote } from "../core/types.js";
import { handle, readOnly } from "./common.js";
import { minRatingField, pctTo10 } from "./filters.js";
import { occupancyFields, occupancyNote, validateOccupancy } from "./occupancy.js";
import { AnchorOut, pointFields } from "./points.js";

/** Free-flow expressway speed, used only to decide how far to search for a drive-time limit. */
const KM_PER_DRIVE_MINUTE = 1.5;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

const PriceOut = z.object({
  per_night_inr: z
    .number()
    .nullable()
    .describe("Per-night price converted to INR (null if no exchange rate)."),
  per_night: z.number().describe("Per-night price in the source's original currency."),
  currency: z.string().describe("ISO currency code of per_night, e.g. INR or USD."),
  seller: z
    .string()
    .nullable()
    .describe("Booking site the price is from, e.g. Booking.com (null when the source does not name one)."),
  source: z.string().describe("Id of the data source that returned the price, e.g. trivago."),
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
  occupancy: z
    .enum(OCCUPANCY_LEVELS)
    .describe(`How far this price is known to be ONE room for the whole party: ${OCCUPANCY_LEVELS_TEXT}`),
  occupancy_note: z
    .string()
    .nullable()
    .describe("Why the occupancy level was given, when there is more to say."),
  fetched_at: z.string().describe("ISO time the source returned this price."),
});

const HotelOut = z.object({
  hotel_id: z.string().describe("Hotel id as source:source_id of the first source that listed it."),
  also_ids: z
    .array(z.string())
    .describe("Ids (source:source_id) of the same hotel at other sources; each resolves to this hotel."),
  name: z.string().describe("Hotel name as the first source gives it."),
  lat: z.number().describe("Hotel latitude."),
  lng: z.number().describe("Hotel longitude."),
  distance_km: z.number().describe("Straight-line distance from the search place, km."),
  stars: z.number().nullable().describe("Official hotel class, 1–5 stars (null if unknown)."),
  rating_10: z
    .number()
    .nullable()
    .describe("Guest review score on a 0–10 scale, from the source with the most reviews (null if unrated)."),
  review_count: z.number().nullable().describe("Number of guest reviews behind rating_10 (null if unknown)."),
  cheapest: PriceOut.nullable().describe(
    "Lowest available per-night price in INR across all sources (null when no source priced the hotel).",
  ),
  cheapest_single_room: PriceOut.nullable().describe(
    "Lowest price confirmed or likely to be one room for the party, given only when cheapest is unverified and differs.",
  ),
  two_rooms_left_out: PriceOut.nullable().describe(
    "Cheapest price left out because it was for two rooms (about double the same source's 2-adult price, see its occupancy_note), when it is cheaper than the price the hotel is ranked by (cheapest_single_room, else cheapest); null otherwise or with include_two_room_prices.",
  ),
  price_count: z.number().describe("Number of prices found across all sources and sellers."),
  sources: z.array(z.string()).describe("Ids of the sources that list this hotel."),
});

const outputSchema = {
  anchor: AnchorOut.describe("The resolved search place."),
  query: z
    .object({
      radius_km: z.number().describe("Radius searched, km; widened when max_drive_minutes needs it."),
      check_in: z.string().describe("Check-in date, YYYY-MM-DD."),
      check_out: z.string().describe("Check-out date, YYYY-MM-DD."),
      adults: z.number().describe("Adults in the one room searched for."),
      children_ages: z.array(z.number()).describe("Ages of children sharing that room."),
    })
    .describe("The search as run."),
  showing: z.string().describe("Which slice of the results this page holds, e.g. 'Showing 1–10 of 42'."),
  total: z.number().describe("Number of hotels matching all filters, across all pages."),
  hotels: z
    .array(
      HotelOut.extend({
        drive_minutes: z
          .number()
          .nullable()
          .describe(
            "Traffic-adjusted drive time from the search place, minutes (null without max_drive_minutes).",
          ),
      }),
    )
    .describe("This page of hotels, in the requested sort order."),
  sources_ok: z.array(z.string()).describe("Ids of the sources that answered."),
  sources_failed: z
    .array(
      z.object({
        source: z.string().describe("Id of the source that failed."),
        code: z.string().describe("Error code, e.g. UPSTREAM_UNAVAILABLE or RATE_LIMITED."),
        message: z.string().describe("What went wrong."),
      }),
    )
    .describe("Sources that did not answer, and why."),
  coverage: z
    .array(
      z.object({
        source: z.string().describe("Id of the source."),
        hotels: z.number().describe("Hotels the source returned within the radius."),
        priced: z.number().describe("How many of those hotels the source priced."),
        max_km: z
          .number()
          .nullable()
          .describe(
            "Distance of the source's furthest hotel from the search place, km (null if it returned none).",
          ),
        note: z.string().nullable().describe("What limited the source's results, e.g. pages fetched."),
      }),
    )
    .describe(
      "What each source returned within the radius and what limited it; sources return limited pages.",
    ),
  notes: z.array(z.string()).describe("Caveats about the results, sources and attribution."),
};

const priceOut = (p: PriceQuote): z.infer<typeof PriceOut> => ({
  per_night_inr: p.per_night_inr,
  per_night: p.per_night,
  currency: p.currency,
  seller: p.seller,
  source: p.source,
  includes_taxes: p.includes_taxes,
  available: p.available,
  refundable: p.refundable,
  url: p.url,
  room: p.room,
  occupancy: p.occupancy ?? "likely",
  occupancy_note: p.occupancy_note ?? null,
  fetched_at: p.fetched_at,
});

const hotelOut = (h: RankedHotel): z.infer<typeof HotelOut> => ({
  hotel_id: h.hotel_id,
  also_ids: h.also_ids,
  name: h.name,
  lat: h.lat,
  lng: h.lng,
  distance_km: h.distance_km,
  stars: h.stars,
  rating_10: h.rating_10,
  review_count: h.review_count,
  cheapest: h.cheapest ? priceOut(h.cheapest) : null,
  // Only when it differs: the cheapest price is unverified as one room for the party.
  cheapest_single_room:
    h.cheapest_single_room && h.cheapest_single_room !== h.cheapest ? priceOut(h.cheapest_single_room) : null,
  // Only when it would have looked like a better deal than what is shown.
  two_rooms_left_out:
    h.two_rooms_left_out &&
    (h.two_rooms_left_out.per_night_inr ?? Infinity) < (effectivePrice(h)?.per_night_inr ?? Infinity)
      ? priceOut(h.two_rooms_left_out)
      : null,
  price_count: h.prices.length,
  sources: h.sources,
});

export interface HotelToolDeps extends HotelSearchDeps {
  /** Default for min_rating_pct (DEFAULT_MIN_RATING_PCT). */
  defaultMinRatingPct: number;
  gazetteer: Gazetteer;
  travel: TravelDeps;
  memory: HotelMemory;
  now: () => Date;
}

export function registerHotelTools(server: McpServer, deps: HotelToolDeps): void {
  server.registerTool(
    "search_hotels",
    {
      title: "Search hotels near a place",
      description:
        "Finds hotels around a place in India for given dates, with live prices from several meta-search " +
        "sources merged per hotel. The place is one of: lat+lng, an Indian Railways station code, an airport " +
        "IATA code, or a place name. Returns each hotel's id, coordinates, straight-line distance, stars, " +
        "guest rating and cheapest current price in INR (with original currency, seller, source and, where the " +
        "source names it, the room type). Every search is for one room that fits the party; each price says " +
        "how far that is established (occupancy: confirmed, likely, unverified or two_rooms). For 3–4 guests, " +
        "trivago and Xotelo prices are compared with their own 2-adult prices; hotels priced only as two rooms " +
        "are left out unless include_two_room_prices is set. When the cheapest price is unverified, " +
        "cheapest_single_room gives the cheapest that is not. With " +
        "max_drive_minutes, keeps only hotels within that drive time (OpenStreetMap routing with a traffic " +
        "allowance) and adds drive_minutes. Results are paginated. Per-seller prices are in get_hotel_rates; " +
        "times to other places are in compare_hotels. coverage reports what each source returned and what limited it " +
        "(sources return limited pages, so the list is not exhaustive). Does not book.",
      inputSchema: {
        ...pointFields,
        radius_km: z.number().min(0.2).max(25).default(3).describe("Search radius in km."),
        check_in: isoDate.describe("Check-in date, YYYY-MM-DD (IST)."),
        check_out: isoDate.describe("Check-out date, YYYY-MM-DD, after check_in."),
        ...occupancyFields,
        max_price_inr: z
          .number()
          .positive()
          .optional()
          .describe("Only hotels with a known nightly price at or below this, in INR."),
        min_stars: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Minimum hotel class (official stars)."),
        min_rating_pct: minRatingField(deps.defaultMinRatingPct),
        include_unpriced: z
          .boolean()
          .default(false)
          .describe(
            "Also list hotels with no live price (OpenStreetMap listings), for places with thin price coverage.",
          ),
        include_two_room_prices: z
          .boolean()
          .default(false)
          .describe(
            "Also keep prices labelled two_rooms (3–4 guests priced about double the same source's 2-adult price).",
          ),
        max_drive_minutes: z
          .number()
          .int()
          .min(5)
          .max(180)
          .optional()
          .describe("Only hotels within this many minutes' drive of the place (traffic-adjusted)."),
        sort: z
          .enum(["distance", "price", "rating", "drive_time"])
          .default("distance")
          .describe("Sort order; drive_time needs max_drive_minutes."),
        limit: z.number().int().min(1).max(30).default(10).describe("Hotels per page."),
        offset: z.number().int().min(0).default(0).describe("Number of hotels to skip, for paging."),
      },
      outputSchema,
      annotations: readOnly("Search hotels near a place"),
    },
    handle(async (a) => {
      validateDates(a.check_in, a.check_out, deps.now());
      validateOccupancy(a.adults, a.children_ages);
      if (a.sort === "drive_time" && a.max_drive_minutes === undefined) {
        throw new AppError("INVALID_INPUT", "sort=drive_time needs max_drive_minutes.");
      }
      const anchor = await deps.gazetteer.resolvePoint(a);
      const placeName = searchPlaceName(anchor, deps.gazetteer);
      // A drive-time limit can reach further than the straight-line radius. Widen the search to the distance
      // a car covers at expressway speed (~90 km/h free-flow) in that time, capped at 25 km.
      const radius =
        a.max_drive_minutes === undefined
          ? a.radius_km
          : Math.max(a.radius_km, Math.min(25, a.max_drive_minutes * KM_PER_DRIVE_MINUTE));
      const query = {
        lat: anchor.lat,
        lng: anchor.lng,
        radius_km: radius,
        check_in: a.check_in,
        check_out: a.check_out,
        adults: a.adults,
        children_ages: a.children_ages,
        place: placeName?.name,
        place_is_area: placeName?.area,
        prefer: {
          sort: a.sort === "drive_time" ? ("distance" as const) : a.sort,
          min_stars: a.min_stars,
          max_price_inr: a.max_price_inr,
          min_rating_10: pctTo10(a.min_rating_pct),
        },
      };
      const r = await searchHotels(deps, query, {
        sort: a.sort === "drive_time" ? "distance" : a.sort,
        max_price_inr: a.max_price_inr,
        min_stars: a.min_stars,
        min_rating_10: pctTo10(a.min_rating_pct),
        include_unpriced: true,
        include_two_room_prices: a.include_two_room_prices,
      });
      const notes = [
        "Each source returns a limited set (see coverage), so this is not every hotel in the radius; hotels a source did not return are missing, not unavailable.",
        "distance_km is straight-line distance from the place.",
        "Prices are per night as listed by each source; meta-search prices may exclude GST (includes_taxes=null means unknown).",
        occupancyNote(a.adults, a.children_ages),
      ];

      const priceSourcesOk = r.sources_ok.some((id) => id !== "osm_lodging");
      let hotels = r.hotels;
      if (!priceSourcesOk) {
        if (r.sources_ok.length === 0) {
          throw new AppError(
            "UPSTREAM_UNAVAILABLE",
            `No hotel source answered: ${r.sources_failed.map((f) => `${f.source} (${f.message})`).join("; ")}`,
            "Try again shortly; get_data_sources shows each source's status.",
          );
        }
        // Every live-price source failed: fall back to map listings rather than failing the search.
        notes.push(
          "No live-price source answered, so hotels are listed without prices (see sources_failed).",
        );
      } else if (!a.include_unpriced) {
        hotels = r.hotels.filter((h) => h.cheapest !== null);
        const hidden = r.hotels.length - hotels.length;
        if (hidden > 0) {
          notes.push(
            `${hidden} more hotels nearby have no live price; set include_unpriced=true to list them.`,
          );
        }
      }
      deps.memory.remember(hotels, {
        check_in: a.check_in,
        check_out: a.check_out,
        adults: a.adults,
        children_ages: a.children_ages,
      });
      if (r.unrated_hidden > 0) {
        notes.push(
          `${r.unrated_hidden} hotels were left out by min_rating_pct because no source rates them.`,
        );
      }
      if (r.two_rooms_hidden > 0) {
        notes.push(
          `${r.two_rooms_hidden} hotels were left out because every price found was for two rooms (about double the same source's 2-adult price); set include_two_room_prices=true to list them.`,
        );
      }
      if (r.sources_ok.includes("osm_lodging")) {
        notes.push("Some locations © OpenStreetMap contributors (ODbL).");
      }
      if (r.fx) notes.push(`Non-INR prices converted at ${r.fx.source} reference rates of ${r.fx.date}.`);

      let ranked: (RankedHotel & { drive_minutes: number | null })[] = hotels.map((h) => ({
        ...h,
        drive_minutes: null,
      }));
      const sources_failed = [...r.sources_failed];
      if (a.max_drive_minutes !== undefined && ranked.length > 0) {
        const max = a.max_drive_minutes;
        try {
          const legs = await travelMatrix(
            deps.travel,
            [{ ...anchor }],
            ranked.map((h) => ({ ...h, label: h.hotel_id })),
            "drive",
          );
          const timed = ranked.map((h, i) => ({ ...h, drive_minutes: legs[0]![i]!.minutes }));
          const unroutable = timed.filter((h) => h.drive_minutes === null).length;
          ranked = timed.filter((h) => h.drive_minutes !== null && h.drive_minutes <= max);
          if (a.sort === "drive_time") ranked.sort((x, y) => x.drive_minutes! - y.drive_minutes!);
          notes.push(
            `drive_minutes: OpenStreetMap routing with a ×${legs[0]?.[0]?.traffic_multiplier ?? "?"} traffic allowance; no live traffic.`,
          );
          if (unroutable > 0)
            notes.push(`${unroutable} hotels were left out because no road route was found.`);
        } catch (err) {
          // Routing is down: keep the straight-line radius result instead of failing, and say so.
          const e = toAppError(err);
          sources_failed.push({ source: "osrm", code: e.code, message: e.message });
          ranked = ranked.filter((h) => h.distance_km <= a.radius_km);
          notes.push(
            `Drive times are unavailable, so max_drive_minutes was not applied; showing hotels within ${a.radius_km} km straight-line instead.`,
          );
        }
      }

      const page = ranked.slice(a.offset, a.offset + a.limit);
      return {
        anchor: { ...anchorOut(anchor) },
        query: {
          radius_km: radius,
          check_in: a.check_in,
          check_out: a.check_out,
          adults: a.adults,
          children_ages: a.children_ages,
        },
        showing:
          page.length === 0
            ? `No hotels (of ${ranked.length})`
            : `Showing ${a.offset + 1}–${a.offset + page.length} of ${ranked.length}`,
        total: ranked.length,
        hotels: page.map((h) => ({ ...hotelOut(h), drive_minutes: h.drive_minutes })),
        sources_ok: r.sources_ok,
        sources_failed,
        coverage: r.coverage,
        notes,
      };
    }),
  );
}

const anchorOut = (x: Anchor): z.infer<typeof AnchorOut> => ({
  kind: x.kind,
  name: x.name,
  code: x.code,
  context: x.context,
  lat: x.lat,
  lng: x.lng,
  source: x.source,
});

/** Dates are interpreted in IST, where the trip happens. */
export function validateDates(checkIn: string, checkOut: string, now: Date): void {
  const todayIst = new Date(now.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  if (Number.isNaN(Date.parse(checkIn)) || Number.isNaN(Date.parse(checkOut))) {
    throw new AppError("INVALID_INPUT", "check_in and check_out must be valid dates (YYYY-MM-DD).");
  }
  if (checkIn < todayIst) {
    throw new AppError(
      "INVALID_INPUT",
      `check_in ${checkIn} is in the past (today in India is ${todayIst}).`,
    );
  }
  if (checkOut <= checkIn) {
    throw new AppError("INVALID_INPUT", "check_out must be after check_in.");
  }
  const nights = (Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000;
  if (nights > 30) throw new AppError("INVALID_INPUT", "Stays longer than 30 nights are not supported.");
}
