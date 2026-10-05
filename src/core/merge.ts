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
/**
 * Sources place the same hotel up to a few hundred metres apart (Google vs trivago: 200–280 m for "Anupam
 * Residency" and "Royal Casa Cochin" in Kochi), so an identical name of two or more distinctive words matches
 * further out than a merely similar one.
 */
const SAME_NAME_KM = 0.5;

/** True when two listings are very likely the same property. */
export function isSameHotel(a: { name: string; lat: number; lng: number }, b: typeof a): boolean {
  const km = haversineKm(a, b);
  if (km > SAME_NAME_KM) return false;
  const sim = nameSimilarity(a.name, b.name);
  if (km > NEAR_KM) return sim === 1 && sameDistinctiveName(a.name, b.name);
  return sim >= 0.8 || (km <= SAME_SPOT_KM && sim >= 0.5);
}

// Brand words that nameTokens drops: names that differ only by them (or by a number) can be different
// franchises or numbered branches ("OYO 1234 Sunrise Residency", "Hotel Sai Palace 2").
const BRANDS = new Set([
  "oyo",
  "fabhotel",
  "fabhotels",
  "treebo",
  "townhouse",
  "collection",
  "flagship",
  "capital",
]);

/**
 * Both names reduce to the same two or more distinctive words ("Royal Casa Cochin" = "ROYAL CASA COCHIN"), and
 * neither carries a number or brand word that the comparison would ignore.
 */
function sameDistinctiveName(a: string, b: string): boolean {
  const hidden = (n: string) =>
    /\d/.test(n) ||
    n
      .toLowerCase()
      .split(/[^a-z]+/)
      .some((t) => BRANDS.has(t));
  if (hidden(a) || hidden(b)) return false;
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  return ta.size >= 2 && ta.size === tb.size && [...ta].every((t) => tb.has(t));
}

export function mergeCandidates(candidates: HotelCandidate[]): MergedHotel[] {
  const merged: MergedHotel[] = [];
  for (const c of candidates) {
    const id = `${c.source}:${c.source_id}`;
    // A source can list one hotel twice (HotelsCasa: "Sidra Pristine Hotel and Portico Halls" and "… & Portico
    // Halls", 20 m apart); its own listings merge only when on the same spot with the same distinctive name.
    // The nearest qualifying hotel, so a listing joins the right one of two same-named neighbours.
    let match: MergedHotel | undefined;
    let best = Infinity;
    for (const m of merged) {
      const km = haversineKm(m, c);
      const same = m.sources.includes(c.source)
        ? km <= SAME_SPOT_KM && sameDistinctiveName(m.name, c.name)
        : isSameHotel(m, c);
      if (same && km < best) {
        match = m;
        best = km;
      }
    }
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
    if (!match.sources.includes(c.source)) match.sources.push(c.source);
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
