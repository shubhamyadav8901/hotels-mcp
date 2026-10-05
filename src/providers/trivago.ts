import { z } from "zod";
import { AppError, upstreamText } from "../core/errors.js";
import { coverPoints, haversineKm } from "../core/geo.js";
import { RATIO_MAX_GUESTS } from "../core/occupancy.js";
import type { HotelCandidate, HotelSearchQuery } from "../core/types.js";
import { parseAmount, parseUpstream } from "./shared.js";
import type { HotelSearchProvider, ProviderInfo, SearchOutcome } from "./types.js";
import type { CallUpstream } from "./upstream-mcp.js";

export const TRIVAGO_URL = "https://mcp.trivago.com/mcp";
// Read-only search tools only; trivago offers nothing else we call.
export const TRIVAGO_TOOLS = ["trivago-accommodation-radius-search", "trivago-accommodation-search"] as const;
export const TRIVAGO_TIMEOUT_MS = 15_000;
/** Hotels per search whose missing 2-adult price is looked up by name (cheapest first), and the least time worth it. */
const BASELINE_LOOKUPS = 15;
const MIN_LOOKUP_MS = 2_000;

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
    const started = Date.now();
    // For 3–4 guests trivago often prices two rooms under rooms=1 (its price then matches rooms=2; checked
    // live 2026-10-05), and names no room. The same points searched for 2 adults give each hotel a baseline
    // that tells a one-room price (an extra-guest charge) from a doubled one.
    const guests = q.adults + (q.children_ages?.length ?? 0);
    const wantsBaseline = guests > 2 && guests <= RATIO_MAX_GUESTS;
    const run = (query: HotelSearchQuery) =>
      Promise.allSettled(points.map((p) => withBudget(searchAround(p, query), pointBudgetMs)));
    const [results, baseResults] = await Promise.all([
      run(q),
      wantsBaseline ? run({ ...q, adults: 2, children_ages: [] }) : Promise.resolve([]),
    ]);
    const ok = results.filter((r): r is PromiseFulfilledResult<HotelCandidate[]> => r.status === "fulfilled");
    if (ok.length === 0) throw (results[0] as PromiseRejectedResult).reason;
    const byId = new Map<string, HotelCandidate>();
    for (const r of ok) for (const h of r.value) if (!byId.has(h.source_id)) byId.set(h.source_id, h);
    // Each hotel's 2-adult offer, kept with its booking site: trivago shows only the cheapest site, which can
    // change with the party size, and only the same site's prices compare.
    const twoAdult = new Map<string, { seller: string | null; per_night: number }>();
    const keep = (h: HotelCandidate) => {
      const p = h.prices[0];
      if (p && !twoAdult.has(h.source_id))
        twoAdult.set(h.source_id, { seller: p.seller, per_night: p.per_night });
    };
    for (const r of baseResults) if (r.status === "fulfilled") r.value.forEach(keep);
    const basePointsFailed = baseResults.filter((r) => r.status === "rejected").length;
    // The 2-adult search ranks a different ~25 hotels per point, so many hotels miss their baseline. The
    // cheapest of those (the ones a price sort would show first) are looked up by name for 2 adults, in
    // whatever time is left of the point budget.
    const remaining = pointBudgetMs - (Date.now() - started);
    let lookupsFailed = 0;
    let lookupsSkipped = false;
    if (wantsBaseline && remaining < MIN_LOOKUP_MS) lookupsSkipped = true;
    else if (wantsBaseline) {
      const missing = [...byId.values()]
        .filter((h) => h.prices[0] && !twoAdult.has(h.source_id) && haversineKm(q, h) <= q.radius_km)
        .sort((a, b) => a.prices[0]!.per_night - b.prices[0]!.per_night)
        .slice(0, BASELINE_LOOKUPS);
      const pair = { ...q, adults: 2, children_ages: [] };
      const found = await Promise.allSettled(
        missing.map((h) => withBudget(lookup(h.source_id, h.name, undefined, pair), remaining)),
      );
      for (const r of found) {
        if (r.status === "fulfilled") {
          if (r.value) keep(r.value);
        } else lookupsFailed++;
      }
    }
    const hotels = [...byId.values()]
      .filter((h) => haversineKm(q, h) <= q.radius_km)
      .map((h) =>
        wantsBaseline
          ? {
              ...h,
              prices: h.prices.map((p) => {
                const base = twoAdult.get(h.source_id);
                return {
                  ...p,
                  two_adult_per_night: base && base.seller === p.seller ? base.per_night : null,
                };
              }),
            }
          : h,
      );
    const pts = points.length === 1 ? "1 point" : `${ok.length} of ${points.length} points across the radius`;
    const priced = hotels.filter((h) => h.prices.length > 0);
    const checked = priced.filter((h) => h.prices[0]!.two_adult_per_night != null).length;
    return {
      hotels,
      coverage_note:
        `about 25 hotels per point searched (trivago has no radius control); searched ${pts}` +
        (wantsBaseline
          ? `; same-site 2-adult prices found for ${checked} of ${priced.length} priced hotels, to spot two-room prices` +
            (basePointsFailed ? ` (${basePointsFailed} 2-adult points failed)` : "") +
            (lookupsFailed ? ` (${lookupsFailed} name lookups failed)` : "") +
            (lookupsSkipped ? " (no time left for name lookups)" : "")
          : ""),
    };
  }

  return {
    info: TRIVAGO_INFO,
    search: async (q: HotelSearchQuery) => (await searchWithCoverage(q)).hotels,
    searchWithCoverage,
    lookup,
  };
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const ms = Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86_400_000));
}
