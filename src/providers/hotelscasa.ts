import { z } from "zod";
import { AppError, upstreamText } from "../core/errors.js";
import type { HotelCandidate, HotelDetails, HotelSearchQuery } from "../core/types.js";
import { parseUpstream } from "./shared.js";
import type { HotelSearchProvider, ProviderInfo, SearchOutcome } from "./types.js";
import type { CallUpstream } from "./upstream-mcp.js";

export const HOTELSCASA_URL = "https://mcp.hotelscasa.com/mcp";
export const HOTELSCASA_TOOLS = ["search_hotels", "get_hotel"] as const;
export const HOTELSCASA_TIMEOUT_MS = 10_000;
const MAX_RADIUS_KM = 50;
const PAGE_SIZE = 10;
const MAX_IMAGES = 5;

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

const HotelItem = Item.extend({ photo_url: z.string().nullish() });

/** get_hotel: one hotel's page. Text fields often come back in Spanish even with lang=en. */
const HotelPayload = z.object({
  error: z.string().nullish(),
  message: z.string().nullish(),
  // Parsed on its own below, so a slimmer hotel object still leaves the rest of the details usable.
  hotel: z.unknown().optional(),
  availability: z.object({ checked: z.boolean().nullish() }).nullish(),
  address: z.string().nullish(),
  description: z.string().nullish(),
  amenities: z.array(z.string()).nullish(),
  photos: z.array(z.string()).nullish(),
  check_in_from: z.string().nullish(),
  check_out_until: z.string().nullish(),
  // A JSON string, often cut off mid-way with "…" (so not always parseable); read loosely.
  guest_summary: z.unknown().optional(),
  important_info: z.union([z.string(), z.array(z.string())]).nullish(),
  nearby: z.array(z.unknown()).nullish(),
});

export interface HotelsCasaDetailsQuery {
  check_in: string;
  check_out: string;
  adults: number;
  children_ages?: number[] | undefined;
}

/** One hotel from HotelsCasa: its details, plus its listing (prices, amenities, times) when it sent one. */
export interface HotelsCasaHotel {
  details: HotelDetails;
  listing?: HotelCandidate;
}

export interface HotelsCasaProvider extends HotelSearchProvider {
  /** Full details of one hotel (by the hotel_key a search returned), with its live price for the dates. */
  details(hotelKey: string, q: HotelsCasaDetailsQuery): Promise<HotelsCasaHotel>;
}

export function createHotelsCasaProvider(
  call: CallUpstream,
  opts: { maxPages?: number; widePages?: number; now?: () => Date } = {},
): HotelsCasaProvider {
  // Up to 10 hotels per page and at most 5 pages; wide searches (over 3 km) fetch more pages.
  const { maxPages = 2, widePages = 5, now = () => new Date() } = opts;

  const party = (q: Pick<HotelSearchQuery, "adults" | "children_ages">) => ({
    adults: q.adults,
    ...(q.children_ages?.length
      ? { children: q.children_ages.length, children_ages: q.children_ages.join(",") }
      : {}),
  });

  async function page(q: HotelSearchQuery, n: number) {
    const result = await call("search_hotels", {
      lat: q.lat,
      lng: q.lng,
      radius_km: Math.min(q.radius_km, MAX_RADIUS_KM),
      check_in: q.check_in,
      check_out: q.check_out,
      ...party(q),
      ...(q.prefer?.min_stars ? { stars_min: q.prefer.min_stars } : {}),
      lang: "en",
      sort: q.prefer?.sort === "price" ? "price" : q.prefer?.sort === "rating" ? "rating" : "recommended",
      limit: PAGE_SIZE,
      page: n,
    });
    if (result.isError) {
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        `HotelsCasa reported an error for this search${upstreamError(result)}`,
      );
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

  async function details(hotelKey: string, q: HotelsCasaDetailsQuery): Promise<HotelsCasaHotel> {
    const result = await call("get_hotel", {
      hotel_key: hotelKey,
      check_in: q.check_in,
      check_out: q.check_out,
      ...party(q),
      lang: "en",
    });
    const sc = result.structuredContent as { error?: unknown; message?: unknown } | undefined;
    if (sc?.error === "not_found") {
      throw new AppError("NOT_FOUND", `HotelsCasa has no hotel ${upstreamText(hotelKey)}`);
    }
    if (result.isError) {
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        `HotelsCasa reported an error for this hotel${upstreamError(result)}`,
      );
    }
    const payload = parseUpstream("hotelscasa", HotelPayload, result.structuredContent);
    if (payload.error) {
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        `HotelsCasa: ${upstreamText(payload.message || payload.error)}`,
      );
    }
    const fetchedAt = now().toISOString();
    const amenities = (payload.amenities ?? []).map((a) => a.trim()).filter(Boolean);
    const checkIn = payload.check_in_from?.trim();
    const checkOut = payload.check_out_until?.trim();
    const hotel = HotelItem.safeParse(payload.hotel);
    const listing: HotelCandidate | undefined = hotel.success
      ? {
          ...toCandidate(hotel.data, payload.availability?.checked === true, fetchedAt),
          ...(amenities.length ? { amenities } : {}),
          ...(checkIn ? { check_in_time: checkIn } : {}),
          ...(checkOut ? { check_out_time: checkOut } : {}),
        }
      : undefined;
    const photo = hotel.success ? hotel.data.photo_url : null;
    return { details: hotelDetails(payload, photo), ...(listing ? { listing } : {}) };
  }

  return {
    info: HOTELSCASA_INFO,
    search: async (q) => (await searchWithCoverage(q)).hotels,
    searchWithCoverage,
    details,
  };
}

// Keep one hotel's details readable for an agent, in line with the Google page (10 nearby places).
const MAX_NEARBY = 10;
const MAX_INFO = 8;
const MAX_DESCRIPTION = 1_500;
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** HotelsCasa's own error text (e.g. a daily limit on its side), sanitised, for sources_failed. */
function upstreamError(result: { content?: unknown }): string {
  const first = Array.isArray(result.content)
    ? (result.content[0] as { text?: unknown } | undefined)
    : undefined;
  const text = typeof first?.text === "string" ? first.text : "";
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    message = String(parsed.message ?? parsed.error ?? text);
  } catch {
    // Plain text.
  }
  return message ? `: ${upstreamText(message.replace(/^Error:\s*/, ""))}` : "";
}

function hotelDetails(p: z.infer<typeof HotelPayload>, photo: string | null | undefined): HotelDetails {
  const photos = (p.photos?.length ? p.photos : [photo])
    .map((u) => u?.trim())
    .filter((u): u is string => Boolean(u))
    .slice(0, MAX_IMAGES);
  const { pros, cons, categories } = guestSummary(p.guest_summary);
  const info = importantInfo(p.important_info).slice(0, MAX_INFO);
  const nearby = (p.nearby ?? []).flatMap(nearbyPlace).slice(0, MAX_NEARBY);
  return {
    ...(p.description?.trim() ? { description: clip(p.description.trim(), MAX_DESCRIPTION) } : {}),
    ...(p.address?.trim() ? { address: p.address.trim() } : {}),
    ...(photos.length ? { images: photos } : {}),
    ...(categories.length ? { category_scores: categories } : {}),
    ...(pros.length ? { pros } : {}),
    ...(cons.length ? { cons } : {}),
    ...(nearby.length ? { nearby_places: nearby } : {}),
    ...(info.length ? { important_info: info } : {}),
  };
}

/**
 * Pros, cons and category scores from `guest_summary`, a JSON string that HotelsCasa often cuts off with "…".
 * A complete string is parsed; a cut-off one keeps the lists and scores that arrived whole.
 */
export function guestSummary(raw: unknown): {
  pros: string[];
  cons: string[];
  categories: { name: string; score: number }[];
} {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      data = salvageSummary(raw);
    }
  }
  const o = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const strings = (v: unknown) =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
      : [];
  const categories = (Array.isArray(o.categories) ? o.categories : []).flatMap((c) => {
    const r = (c ?? {}) as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const score = typeof r.rating === "number" ? r.rating : typeof r.score === "number" ? r.score : null;
    return name && score !== null ? [{ name, score }] : [];
  });
  return { pros: strings(o.pros), cons: strings(o.cons), categories };
}

function salvageSummary(text: string): Record<string, unknown> {
  const list = (key: string): unknown => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*(\\[[^\\]]*\\])`));
    try {
      return m ? JSON.parse(m[1]!) : [];
    } catch {
      return [];
    }
  };
  const categories = [
    ...text.matchAll(/\{\s*"name"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"rating"\s*:\s*(-?\d+(?:\.\d+)?)/g),
  ].map((m) => ({ name: JSON.parse(m[1]!) as string, rating: Number(m[2]) }));
  return { pros: list("pros"), cons: list("cons"), categories };
}

/** `important_info` as separate notes: split on bullets, line breaks and sentence ends. */
function importantInfo(raw: string | string[] | null | undefined): string[] {
  const parts = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return parts
    .flatMap((t) => t.split(/\r?\n|(?:^|\s)[*•]\s+|(?<=[.!?])\s+(?=[A-Z¿¡ÁÉÍÓÚÑ*•])/))
    .map((t) => t.replace(/^[*•\s]+/, "").trim())
    .filter(Boolean);
}

/** A nearby place, when it has a name; its distance (if given) is kept as the travel note. */
function nearbyPlace(v: unknown): { name: string; travel?: string }[] {
  if (!v || typeof v !== "object") return [];
  const o = v as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return [];
  const travel =
    typeof o.distance === "string" && o.distance.trim()
      ? o.distance.trim()
      : typeof o.distance_km === "number"
        ? `${o.distance_km} km`
        : "";
  return [{ name, ...(travel ? { travel } : {}) }];
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
