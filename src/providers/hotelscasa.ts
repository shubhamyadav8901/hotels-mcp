import { z } from "zod";
import { AppError } from "../core/errors.js";
import type { HotelCandidate, HotelSearchQuery } from "../core/types.js";
import { parseUpstream } from "./shared.js";
import type { HotelSearchProvider, ProviderInfo, SearchOutcome } from "./types.js";
import type { CallUpstream } from "./upstream-mcp.js";

export const HOTELSCASA_URL = "https://mcp.hotelscasa.com/mcp";
export const HOTELSCASA_TOOLS = ["search_hotels", "get_hotel"] as const;
export const HOTELSCASA_TIMEOUT_MS = 10_000;
const MAX_RADIUS_KM = 50;
const PAGE_SIZE = 10;

export const HOTELSCASA_INFO: ProviderInfo = {
  id: "hotelscasa",
  name: "HotelsCasa (vendor's own MCP server)",
  kind: "hotel-prices",
  // First-party endpoint the vendor publishes for AI agents (not a scraper or reverse-engineered API).
  official: true,
  needsKey: false,
  limitations: [
    "Small third-party vendor with no SLA.",
    "Prices are in EUR only (converted to INR here); availability is checked live for the dates.",
    "Strongest in budget and mid-range hotels.",
  ],
};

const Item = z.object({
  hotel_key: z.string(),
  name: z.string(),
  type: z.string().nullish(),
  lat: z.number(),
  lng: z.number(),
  stars: z.number().nullish(),
  rating_10: z.number().nullish(),
  reviews_count: z.number().nullish(),
  price_eur_per_night: z.number().nullish(),
  price_total_eur: z.number().nullish(),
  currency: z.string().nullish(),
  available: z.boolean().nullish(),
  refundable: z.boolean().nullish(),
  url: z.string().nullish(),
  room_name: z.string().nullish(),
  board: z.string().nullish(),
});

const Payload = z.object({
  availability_checked: z.boolean().nullish(),
  items: z.array(Item),
  next_page: z.number().nullish(),
});

export function createHotelsCasaProvider(
  call: CallUpstream,
  opts: { maxPages?: number; widePages?: number; now?: () => Date } = {},
): HotelSearchProvider {
  // Up to 10 hotels per page and at most 5 pages; wide searches (over 3 km) fetch more pages.
  const { maxPages = 2, widePages = 5, now = () => new Date() } = opts;

  async function page(q: HotelSearchQuery, n: number) {
    const result = await call("search_hotels", {
      lat: q.lat,
      lng: q.lng,
      radius_km: Math.min(q.radius_km, MAX_RADIUS_KM),
      check_in: q.check_in,
      check_out: q.check_out,
      adults: q.adults,
      ...(q.children_ages?.length
        ? { children: q.children_ages.length, children_ages: q.children_ages.join(",") }
        : {}),
      ...(q.prefer?.min_stars ? { stars_min: q.prefer.min_stars } : {}),
      lang: "en",
      sort: q.prefer?.sort === "price" ? "price" : q.prefer?.sort === "rating" ? "rating" : "recommended",
      limit: PAGE_SIZE,
      page: n,
    });
    if (result.isError) {
      throw new AppError("UPSTREAM_UNAVAILABLE", "HotelsCasa reported an error for this search");
    }
    const payload = parseUpstream("hotelscasa", Payload, result.structuredContent);
    const fetchedAt = now().toISOString();
    const live = payload.availability_checked === true;
    return {
      hotels: payload.items.map((it) => toCandidate(it, live, fetchedAt)),
      more: Boolean(payload.next_page) && payload.items.length >= PAGE_SIZE,
    };
  }

  async function searchWithCoverage(q: HotelSearchQuery): Promise<SearchOutcome> {
    const pages = q.radius_km > 3 ? widePages : maxPages;
    // Page 1 says whether there are more; the rest are fetched together.
    const first = await page(q, 1);
    // A later page failing keeps the pages that answered.
    const rest =
      first.more && pages > 1
        ? await Promise.allSettled(Array.from({ length: pages - 1 }, (_, i) => page(q, i + 2)))
        : [];
    const hotels = [...first.hotels];
    let fetched = 1;
    let missing = 0;
    let lastMore = first.more;
    for (const r of rest) {
      if (r.status === "rejected") {
        missing++;
        continue;
      }
      hotels.push(...r.value.hotels);
      fetched++;
      lastMore = r.value.more;
      if (!r.value.more) break;
    }
    const order =
      q.prefer?.sort === "price"
        ? "cheapest first"
        : q.prefer?.sort === "rating"
          ? "best rated first"
          : "its own ranking";
    const capped = fetched === pages && lastMore;
    return {
      hotels,
      coverage_note: `${fetched} page${fetched > 1 ? "s" : ""} of up to ${PAGE_SIZE} (${order})${capped ? `; more exist beyond ${pages * PAGE_SIZE}` : ""}${missing ? `; ${missing} page${missing > 1 ? "s" : ""} failed` : ""}`,
    };
  }

  return {
    info: HOTELSCASA_INFO,
    search: async (q) => (await searchWithCoverage(q)).hotels,
    searchWithCoverage,
  };
}

// HotelsCasa is a Spanish site: most types come in English ("Hotel", "Apartment"), but some categories leak
// through in Spanish (live, Kochi 2026-10-06: "Posadas").
const SPANISH_TYPES: Record<string, string> = {
  hoteles: "Hotel",
  posadas: "Inn",
  hostales: "Hostel",
  albergues: "Hostel",
  apartamentos: "Apartment",
  "casas de huéspedes": "Guest house",
  pensiones: "Guest house",
  villas: "Villa",
  "casas rurales": "Country house",
  moteles: "Motel",
  campings: "Campsite",
};

export function propertyType(type: string): string {
  return SPANISH_TYPES[type.trim().toLowerCase()] ?? type;
}

function toCandidate(it: z.infer<typeof Item>, live: boolean, fetchedAt: string): HotelCandidate {
  // Only prices checked live for the dates count; `price_from_eur_per_night` alone is an indicative "from" price.
  const perNight = live ? (it.price_eur_per_night ?? null) : null;
  return {
    source: "hotelscasa",
    source_id: it.hotel_key,
    name: it.name,
    lat: it.lat,
    lng: it.lng,
    stars: it.stars ? it.stars : null,
    rating_10: it.rating_10 ?? null,
    review_count: it.reviews_count ?? null,
    url: it.url ?? null,
    fetched_at: fetchedAt,
    ...(it.type ? { property_type: propertyType(it.type) } : {}),
    prices:
      perNight === null
        ? []
        : [
            {
              source: "hotelscasa",
              seller: null,
              per_night: perNight,
              total: it.price_total_eur ?? null,
              currency: it.currency ?? "EUR",
              per_night_inr: null,
              // HotelsCasa's price note states "Taxes and fees included" for live-checked prices.
              includes_taxes: true,
              available: it.available ?? null,
              refundable: it.refundable ?? null,
              url: it.url ?? null,
              room: it.room_name || null,
              ...(it.board ? { meal_plan: it.board } : {}),
              fetched_at: fetchedAt,
            },
          ],
  };
}
