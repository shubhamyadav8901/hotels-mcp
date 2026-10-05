import { haversineKm } from "./geo.js";
import type { HotelCandidate, PriceQuote } from "./types.js";

/** One hotel after merging every source that describes it. */
export interface MergedHotel {
  /** `source:source_id` of the first source; any id in `also_ids` resolves to the same hotel. */
  hotel_id: string;
  also_ids: string[];
  name: string;
  lat: number;
  lng: number;
  stars: number | null;
  rating_10: number | null;
  review_count: number | null;
  sources: string[];
  prices: PriceQuote[];
}

// Words that carry no identity: generic lodging terms, brand prefixes and Indian city names that
// sources append inconsistently ("Hotel X by OYO" vs "OYO 1234 Hotel X", "X New Delhi" vs "X").
// prettier-ignore
const STOPWORDS = new Set([
  "hotel", "hotels", "the", "by", "and", "a", "an", "of", "at", "in", "near", "oyo", "fabhotel",
  "fabhotels", "treebo", "trend", "collection", "townhouse", "flagship", "capital", "o", "new", "delhi",
  "mumbai", "bengaluru", "bangalore", "kolkata", "chennai", "hyderabad", "india",
]);

export function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t && !STOPWORDS.has(t) && !/^\d+$/.test(t)),
  );
}

/**
 * Name similarity (0–1): the share of the shorter name's distinctive tokens found in the longer one, so
 * "Sunrise Residency" ≈ "Hotel Sunrise Residency New Delhi". A single-token name must match exactly, so
 * "Hotel Krishna" does not swallow "Krishna Palace Inn" next door.
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  if (Math.min(ta.size, tb.size) === 1)
    return ta.size === tb.size && common === 1 ? 1 : common / Math.max(ta.size, tb.size);
  return common / Math.min(ta.size, tb.size);
}

const NEAR_KM = 0.15;
const SAME_SPOT_KM = 0.04;

/** True when two listings are very likely the same property. */
export function isSameHotel(a: { name: string; lat: number; lng: number }, b: typeof a): boolean {
  const km = haversineKm(a, b);
  if (km > NEAR_KM) return false;
  const sim = nameSimilarity(a.name, b.name);
  return sim >= 0.8 || (km <= SAME_SPOT_KM && sim >= 0.5);
}

export function mergeCandidates(candidates: HotelCandidate[]): MergedHotel[] {
  const merged: MergedHotel[] = [];
  for (const c of candidates) {
    const id = `${c.source}:${c.source_id}`;
    const match = merged.find((m) => !m.sources.includes(c.source) && isSameHotel(m, c));
    if (!match) {
      merged.push({
        hotel_id: id,
        also_ids: [],
        name: c.name,
        lat: c.lat,
        lng: c.lng,
        stars: c.stars,
        rating_10: c.rating_10,
        review_count: c.review_count,
        sources: [c.source],
        prices: [...c.prices],
      });
      continue;
    }
    match.also_ids.push(id);
    match.sources.push(c.source);
    match.prices.push(...c.prices);
    match.stars ??= c.stars;
    // Keep the rating backed by more reviews.
    if (c.rating_10 !== null && (c.review_count ?? 0) > (match.review_count ?? 0)) {
      match.rating_10 = c.rating_10;
      match.review_count = c.review_count;
    } else {
      match.rating_10 ??= c.rating_10;
    }
  }
  return merged;
}

export function cheapest(prices: PriceQuote[]): PriceQuote | null {
  let best: PriceQuote | null = null;
  for (const p of prices) {
    if (p.per_night_inr === null || p.available === false) continue;
    if (!best || p.per_night_inr < (best.per_night_inr as number)) best = p;
  }
  return best;
}
