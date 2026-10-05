import { z } from "zod";
import { AppError, upstreamText } from "../core/errors.js";
import { haversineKm } from "../core/geo.js";
import type { HotelCandidate, HotelSearchQuery } from "../core/types.js";
import { parseAmount, parseUpstream } from "./shared.js";
import type { HotelSearchProvider, ProviderInfo } from "./types.js";
import type { CallUpstream } from "./upstream-mcp.js";

export const TRIVAGO_URL = "https://mcp.trivago.com/mcp";
export const TRIVAGO_TOOLS = ["trivago-accommodation-radius-search"] as const;
export const TRIVAGO_TIMEOUT_MS = 15_000;

export const TRIVAGO_INFO: ProviderInfo = {
  id: "trivago",
  name: "trivago (official MCP server)",
  kind: "hotel-prices",
  official: true,
  needsKey: false,
  limitations: [
    "Shows only the cheapest advertiser per hotel (e.g. MakeMyTrip, Agoda, Booking.com).",
    "Returns about 25 hotels per search with no radius or sort control; results lean mid-range to premium.",
    "Prices are meta-search prices and may exclude taxes.",
  ],
};

const Accommodation = z.object({
  accommodation_id: z.string(),
  accommodation_name: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  currency: z.string(),
  price_per_night: z.string().nullish(),
  price_per_stay: z.string().nullish(),
  advertisers: z.string().nullish(),
  hotel_rating: z.number().nullish(),
  review_rating: z.string().nullish(),
  review_count: z.string().nullish(),
  accommodation_url: z.string().nullish(),
});

const Payload = z.union([
  z.object({ accommodations: z.array(Accommodation) }),
  z.object({
    validation_errors: z.array(z.object({ message: z.string(), argument: z.string().nullish() })),
  }),
]);

export function createTrivagoProvider(
  call: CallUpstream,
  now: () => Date = () => new Date(),
): HotelSearchProvider {
  return {
    info: TRIVAGO_INFO,
    async search(q: HotelSearchQuery): Promise<HotelCandidate[]> {
      const result = await call("trivago-accommodation-radius-search", {
        latitude: q.lat,
        longitude: q.lng,
        arrival: q.check_in,
        departure: q.check_out,
        adults: q.adults,
        rooms: 1,
        country: "IN",
        currency: "INR",
        language: "EN_IN",
      });
      const fetchedAt = now().toISOString();
      if (result.isError) {
        throw new AppError("UPSTREAM_UNAVAILABLE", "trivago reported an error for this search");
      }
      const payload = parseUpstream("trivago", Payload, result.structuredContent);
      if ("validation_errors" in payload) {
        // trivago reports bad input as data rather than isError.
        const msg = upstreamText(payload.validation_errors.map((e) => e.message).join("; "));
        throw new AppError("INVALID_INPUT", `trivago rejected the search: ${msg}`);
      }

      const nights = nightsBetween(q.check_in, q.check_out);
      return payload.accommodations
        .map((a): HotelCandidate => {
          const perNight = parseAmount(a.price_per_night);
          const total = parseAmount(a.price_per_stay);
          return {
            source: "trivago",
            source_id: a.accommodation_id,
            name: a.accommodation_name,
            lat: a.latitude,
            lng: a.longitude,
            stars: a.hotel_rating ? a.hotel_rating : null,
            rating_10: parseAmount(a.review_rating),
            review_count: parseAmount(a.review_count),
            url: a.accommodation_url ?? null,
            fetched_at: fetchedAt,
            prices:
              perNight === null && total === null
                ? []
                : [
                    {
                      source: "trivago",
                      seller: a.advertisers?.trim() || null,
                      per_night: perNight ?? (total as number) / nights,
                      total,
                      currency: a.currency,
                      per_night_inr: null,
                      includes_taxes: null,
                      available: null,
                      refundable: null,
                      url: a.accommodation_url ?? null,
                      fetched_at: fetchedAt,
                    },
                  ],
          };
        })
        .filter((h) => haversineKm(q, h) <= q.radius_km);
    },
  };
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const ms = Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86_400_000));
}
