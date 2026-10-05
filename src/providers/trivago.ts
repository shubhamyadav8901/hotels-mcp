import { z } from "zod";
import { AppError, upstreamText } from "../core/errors.js";
import { coverPoints, haversineKm } from "../core/geo.js";
import type { HotelCandidate, HotelSearchQuery } from "../core/types.js";
import { parseAmount, parseUpstream } from "./shared.js";
import type { HotelSearchProvider, ProviderInfo, SearchOutcome } from "./types.js";
import type { CallUpstream } from "./upstream-mcp.js";

export const TRIVAGO_URL = "https://mcp.trivago.com/mcp";
// Read-only search tools only; trivago offers nothing else we call.
export const TRIVAGO_TOOLS = ["trivago-accommodation-radius-search", "trivago-accommodation-search"] as const;
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
  top_amenities: z.string().nullish(),
  distance: z.string().nullish(),
});

const Payload = z.union([
  z.object({ accommodations: z.array(Accommodation) }),
  z.object({
    validation_errors: z.array(z.object({ message: z.string(), argument: z.string().nullish() })),
  }),
]);

export interface TrivagoProvider extends HotelSearchProvider {
  /**
   * Looks one known hotel up by name (trivago's text search) and returns it only if trivago's answer is that
   * same accommodation id: the text search returns its single best match, which may be another hotel.
   */
  lookup(
    id: string,
    name: string,
    context: string | undefined,
    q: Omit<HotelSearchQuery, "lat" | "lng" | "radius_km">,
  ): Promise<HotelCandidate | null>;
}

export function createTrivagoProvider(
  call: CallUpstream,
  now: () => Date = () => new Date(),
  /** Each grid point's own time limit, so slow points are dropped instead of failing the whole search. */
  pointBudgetMs = 14_000,
): TrivagoProvider {
  const occupancy = (q: Pick<HotelSearchQuery, "check_in" | "check_out" | "adults" | "children_ages">) => ({
    arrival: q.check_in,
    departure: q.check_out,
    adults: q.adults,
    rooms: 1,
    ...(q.children_ages?.length
      ? { children: q.children_ages.length, children_ages: q.children_ages.join("-") }
      : {}),
    country: "IN",
    currency: "INR",
    language: "EN_IN",
  });

  async function accommodations(tool: (typeof TRIVAGO_TOOLS)[number], args: Record<string, unknown>) {
    const result = await call(tool, args);
    if (result.isError) {
      throw new AppError("UPSTREAM_UNAVAILABLE", "trivago reported an error for this search");
    }
    const payload = parseUpstream("trivago", Payload, result.structuredContent);
    if ("validation_errors" in payload) {
      // trivago reports bad input as data rather than isError.
      const msg = upstreamText(payload.validation_errors.map((e) => e.message).join("; "));
      throw new AppError("INVALID_INPUT", `trivago rejected the search: ${msg}`);
    }
    return payload.accommodations;
  }

  function toCandidates(
    list: z.infer<typeof Accommodation>[],
    q: Pick<HotelSearchQuery, "check_in" | "check_out">,
  ) {
    const fetchedAt = now().toISOString();
    const nights = nightsBetween(q.check_in, q.check_out);
    return list.map((a): HotelCandidate => {
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
        ...details(a),
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
                  room: null,
                  fetched_at: fetchedAt,
                },
              ],
      };
    });
  }

  const lookup: TrivagoProvider["lookup"] = async (id, name, context, q) => {
    const list = await accommodations("trivago-accommodation-search", {
      query: context ? `${name}, ${context}` : name,
      ...occupancy(q),
    });
    return toCandidates(list, q).find((h) => h.source_id === id) ?? null;
  };

  function withBudget<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new AppError("TIMEOUT", `trivago point did not answer within ${ms / 1000} s`)),
        ms,
      );
    });
    return Promise.race([work, limit]).finally(() => clearTimeout(timer));
  }

  async function searchAround(
    p: { lat: number; lng: number },
    q: HotelSearchQuery,
  ): Promise<HotelCandidate[]> {
    const list = await accommodations("trivago-accommodation-radius-search", {
      latitude: p.lat,
      longitude: p.lng,
      ...occupancy(q),
      ...(q.prefer?.min_stars
        ? {
            hotel_rating: Object.fromEntries(
              [1, 2, 3, 4, 5].filter((n) => n >= q.prefer!.min_stars!).map((n) => [`${n}star`, true]),
            ),
          }
        : {}),
    });
    return toCandidates(list, q);
  }

  async function searchWithCoverage(q: HotelSearchQuery): Promise<SearchOutcome> {
    // trivago returns ~25 hotels around one point with no radius control, so a wider circle is covered by
    // searching several points across it in parallel and keeping the hotels inside the circle.
    const points = coverPoints(q, q.radius_km);
    const results = await Promise.allSettled(
      points.map((p) => withBudget(searchAround(p, q), pointBudgetMs)),
    );
    const ok = results.filter((r): r is PromiseFulfilledResult<HotelCandidate[]> => r.status === "fulfilled");
    if (ok.length === 0) throw (results[0] as PromiseRejectedResult).reason;
    const byId = new Map<string, HotelCandidate>();
    for (const r of ok) for (const h of r.value) if (!byId.has(h.source_id)) byId.set(h.source_id, h);
    const hotels = [...byId.values()].filter((h) => haversineKm(q, h) <= q.radius_km);
    const pts = points.length === 1 ? "1 point" : `${ok.length} of ${points.length} points across the radius`;
    return {
      hotels,
      coverage_note: `about 25 hotels per point searched (trivago has no radius control); searched ${pts}`,
    };
  }

  return {
    info: TRIVAGO_INFO,
    search: async (q: HotelSearchQuery) => (await searchWithCoverage(q)).hotels,
    searchWithCoverage,
    lookup,
  };
}

/** Amenities and area, only when trivago states them. */
function details(a: z.infer<typeof Accommodation>): Pick<HotelCandidate, "amenities" | "area"> {
  const amenities = (a.top_amenities ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  // `distance` reads like "Kochi, 6.0 km to City centre": the area is the part before the first comma.
  const area = a.distance?.match(/^([^,]+),\s*[\d.]+\s*km\b/)?.[1]?.trim();
  return { ...(amenities.length ? { amenities } : {}), ...(area ? { area } : {}) };
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const ms = Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86_400_000));
}
