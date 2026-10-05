import { z } from "zod";
import { AppError, upstreamText } from "../core/errors.js";
import { haversineKm } from "../core/geo.js";
import type { HotelCandidate, HotelSearchQuery, PriceQuote } from "../core/types.js";
import { TtlCache } from "../lib/cache.js";
import { getJson, type HttpOptions } from "../lib/http.js";
import { parseUpstream } from "./shared.js";
import type { HotelSearchProvider, ProviderInfo, SearchOutcome } from "./types.js";

export const SERPAPI_URL = "https://serpapi.com/search.json";
const GOOGLE_LOWEST = "Google Hotels (lowest listed)";
const CACHE_TTL_MS = 24 * 3_600_000;
const TIMEOUT_MS = 20_000;

export const SERPAPI_INFO: ProviderInfo = {
  id: "serpapi",
  name: "Google Hotels via SerpApi (unofficial scraper)",
  kind: "hotel-prices",
  // SerpApi is an independent company that scrapes Google's result pages; Google's terms forbid automated
  // querying and Google has sued SerpApi over it. Treated as unofficial: it needs ENABLE_UNOFFICIAL_SOURCES.
  official: false,
  needsKey: true,
  limitations: [
    "Not a Google API: SerpApi (an independent company) scrapes Google Hotels pages; Google's terms forbid automated querying and Google has sued SerpApi.",
    "Free plan allows 250 searches a month (50 an hour); results are cached for 24 h to save quota.",
    "Google Hotels searches by place name only (it ignores coordinates), so results are filtered by distance afterwards.",
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
  serpapi_pagination: z.object({ next_page_token: z.string().nullish() }).nullish(),
});

type Prop = z.infer<typeof Property>;

export interface SerpApiOptions {
  apiKey: string;
  http: HttpOptions;
  /** Epoch ms clock; used for the cache, the monthly quota window and fetched_at. */
  now?: () => number;
  monthlyQuota?: number;
  /** Google Hotels pages (~20 hotels each) per area search; every page is one search against the quota. */
  maxPages?: number;
  baseUrl?: string;
}

/** Builds the Google Hotels request URL (exported for tests). */
export function serpApiUrl(q: HotelSearchQuery, apiKey: string, baseUrl = SERPAPI_URL): string {
  const url = new URL(baseUrl);
  const ages = q.children_ages ?? [];
  const params: Record<string, string> = {
    engine: "google_hotels",
    q: q.hotel_name
      ? [q.hotel_name, q.place].filter(Boolean).join(", ")
      : `hotels ${q.place_is_area ? "in" : "near"} ${q.place}`,
    gl: "in",
    hl: "en",
    currency: "INR",
    check_in_date: q.check_in,
    check_out_date: q.check_out,
    adults: String(q.adults),
    api_key: apiKey,
  };
  if (ages.length) {
    params.children = String(ages.length);
    // Google Hotels takes ages 1–17; an infant is sent as 1.
    params.children_ages = ages.map((a) => Math.max(1, a)).join(",");
  }
  // Google returns one page of ~20; ask it for the right page rather than re-sorting its top 20.
  if (!q.hotel_name && q.prefer?.sort === "price") params.sort_by = "3";
  if (!q.hotel_name && q.prefer?.sort === "rating") params.sort_by = "8";
  // Google's star filter starts at 2; a minimum of 1 means "no filter" there.
  if (!q.hotel_name && q.prefer?.min_stars && q.prefer.min_stars > 1) {
    params.hotel_class = [2, 3, 4, 5].filter((n) => n >= q.prefer!.min_stars!).join(",");
  }
  if (!q.hotel_name && q.prefer?.max_price_inr) params.max_price = String(Math.floor(q.prefer.max_price_inr));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export function createSerpApi(opts: SerpApiOptions) {
  const { apiKey, now = Date.now, monthlyQuota = 250, maxPages = 1, baseUrl = SERPAPI_URL } = opts;
  const http: HttpOptions = { ...opts.http, timeoutMs: opts.http.timeoutMs ?? TIMEOUT_MS };
  const cache = new TtlCache<{ props: Prop[]; fetchedAt: string; next: string | null }>(500, now);
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

  type Page = { props: Prop[]; fetchedAt: string; next: string | null };

  async function fetchPage(q: HotelSearchQuery, token: string | null): Promise<Page> {
    const withToken = (url: string) => (token ? `${url}&next_page_token=${encodeURIComponent(token)}` : url);
    // Everything that changes the request changes the cache key (the URL without the key).
    const key = withToken(serpApiUrl(q, "-"));
    return cache.getOrSet(key, CACHE_TTL_MS, async () => {
      if (quotaRemaining() <= 0) {
        throw new AppError(
          "QUOTA_EXHAUSTED",
          `SerpApi monthly quota of ${monthlyQuota} searches is used up`,
          "Cached searches still work; new areas or dates must wait for next month.",
        );
      }
      used++;
      const payload = parseUpstream(
        "serpapi",
        Payload,
        await getJson(withToken(serpApiUrl(q, apiKey, baseUrl)), http),
      );
      const fetchedAt = new Date(now()).toISOString();
      if (payload.error) {
        // "hasn't returned any results" is a valid empty answer, not a failure.
        if (/hasn't returned any results|no results/i.test(payload.error))
          return { props: [], fetchedAt, next: null };
        if (/run out of searches|plan.*limit/i.test(payload.error)) {
          used = monthlyQuota;
          throw new AppError("QUOTA_EXHAUSTED", `SerpApi: ${upstreamText(payload.error)}`);
        }
        throw new AppError("UPSTREAM_UNAVAILABLE", `SerpApi: ${upstreamText(payload.error)}`);
      }
      return {
        props: payload.properties ?? [],
        fetchedAt,
        next: payload.serpapi_pagination?.next_page_token ?? null,
      };
    });
  }

  /** Up to maxPages pages for an area search (one for a single-hotel lookup); a later page failing keeps the earlier ones. */
  async function fetchProps(
    q: HotelSearchQuery,
  ): Promise<{ props: Prop[]; fetchedAt: string; pages: number; more: boolean; pageFailed: boolean }> {
    const limit = q.hotel_name ? 1 : maxPages;
    const first = await fetchPage(q, null);
    const props = [...first.props];
    let next = first.next;
    let pages = 1;
    let pageFailed = false;
    while (next && pages < limit) {
      try {
        const page = await fetchPage(q, next);
        props.push(...page.props);
        next = page.next;
        pages++;
      } catch {
        // e.g. a page token from a cached first page that has since expired upstream.
        pageFailed = true;
        break;
      }
    }
    return { props, fetchedAt: first.fetchedAt, pages, more: Boolean(next) && !q.hotel_name, pageFailed };
  }

  async function searchWithCoverage(q: HotelSearchQuery): Promise<SearchOutcome> {
    if (!q.place && !q.hotel_name) {
      // Google Hotels ignores coordinates in a text query (it returned hotels 1,000+ km away in testing).
      throw new AppError(
        "NOT_APPLICABLE",
        "Skipped: Google Hotels searches by place name, and this search has only coordinates with no station within 3 km",
        "Search by station_code, iata or place to include Google Hotels prices.",
      );
    }
    const { props, fetchedAt, pages, more, pageFailed } = await fetchProps(q);
    const hotels = props.flatMap((p): HotelCandidate[] => {
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
    const query = new URL(serpApiUrl(q, "-")).searchParams.get("q");
    return {
      hotels,
      coverage_note:
        `${pages} Google Hotels page${pages > 1 ? "s" : ""} (~20 each) for "${query}"` +
        (pageFailed
          ? `; fetching page ${pages + 1} failed`
          : more
            ? `; more pages exist (SERPAPI_MAX_PAGES, one search each)`
            : ""),
    };
  }

  const provider: HotelSearchProvider & { quotaRemaining: () => number } = {
    info: SERPAPI_INFO,
    search: async (q) => (await searchWithCoverage(q)).hotels,
    searchWithCoverage,
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
    room: null,
    fetched_at: fetchedAt,
  };
}

/** One quote per booking source when Google lists them, else the property's lowest rate. */
function quotes(p: Prop, fetchedAt: string): PriceQuote[] {
  const perSource = (p.prices ?? [])
    .map((s) => quote(s.source, s.rate_per_night, s.total_rate, s.link ?? p.link ?? null, fetchedAt))
    .filter((x): x is PriceQuote => x !== null);
  if (perSource.length) return perSource;
  // Google's headline rate doesn't say which site offers it.
  const lowest = quote(GOOGLE_LOWEST, p.rate_per_night, p.total_rate, p.link ?? null, fetchedAt);
  return lowest ? [lowest] : [];
}

export type SerpApi = ReturnType<typeof createSerpApi>;
