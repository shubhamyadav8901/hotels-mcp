import { convertToInr, FX_INFO, type FxRates } from "../providers/fx.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { HotelSearchProvider, SearchOutcome } from "../providers/types.js";
import { toAppError } from "./errors.js";
import { haversineKm, roundTo } from "./geo.js";
import { cheapest, mergeCandidates, type MergedHotel } from "./merge.js";
import type { HotelCandidate, HotelSearchQuery, PriceQuote } from "./types.js";

export type SortKey = "distance" | "price" | "rating";

export interface SearchOptions {
  max_price_inr?: number | undefined;
  min_stars?: number | undefined;
  /** Minimum guest rating on a 0–10 scale; hotels with no rating are left out. */
  min_rating_10?: number | undefined;
  /** Keep hotels with no live price (e.g. OpenStreetMap-only listings). */
  include_unpriced?: boolean | undefined;
  sort: SortKey;
}

export interface SourceFailure {
  source: string;
  code: string;
  message: string;
}

export interface RankedHotel extends MergedHotel {
  distance_km: number;
  /** Lowest bookable price of any kind. */
  cheapest: PriceQuote | null;
}

export interface HotelSearchResult {
  /** Every matching hotel, sorted; callers paginate. */
  hotels: RankedHotel[];
  /** Hotels left out because no source had a live price for them (when include_unpriced is false). */
  unpriced_hidden: number;
  /** Hotels left out by min_rating_10 because no source rates them. */
  unrated_hidden: number;
  sources_ok: string[];
  sources_failed: SourceFailure[];
  /** What each answering source contributed, and what limited it (sources return limited pages). */
  coverage: SourceCoverage[];
  fx: { date: string; source: string } | null;
}

export interface SourceCoverage {
  source: string;
  /** Hotels it returned within the radius, and how many of those it priced. */
  hotels: number;
  priced: number;
  /** Furthest of its hotels from the search point (km); shows when a source only covers the centre. */
  max_km: number | null;
  note: string | null;
}

export interface HotelSearchDeps {
  registry: ProviderRegistry;
  providers: HotelSearchProvider[];
  fx: { rates(): Promise<FxRates> };
  /** Per-source time limit for one search; a slower source is reported as TIMEOUT. */
  deadlineMs?: number;
}

/** Queries every enabled hotel provider in parallel; a failing source never fails the whole search. */
export async function searchHotels(
  deps: HotelSearchDeps,
  q: HotelSearchQuery,
  opts: SearchOptions,
): Promise<HotelSearchResult> {
  const active = deps.providers.filter((p) => deps.registry.isEnabled(p.info.id));
  const settled = await Promise.allSettled(
    active.map((p) =>
      deps.registry.run(
        p.info.id,
        async (): Promise<SearchOutcome | { hotels: HotelCandidate[]; coverage_note: null }> =>
          p.searchWithCoverage ? p.searchWithCoverage(q) : { hotels: await p.search(q), coverage_note: null },
        deps.deadlineMs,
      ),
    ),
  );

  const candidates: HotelCandidate[] = [];
  const sources_ok: string[] = [];
  const sources_failed: SourceFailure[] = [];
  const coverage: SourceCoverage[] = [];
  settled.forEach((r, i) => {
    const id = active[i]!.info.id;
    if (r.status === "fulfilled") {
      sources_ok.push(id);
      candidates.push(...r.value.hotels);
      const inside = r.value.hotels.map((h) => haversineKm(q, h)).filter((km) => km <= q.radius_km);
      coverage.push({
        source: id,
        hotels: inside.length,
        priced: r.value.hotels.filter((h) => h.prices.length > 0 && haversineKm(q, h) <= q.radius_km).length,
        max_km: inside.length ? roundTo(Math.max(...inside), 1) : null,
        note: r.value.coverage_note,
      });
    } else {
      const e = toAppError(r.reason);
      sources_failed.push({ source: id, code: e.code, message: e.message });
    }
  });

  const { converted, fx } = await convertPrices(deps, candidates, sources_failed);
  let hotels: RankedHotel[] = mergeCandidates(converted)
    .map((h) => ({
      ...h,
      distance_km: roundTo(haversineKm(q, h), 2),
      cheapest: cheapest(h.prices),
    }))
    .filter((h) => h.distance_km <= q.radius_km);

  if (opts.max_price_inr !== undefined) {
    const max = opts.max_price_inr;
    hotels = hotels.filter((h) => h.cheapest !== null && (h.cheapest.per_night_inr as number) <= max);
  }
  let unrated_hidden = 0;
  if (opts.min_rating_10 !== undefined) {
    const min = opts.min_rating_10;
    // Count only hotels that would otherwise be shown (priced), not map-only listings.
    unrated_hidden = hotels.filter((h) => h.rating_10 === null && h.cheapest !== null).length;
    hotels = hotels.filter((h) => h.rating_10 !== null && h.rating_10 >= min);
  }
  if (opts.min_stars !== undefined) {
    const min = opts.min_stars;
    hotels = hotels.filter((h) => (h.stars ?? 0) >= min);
  }
  let unpriced_hidden = 0;
  if (!opts.include_unpriced) {
    const priced = hotels.filter((h) => h.cheapest !== null);
    unpriced_hidden = hotels.length - priced.length;
    hotels = priced;
  }
  hotels.sort(comparator(opts.sort));

  return {
    hotels,
    unpriced_hidden,
    unrated_hidden,
    sources_ok,
    sources_failed,
    coverage,
    fx: fx ? { date: fx.date, source: fx.source } : null,
  };
}

/** Returns copies of the candidates with `per_night_inr` filled in; provider data is never mutated. */
async function convertPrices(
  deps: HotelSearchDeps,
  candidates: HotelCandidate[],
  failures: SourceFailure[],
): Promise<{ converted: HotelCandidate[]; fx: FxRates | null }> {
  let fx: FxRates | null = null;
  if (candidates.some((c) => c.prices.some((p) => p.currency !== "INR"))) {
    try {
      fx = await deps.registry.run(FX_INFO.id, () => deps.fx.rates());
    } catch (err) {
      const e = toAppError(err);
      failures.push({
        source: FX_INFO.id,
        code: e.code,
        message: `${e.message}; non-INR prices left unconverted`,
      });
    }
  }
  const toInr = (p: PriceQuote): number | null => {
    if (p.currency === "INR") return Math.round(p.per_night);
    if (!fx) return null;
    try {
      return convertToInr(p.per_night, p.currency, fx);
    } catch {
      return null;
    }
  };
  const converted = candidates.map((c) => ({
    ...c,
    prices: c.prices.map((p) => ({ ...p, per_night_inr: toInr(p) })),
  }));
  return { converted, fx };
}

export function comparator(sort: SortKey): (a: RankedHotel, b: RankedHotel) => number {
  const price = (h: RankedHotel) => h.cheapest?.per_night_inr ?? Number.POSITIVE_INFINITY;
  switch (sort) {
    case "price":
      return (a, b) => price(a) - price(b) || a.distance_km - b.distance_km;
    case "rating":
      return (a, b) => (b.rating_10 ?? -1) - (a.rating_10 ?? -1) || a.distance_km - b.distance_km;
    case "distance":
      return (a, b) => a.distance_km - b.distance_km;
  }
}
