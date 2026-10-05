import * as nodeFs from "node:fs";
import { dirname } from "node:path";
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
        // Google sometimes lists a price without naming its site (seen live, 2026-10-05); such a price is
        // skipped rather than failing the whole response.
        source: z.string().nullish(),
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

const RoomRate = z.object({
  num_guests: z.number().nullish(),
  link: z.string().nullish(),
  rate_per_night: Rate,
});

const FeaturedPrice = z.object({
  source: z.string().nullish(),
  link: z.string().nullish(),
  rooms: z
    .array(
      z.object({
        name: z.string().nullish(),
        num_guests: z.number().nullish(),
        link: z.string().nullish(),
        rate_per_night: Rate,
        rates: z.array(RoomRate).nullish(),
      }),
    )
    .nullish(),
});

const DetailsPayload = z.object({
  search_metadata: z.object({ status: z.string().nullish() }).nullish(),
  error: z.string().nullish(),
  featured_prices: z.array(FeaturedPrice).nullish(),
});

/** One room rate a booking site lists on Google's hotel page. */
export interface GoogleRoomOffer {
  /** Booking site, e.g. "Booking.com", "Agoda". */
  seller: string;
  /** Room name as listed, e.g. "Standard Family Room", "Cheapest combo rooms". */
  room: string;
  /** Guests this rate is for, only where the site reports real capacity (Booking.com, Agoda); null otherwise (Expedia-family sites echo the searched party). */
  guests: number | null;
  per_night: number;
  currency: string;
  url: string | null;
}

export interface GoogleRoomsQuery {
  check_in: string;
  check_out: string;
  adults: number;
  children_ages?: number[];
  /** Free text for Google's q parameter; the property token decides the hotel. */
  hotel_name?: string;
}

// Sites whose per-room guest count is the room's capacity. Others (Expedia, Hotels.com, Travelocity, …)
// repeat the searched party size on every room, so their count says nothing about the room.
const REPORTS_CAPACITY = /^(booking\.com|agoda)/i;

export interface SerpApiOptions {
  apiKey: string;
  http: HttpOptions;
  /** Epoch ms clock; used for the cache, the monthly quota window and fetched_at. */
  now?: () => number;
  monthlyQuota?: number;
  /** Google Hotels pages (~20 hotels each) per area search; every page is one search against the quota. */
  maxPages?: number;
  baseUrl?: string;
  /** JSON file holding this month's search count, so the quota survives restarts; omitted = in memory only. */
  statePath?: string;
  /** File system used for statePath (injectable for tests). */
  fs?: QuotaFs;
  /** Uncached room-list lookups allowed per rolling hour; 0 = unlimited. */
  roomsPerHour?: number;
}

export type QuotaFs = Pick<typeof nodeFs, "readFileSync" | "writeFileSync" | "renameSync" | "mkdirSync">;

const QuotaState = z.object({ month: z.string(), used: z.number().int().min(0) });
const HOUR_MS = 3_600_000;

/** Builds the Google Hotels request URL (exported for tests). */
export function serpApiUrl(q: HotelSearchQuery, apiKey: string, baseUrl = SERPAPI_URL): string {
  const url = new URL(baseUrl);
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
    ...partyParams(q.adults, q.children_ages),
    api_key: apiKey,
  };
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

function partyParams(adults: number, childrenAges: number[] = []): Record<string, string> {
  const params: Record<string, string> = { adults: String(adults) };
  if (childrenAges.length) {
    params.children = String(childrenAges.length);
    // Google Hotels takes ages 1–17; an infant is sent as 1.
    params.children_ages = childrenAges.map((a) => Math.max(1, a)).join(",");
  }
  return params;
}

/** Builds the Google Hotels property-details request URL (exported for tests). */
export function serpApiRoomsUrl(
  propertyToken: string,
  q: GoogleRoomsQuery,
  apiKey: string,
  baseUrl = SERPAPI_URL,
): string {
  const url = new URL(baseUrl);
  const params: Record<string, string> = {
    engine: "google_hotels",
    q: q.hotel_name || "hotel",
    property_token: propertyToken,
    gl: "in",
    hl: "en",
    currency: "INR",
    check_in_date: q.check_in,
    check_out_date: q.check_out,
    ...partyParams(q.adults, q.children_ages),
    api_key: apiKey,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** One offer per listed rate (or per room when it lists no separate rates); entries without a price are skipped. */
function roomOffers(payload: z.infer<typeof DetailsPayload>): GoogleRoomOffer[] {
  return (payload.featured_prices ?? []).flatMap((site) => {
    // A site or room Google doesn't name can't be attributed or judged, so it is skipped.
    const source = site.source;
    if (!source) return [];
    const capacity = REPORTS_CAPACITY.test(source);
    return (site.rooms ?? []).flatMap((room) => {
      const name = room.name;
      if (!name) return [];
      const rates = room.rates?.length ? room.rates : [room];
      return rates.flatMap((rate): GoogleRoomOffer[] => {
        const perNight = rate.rate_per_night?.extracted_lowest;
        if (perNight == null) return [];
        return [
          {
            seller: source,
            room: name,
            guests: capacity ? (rate.num_guests ?? room.num_guests ?? null) : null,
            per_night: perNight,
            currency: "INR",
            url: rate.link ?? room.link ?? site.link ?? null,
          },
        ];
      });
    });
  });
}

export function createSerpApi(opts: SerpApiOptions) {
  const {
    apiKey,
    now = Date.now,
    monthlyQuota = 250,
    maxPages = 1,
    baseUrl = SERPAPI_URL,
    statePath,
    fs = nodeFs,
    roomsPerHour = 0,
  } = opts;
  const http: HttpOptions = { ...opts.http, timeoutMs: opts.http.timeoutMs ?? TIMEOUT_MS };
  const cache = new TtlCache<{ props: Prop[]; fetchedAt: string; next: string | null }>(500, now);
  const monthKey = () => new Date(now()).toISOString().slice(0, 7);
  let { month, used } = loadQuota();
  let writeFailed = false;

  /** This month's saved count; a missing or unreadable file starts from 0. */
  function loadQuota(): { month: string; used: number } {
    if (!statePath) return { month: "", used: 0 };
    try {
      const parsed = QuotaState.safeParse(JSON.parse(fs.readFileSync(statePath, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      // Missing or corrupt: start from 0.
    }
    return { month: "", used: 0 };
  }

  /** Saves the count atomically (temp file + rename); a failure is logged once and never blocks a search. */
  function saveQuota(): void {
    if (!statePath) return;
    const tmp = `${statePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(dirname(statePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ month, used }));
      fs.renameSync(tmp, statePath);
    } catch (err) {
      if (!writeFailed) {
        writeFailed = true;
        console.error(
          `SerpApi quota counter could not be saved to ${statePath} (counting in memory only): ${(err as Error).message}`,
        );
      }
    }
  }

  function quotaRemaining(): number {
    if (monthKey() !== month) {
      month = monthKey();
      used = 0;
    }
    return Math.max(0, monthlyQuota - used);
  }

  type Page = { props: Prop[]; fetchedAt: string; next: string | null };

  /** One SerpApi search against the quota; null when Google has no results, AppError on any other in-band error. */
  async function request<T extends { error?: string | null }>(
    schema: z.ZodType<T>,
    url: string,
    onSpend?: () => void,
  ): Promise<T | null> {
    if (quotaRemaining() <= 0) {
      throw new AppError(
        "QUOTA_EXHAUSTED",
        `SerpApi monthly quota of ${monthlyQuota} searches is used up`,
        "Cached searches still work; new areas or dates must wait for next month.",
      );
    }
    // Another process (a second server, the smoke script) may share the state file: count from whichever
    // is higher, so searches it spent are not lost when this one saves.
    const disk = loadQuota();
    if (disk.month === month) used = Math.max(used, disk.used);
    used++;
    saveQuota();
    onSpend?.();
    const payload = parseUpstream("serpapi", schema, await getJson(url, http));
    if (payload.error) {
      // "hasn't returned any results" is a valid empty answer, not a failure.
      if (/hasn't returned any results|no results/i.test(payload.error)) return null;
      if (/run out of searches|plan.*limit/i.test(payload.error)) {
        used = monthlyQuota;
        saveQuota();
        throw new AppError("QUOTA_EXHAUSTED", `SerpApi: ${upstreamText(payload.error)}`);
      }
      throw new AppError("UPSTREAM_UNAVAILABLE", `SerpApi: ${upstreamText(payload.error)}`);
    }
    return payload;
  }

  async function fetchPage(q: HotelSearchQuery, token: string | null): Promise<Page> {
    const withToken = (url: string) => (token ? `${url}&next_page_token=${encodeURIComponent(token)}` : url);
    // Everything that changes the request changes the cache key (the URL without the key).
    const key = withToken(serpApiUrl(q, "-"));
    return cache.getOrSet(key, CACHE_TTL_MS, async () => {
      const payload = await request(Payload, withToken(serpApiUrl(q, apiKey, baseUrl)));
      const fetchedAt = new Date(now()).toISOString();
      if (!payload) return { props: [], fetchedAt, next: null };
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

  const roomsCache = new TtlCache<GoogleRoomOffer[]>(200, now);
  /** Start times of uncached room-list lookups in the last hour. */
  let roomLookups: number[] = [];

  /** Throws RATE_LIMITED when this hour's room-list lookups are used up. */
  function checkRoomCap(): void {
    if (roomsPerHour <= 0) return;
    const t = now();
    roomLookups = roomLookups.filter((at) => at > t - HOUR_MS);
    if (roomLookups.length >= roomsPerHour) {
      const waitMin = Math.max(1, Math.ceil((roomLookups[0]! + HOUR_MS - t) / 60_000));
      throw new AppError(
        "RATE_LIMITED",
        `Google room-list lookups are capped at ${roomsPerHour} per hour to save SerpApi quota; the next is possible in ~${waitMin} min, and until then every uncached lookup gets this same answer`,
        "Cached room lists still work; SERPAPI_ROOMS_PER_HOUR sets the cap.",
      );
    }
  }

  /** Every room Google's hotel page lists for these dates, per booking site (1 SerpApi search, cached 24 h). */
  async function rooms(propertyToken: string, q: GoogleRoomsQuery): Promise<GoogleRoomOffer[]> {
    // Everything that changes the request changes the cache key (the URL without the key).
    return roomsCache.getOrSet(serpApiRoomsUrl(propertyToken, q, "-"), CACHE_TTL_MS, async () => {
      checkRoomCap();
      // Recorded only once a search is actually spent (not when the monthly quota is already used up).
      const payload = await request(DetailsPayload, serpApiRoomsUrl(propertyToken, q, apiKey, baseUrl), () =>
        roomLookups.push(now()),
      );
      return payload ? roomOffers(payload) : [];
    });
  }

  const provider: HotelSearchProvider & {
    quotaRemaining: () => number;
    rooms: (propertyToken: string, q: GoogleRoomsQuery) => Promise<GoogleRoomOffer[]>;
  } = {
    info: SERPAPI_INFO,
    search: async (q) => (await searchWithCoverage(q)).hotels,
    searchWithCoverage,
    quotaRemaining,
    rooms,
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
    .map((s) =>
      s.source ? quote(s.source, s.rate_per_night, s.total_rate, s.link ?? p.link ?? null, fetchedAt) : null,
    )
    .filter((x): x is PriceQuote => x !== null);
  if (perSource.length) return perSource;
  // Google's headline rate doesn't say which site offers it.
  const lowest = quote(GOOGLE_LOWEST, p.rate_per_night, p.total_rate, p.link ?? null, fetchedAt);
  return lowest ? [lowest] : [];
}

export type SerpApi = ReturnType<typeof createSerpApi>;
