import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { AppError, upstreamText } from "../core/errors.js";
import { haversineKm } from "../core/geo.js";
import type { HotelCandidate, HotelSearchQuery, LatLng, PriceQuote } from "../core/types.js";
import { DEFAULT_DATA_DIR } from "../data/datasets.js";
import { TtlCache } from "../lib/cache.js";
import { getJson, type HttpOptions } from "../lib/http.js";
import { parseUpstream } from "./shared.js";
import type { HotelSearchProvider, ProviderInfo } from "./types.js";

export const XOTELO_BASE_URL = "https://data.xotelo.com/api";
const TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const MAX_KEYS = 3;
const KEY_MARGIN_KM = 10;
const LIST_TTL_MS = 7 * 24 * 3_600_000;
const RATES_TTL_MS = 3 * 3_600_000;
const EMPTY_RATES_TTL_MS = 3_600_000;

export const XOTELO_INFO: ProviderInfo = {
  id: "xotelo",
  name: "Xotelo (TripAdvisor hotel prices)",
  kind: "hotel-prices",
  official: false,
  needsKey: false,
  limitations: [
    "Unofficial free API with no SLA; it may change or disappear without notice.",
    "Prices come from TripAdvisor's OTA comparison (Booking.com, Agoda, Trip.com, Vio) and are likely pre-tax.",
    "No Indian OTAs (MakeMyTrip, Goibibo, OYO) and thin coverage of OYO/FabHotel-type properties.",
    "Searches by TripAdvisor location key, so only the first few hundred hotels of a large city are scanned.",
  ],
};

/** One TripAdvisor location key with an approximate centre, from data/xotelo_keys.json.gz. */
export interface XoteloKeyRow {
  key: string;
  name: string;
  lat: number;
  lng: number;
  hotels: number;
}

const ErrorField = z.object({ status_code: z.number().nullish(), message: z.string().nullish() }).nullish();

const ListItem = z.object({
  name: z.string(),
  key: z.string(),
  accommodation_type: z.string().nullish(),
  url: z.string().nullish(),
  review_summary: z.object({ rating: z.number().nullish(), count: z.number().nullish() }).nullish(),
  price_ranges: z.object({ minimum: z.number().nullish(), maximum: z.number().nullish() }).nullish(),
  geo: z.object({ latitude: z.number(), longitude: z.number() }).nullish(),
});

const ListPayload = z.object({
  error: ErrorField,
  result: z
    .object({
      total_count: z.number(),
      limit: z.number().nullish(),
      offset: z.number().nullish(),
      list: z.array(ListItem),
    })
    .nullish(),
});

const RatesPayload = z.object({
  error: ErrorField,
  result: z
    .object({
      chk_in: z.string().nullish(),
      chk_out: z.string().nullish(),
      currency: z.string().nullish(),
      rates: z.array(
        z.object({
          code: z.string().nullish(),
          name: z.string(),
          rate: z.number(),
          tax: z.number().nullish(),
        }),
      ),
    })
    .nullish(),
});

export type XoteloListItem = z.infer<typeof ListItem>;
export type XoteloListPage = { total_count: number; list: XoteloListItem[] };

/**
 * Parses a TripAdvisor hotel URL (`Hotel_Review-g<geo>-d<id>-Reviews-<Hotel>-<Place_Path>.html`).
 * The URL's geo is the hotel's most specific location; `/list` rewrites the `key` prefix to the queried one.
 */
export function parseTripadvisorUrl(
  url: string | null | undefined,
): { geo: string; id: string; place: string } | null {
  const m = url?.match(/Hotel_Review-g(\d+)-d(\d+)-Reviews-(.+?)\.html/);
  if (!m) return null;
  const tail = m[3]!;
  const place = tail.slice(tail.lastIndexOf("-") + 1).replace(/_/g, " ");
  return { geo: `g${m[1]}`, id: `d${m[2]}`, place };
}

/** Maps Xotelo's in-band error object (sent with HTTP 200) to an AppError. */
export function xoteloError(err: { status_code?: number | null; message?: string | null }): AppError {
  const status = err.status_code ?? 0;
  const message = upstreamText(err.message) || "unknown error";
  const text = `Xotelo error ${status || ""}: ${message}`.replace(/ {2}/, " ");
  if (status === 404 || /invalid (location_key|hotel_key)|not found/i.test(message)) {
    return new AppError("NOT_FOUND", text);
  }
  if (status === 429) return new AppError("RATE_LIMITED", text, "Try again in a minute.");
  if (/chk_(in|out)/i.test(message)) return new AppError("INVALID_INPUT", text);
  if (status >= 400 && status < 500 && status !== 401 && status !== 403) {
    // We only send parameters that used to be valid, so a 4xx means the API contract moved.
    return new AppError(
      "SCHEMA_CHANGED",
      text,
      "Xotelo may have changed its API; other sources are unaffected.",
    );
  }
  return new AppError("UPSTREAM_UNAVAILABLE", text);
}

/** Loads the bundled key table; empty when it has not been built. */
export function loadXoteloKeys(dir = DEFAULT_DATA_DIR): XoteloKeyRow[] {
  const file = join(dir, "xotelo_keys.json.gz");
  if (!existsSync(file)) return [];
  return JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as XoteloKeyRow[];
}

/** Up to `max` keys whose centre is within `radiusKm + 10 km` of the point, nearest first. */
export function pickXoteloKeys(keys: readonly XoteloKeyRow[], at: LatLng, radiusKm: number, max = MAX_KEYS) {
  return keys
    .map((k) => ({ row: k, km: haversineKm(at, k) }))
    .filter((k) => k.km <= radiusKm + KEY_MARGIN_KM)
    .sort((a, b) => a.km - b.km)
    .slice(0, max)
    .map((k) => k.row);
}

export interface XoteloOptions {
  http: HttpOptions;
  keys: readonly XoteloKeyRow[];
  /** Epoch ms clock; used for throttling, caches and fetched_at. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum gap between requests to data.xotelo.com. */
  minIntervalMs?: number;
  /** `/list` pages fetched per location key (100 hotels each). */
  maxPagesPerKey?: number;
  /** How many of the nearest hotels get a `/rates` call. */
  ratesForNearest?: number;
  baseUrl?: string;
}

export function createXotelo(opts: XoteloOptions) {
  const {
    keys,
    now = Date.now,
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    minIntervalMs = 1200,
    maxPagesPerKey = 3,
    ratesForNearest = 10,
    baseUrl = XOTELO_BASE_URL,
  } = opts;
  const http: HttpOptions = { ...opts.http, timeoutMs: opts.http.timeoutMs ?? TIMEOUT_MS };
  const listCache = new TtlCache<XoteloListPage>(2_000, now);
  const ratesCache = new TtlCache<RateRow[]>(5_000, now);
  let nextSlot = 0;
  let queue: Promise<void> = Promise.resolve();

  /** Serialises request starts to data.xotelo.com so they are at least `minIntervalMs` apart. */
  function throttle(): Promise<void> {
    const turn = queue.then(async () => {
      const wait = nextSlot - now();
      if (wait > 0) await sleep(wait);
      nextSlot = now() + minIntervalMs;
    });
    queue = turn.catch(() => undefined);
    return turn;
  }

  async function call(path: string, params: Record<string, string | number>): Promise<unknown> {
    const url = new URL(`${baseUrl.replace(/\/$/, "")}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    await throttle();
    return getJson(url.toString(), http);
  }

  async function listPage(key: string, offset: number): Promise<XoteloListPage> {
    return listCache.getOrSet(`${key}:${offset}`, LIST_TTL_MS, async () => {
      const raw = await call("list", { location_key: key, limit: PAGE_SIZE, offset, sort: "best_value" });
      const payload = parseUpstream("xotelo", ListPayload, raw);
      if (payload.error) throw xoteloError(payload.error);
      if (!payload.result)
        throw new AppError("SCHEMA_CHANGED", "Xotelo /list returned no result and no error");
      return { total_count: payload.result.total_count, list: payload.result.list };
    });
  }

  interface RateRow {
    name: string;
    rate: number;
    tax: number | null;
    currency: string;
  }

  async function fetchRates(
    hotelKey: string,
    checkIn: string,
    checkOut: string,
    adults: number,
  ): Promise<RateRow[]> {
    const cacheKey = `${hotelKey}:${checkIn}:${checkOut}:${adults}`;
    const hit = ratesCache.get(cacheKey);
    if (hit) return hit;
    const raw = await call("rates", {
      hotel_key: hotelKey,
      chk_in: checkIn,
      chk_out: checkOut,
      adults,
      rooms: 1,
      currency: "INR",
    });
    const payload = parseUpstream("xotelo", RatesPayload, raw);
    if (payload.error) throw xoteloError(payload.error);
    if (!payload.result)
      throw new AppError("SCHEMA_CHANGED", "Xotelo /rates returned no result and no error");
    const currency = payload.result.currency || "INR";
    const rows = payload.result.rates.map((r) => ({
      name: r.name,
      rate: r.rate,
      tax: r.tax ?? null,
      currency,
    }));
    ratesCache.set(cacheKey, rows, rows.length ? RATES_TTL_MS : EMPTY_RATES_TTL_MS);
    return rows;
  }

  function toQuotes(rows: RateRow[], fetchedAt: string): PriceQuote[] {
    return rows.map((r) => ({
      source: "xotelo",
      seller: r.name,
      // A stated tax is added so the price is the all-in figure; without it the rate is likely pre-tax.
      per_night: r.tax === null ? r.rate : r.rate + r.tax,
      total: null,
      currency: r.currency,
      per_night_inr: r.currency === "INR" ? (r.tax === null ? r.rate : r.rate + r.tax) : null,
      includes_taxes: r.tax === null ? null : true,
      available: null,
      refundable: null,
      url: null,
      fetched_at: fetchedAt,
    }));
  }

  /** Per-OTA prices for one hotel (`hotel_key` such as `g304551-d495582`; only the `d` part matters). */
  async function rates(
    hotelKey: string,
    checkIn: string,
    checkOut: string,
    adults = 2,
  ): Promise<PriceQuote[]> {
    const rows = await fetchRates(hotelKey, checkIn, checkOut, adults);
    return toQuotes(rows, new Date(now()).toISOString());
  }

  async function search(q: HotelSearchQuery): Promise<HotelCandidate[]> {
    const chosen = pickXoteloKeys(keys, q, q.radius_km);
    if (chosen.length === 0) return [];

    // Collect hotels within the radius from each key's first pages, deduped by TripAdvisor hotel id.
    const byId = new Map<string, { item: XoteloListItem; hotelKey: string; km: number }>();
    const errors: AppError[] = [];
    for (const k of chosen) {
      try {
        for (let page = 0; page < maxPagesPerKey; page++) {
          const res = await listPage(k.key, page * PAGE_SIZE);
          for (const item of res.list) {
            if (!item.geo) continue;
            const km = haversineKm(q, { lat: item.geo.latitude, lng: item.geo.longitude });
            if (km > q.radius_km) continue;
            const parsed = parseTripadvisorUrl(item.url);
            const id = parsed?.id ?? item.key.replace(/^g\d+-/, "");
            const hotelKey = parsed ? `${parsed.geo}-${parsed.id}` : item.key;
            if (!byId.has(id)) byId.set(id, { item, hotelKey, km });
          }
          if (res.list.length < PAGE_SIZE || (page + 1) * PAGE_SIZE >= res.total_count) break;
        }
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        errors.push(err);
      }
    }
    if (errors.length === chosen.length) throw errors[0]!;

    const hotels = [...byId.values()].sort((a, b) => a.km - b.km);
    const priced = hotels.slice(0, ratesForNearest);
    const rateResults = await Promise.allSettled(
      priced.map((h) => fetchRates(h.hotelKey, q.check_in, q.check_out, q.adults)),
    );
    const failed = rateResults.filter((r) => r.status === "rejected");
    if (priced.length > 0 && failed.length === priced.length)
      throw (failed[0] as PromiseRejectedResult).reason;

    const fetchedAt = new Date(now()).toISOString();
    return hotels.map((h, i): HotelCandidate => {
      const r = rateResults[i];
      const rating = h.item.review_summary?.rating;
      const count = h.item.review_summary?.count;
      return {
        source: "xotelo",
        source_id: h.hotelKey,
        name: h.item.name,
        lat: h.item.geo!.latitude,
        lng: h.item.geo!.longitude,
        stars: null,
        // TripAdvisor rates out of 5; 0 means "no reviews yet".
        rating_10: rating ? Math.round(rating * 20) / 10 : null,
        review_count: count ? count : null,
        url: h.item.url ?? null,
        prices: r?.status === "fulfilled" ? toQuotes(r.value, fetchedAt) : [],
        fetched_at: fetchedAt,
      };
    });
  }

  const provider: HotelSearchProvider & { rates: typeof rates } = { info: XOTELO_INFO, search, rates };
  return provider;
}

export type Xotelo = ReturnType<typeof createXotelo>;
