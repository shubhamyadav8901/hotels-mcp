import { z } from "zod";
import { AppError } from "../core/errors.js";
import type { HotelCandidate, HotelSearchQuery } from "../core/types.js";
import { parseUpstream } from "./shared.js";
import type { HotelSearchProvider, ProviderInfo } from "./types.js";
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
});

const Payload = z.object({
  availability_checked: z.boolean().nullish(),
  items: z.array(Item),
  next_page: z.number().nullish(),
});

export function createHotelsCasaProvider(
  call: CallUpstream,
  opts: { maxPages?: number; now?: () => Date } = {},
): HotelSearchProvider {
  const { maxPages = 2, now = () => new Date() } = opts;
  return {
    info: HOTELSCASA_INFO,
    async search(q: HotelSearchQuery): Promise<HotelCandidate[]> {
      const out: HotelCandidate[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const result = await call("search_hotels", {
          lat: q.lat,
          lng: q.lng,
          radius_km: Math.min(q.radius_km, MAX_RADIUS_KM),
          check_in: q.check_in,
          check_out: q.check_out,
          adults: q.adults,
          lang: "en",
          sort: "recommended",
          limit: PAGE_SIZE,
          page,
        });
        if (result.isError) {
          throw new AppError("UPSTREAM_UNAVAILABLE", "HotelsCasa reported an error for this search");
        }
        const payload = parseUpstream("hotelscasa", Payload, result.structuredContent);
        const fetchedAt = now().toISOString();
        const live = payload.availability_checked === true;
        for (const it of payload.items) out.push(toCandidate(it, live, fetchedAt));
        if (!payload.next_page || payload.items.length < PAGE_SIZE) break;
      }
      return out;
    },
  };
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
              fetched_at: fetchedAt,
            },
          ],
  };
}
