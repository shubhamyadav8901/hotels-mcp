import { z } from "zod";
import { AppError } from "../core/errors.js";
import { haversineKm } from "../core/geo.js";
import type { HotelCandidate, HotelSearchQuery, PriceQuote } from "../core/types.js";
import { TtlCache } from "../lib/cache.js";
import { getJson, type HttpOptions } from "../lib/http.js";
import { parseUpstream } from "./shared.js";
import type { HotelSearchProvider, ProviderInfo } from "./types.js";

export const SERPAPI_URL = "https://serpapi.com/search.json";
const CACHE_TTL_MS = 24 * 3_600_000;
const TIMEOUT_MS = 20_000;

export const SERPAPI_INFO: ProviderInfo = {
  id: "serpapi",
  name: "Google Hotels via SerpApi",
  kind: "hotel-prices",
  official: true,
  needsKey: true,
  limitations: [
    "Free plan allows 250 searches a month (50 an hour); results are cached for 24 h to save quota.",
    "Google Hotels takes a text query only (no radius), so results are filtered by distance afterwards.",
    "Prices are Google Hotels meta-search prices and can differ at checkout.",
  ],
};

const Rate = z
  .object({
    lowest: z.string().nullish(),
    extracted_lowest: z.number().nullish(),
    before_taxes_fees: z.string().nullish(),
    extracted_before_taxes_fees: z.number().nullish(),
  })
  .nullish();

const Property = z.object({
  type: z.string().nullish(),
  name: z.string(),
  link: z.string().nullish(),
  property_token: z.string().nullish(),
  gps_coordinates: z.object({ latitude: z.number(), longitude: z.number() }).nullish(),
  hotel_class: z.union([z.string(), z.number()]).nullish(),
  extracted_hotel_class: z.number().nullish(),
  overall_rating: z.number().nullish(),
  reviews: z.number().nullish(),
  rate_per_night: Rate,
  total_rate: Rate,
  prices: z
    .array(
      z.object({
        source: z.string(),
        link: z.string().nullish(),
        rate_per_night: Rate,
        total_rate: Rate,
      }),
    )
    .nullish(),
});

const Payload = z.object({
  search_metadata: z.object({ status: z.string().nullish() }).nullish(),
  error: z.string().nullish(),
  properties: z.array(Property).nullish(),
});

type Prop = z.infer<typeof Property>;

export interface SerpApiOptions {
  apiKey: string;
  http: HttpOptions;
  /** Epoch ms clock; used for the cache, the monthly quota window and fetched_at. */
  now?: () => number;
  monthlyQuota?: number;
  baseUrl?: string;
}

/** Builds the Google Hotels request URL (exported for tests). */
export function serpApiUrl(q: HotelSearchQuery, apiKey: string, baseUrl = SERPAPI_URL): string {
  const url = new URL(baseUrl);
  const params: Record<string, string> = {
    engine: "google_hotels",
    q: `hotels near ${q.lat.toFixed(4)},${q.lng.toFixed(4)}`,
    gl: "in",
    hl: "en",
    currency: "INR",
    check_in_date: q.check_in,
    check_out_date: q.check_out,
    adults: String(q.adults),
    api_key: apiKey,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export function createSerpApi(opts: SerpApiOptions) {
  const { apiKey, now = Date.now, monthlyQuota = 250, baseUrl = SERPAPI_URL } = opts;
  const http: HttpOptions = { ...opts.http, timeoutMs: opts.http.timeoutMs ?? TIMEOUT_MS };
  const cache = new TtlCache<{ props: Prop[]; fetchedAt: string }>(500, now);
  let month = "";
  let used = 0;

  const monthKey = () => new Date(now()).toISOString().slice(0, 7);
  function quotaRemaining(): number {
    if (monthKey() !== month) {
      month = monthKey();
      used = 0;
    }
    return Math.max(0, monthlyQuota - used);
  }

  async function fetchProps(q: HotelSearchQuery): Promise<{ props: Prop[]; fetchedAt: string }> {
    const key = `${q.lat.toFixed(3)},${q.lng.toFixed(3)}:${q.check_in}:${q.check_out}:${q.adults}`;
    return cache.getOrSet(key, CACHE_TTL_MS, async () => {
      if (quotaRemaining() <= 0) {
        throw new AppError(
          "QUOTA_EXHAUSTED",
          `SerpApi monthly quota of ${monthlyQuota} searches is used up`,
          "Cached searches still work; new areas or dates must wait for next month.",
        );
      }
      used++;
      const payload = parseUpstream("serpapi", Payload, await getJson(serpApiUrl(q, apiKey, baseUrl), http));
      const fetchedAt = new Date(now()).toISOString();
      if (payload.error) {
        // "hasn't returned any results" is a valid empty answer, not a failure.
        if (/hasn't returned any results|no results/i.test(payload.error)) return { props: [], fetchedAt };
        if (/run out of searches|plan.*limit/i.test(payload.error)) {
          used = monthlyQuota;
          throw new AppError("QUOTA_EXHAUSTED", `SerpApi: ${payload.error}`);
        }
        throw new AppError("UPSTREAM_UNAVAILABLE", `SerpApi: ${payload.error}`);
      }
      return { props: payload.properties ?? [], fetchedAt };
    });
  }

  async function search(q: HotelSearchQuery): Promise<HotelCandidate[]> {
    const { props, fetchedAt } = await fetchProps(q);
    return props.flatMap((p): HotelCandidate[] => {
      if (!p.gps_coordinates) return [];
      const at = { lat: p.gps_coordinates.latitude, lng: p.gps_coordinates.longitude };
      if (haversineKm(q, at) > q.radius_km) return [];
      const stars =
        p.extracted_hotel_class ?? (typeof p.hotel_class === "number" ? p.hotel_class : null) ?? null;
      return [
        {
          source: "serpapi",
          source_id: p.property_token ?? `${p.name}@${at.lat},${at.lng}`,
          name: p.name,
          ...at,
          stars: stars || null,
          // Google ratings are out of 5.
          rating_10: p.overall_rating ? Math.round(p.overall_rating * 20) / 10 : null,
          review_count: p.reviews ?? null,
          url: p.link ?? null,
          prices: quotes(p, fetchedAt),
          fetched_at: fetchedAt,
        },
      ];
    });
  }

  const provider: HotelSearchProvider & { quotaRemaining: () => number } = {
    info: SERPAPI_INFO,
    search,
    quotaRemaining,
  };
  return provider;
}

function quote(
  seller: string | null,
  rate: z.infer<typeof Rate>,
  total: z.infer<typeof Rate>,
  url: string | null,
  fetchedAt: string,
): PriceQuote | null {
  const perNight = rate?.extracted_lowest;
  if (perNight == null) return null;
  return {
    source: "serpapi",
    seller,
    per_night: perNight,
    total: total?.extracted_lowest ?? null,
    currency: "INR",
    per_night_inr: perNight,
    // Google shows a separate before-taxes figure when the headline price includes taxes and fees.
    includes_taxes: rate?.extracted_before_taxes_fees != null ? true : null,
    available: null,
    refundable: null,
    url,
    fetched_at: fetchedAt,
  };
}

/** One quote per booking source when Google lists them, else the property's lowest rate. */
function quotes(p: Prop, fetchedAt: string): PriceQuote[] {
  const perSource = (p.prices ?? [])
    .map((s) => quote(s.source, s.rate_per_night, s.total_rate, s.link ?? p.link ?? null, fetchedAt))
    .filter((x): x is PriceQuote => x !== null);
  if (perSource.length) return perSource;
  const lowest = quote(null, p.rate_per_night, p.total_rate, p.link ?? null, fetchedAt);
  return lowest ? [lowest] : [];
}

export type SerpApi = ReturnType<typeof createSerpApi>;
