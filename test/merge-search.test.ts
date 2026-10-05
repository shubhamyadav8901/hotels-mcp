import { describe, expect, it } from "vitest";
import { AppError } from "../src/core/errors.js";
import { searchHotels, type HotelSearchDeps } from "../src/core/hotel-search.js";
import { isSameHotel, mergeCandidates, nameSimilarity } from "../src/core/merge.js";
import type { HotelCandidate, HotelSearchQuery, PriceQuote } from "../src/core/types.js";
import { FX_INFO } from "../src/providers/fx.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { HotelSearchProvider, ProviderInfo } from "../src/providers/types.js";

const T = "2026-10-05T10:00:00.000Z";

function price(
  source: string,
  per_night: number,
  currency = "INR",
  extra: Partial<PriceQuote> = {},
): PriceQuote {
  return {
    source,
    seller: null,
    per_night,
    total: null,
    currency,
    per_night_inr: null,
    includes_taxes: null,
    available: null,
    refundable: null,
    url: null,
    room: null,
    fetched_at: T,
    ...extra,
  };
}

function hotel(
  source: string,
  id: string,
  name: string,
  lat: number,
  lng: number,
  prices: PriceQuote[] = [],
) {
  const h: HotelCandidate = {
    source,
    source_id: id,
    name,
    lat,
    lng,
    stars: null,
    rating_10: null,
    review_count: null,
    url: null,
    prices,
    fetched_at: T,
  };
  return h;
}

describe("hotel matching", () => {
  it("treats brand-prefixed variants of the same name as similar", () => {
    expect(nameSimilarity("Hotel Sunrise by OYO", "OYO 1234 Sunrise Hotel")).toBe(1);
    expect(nameSimilarity("Sunrise Residency New Delhi", "Sunrise Residency")).toBe(1);
    expect(nameSimilarity("Sunrise Residency", "Moonlight Residency")).toBe(0.5);
  });

  it("does not let a one-word name match a longer different name", () => {
    expect(nameSimilarity("Hotel Krishna", "Krishna Palace Inn")).toBeLessThan(0.5);
    expect(nameSimilarity("Hotel Krishna", "Krishna")).toBe(1);
    const a = { name: "Hotel Krishna", lat: 28.6435, lng: 77.2175 };
    expect(isSameHotel(a, { name: "Krishna Palace Inn", lat: 28.6436, lng: 77.2176 })).toBe(false);
  });

  it("matches only nearby listings with similar names", () => {
    const a = { name: "Sunrise Residency", lat: 28.6435, lng: 77.2175 };
    expect(isSameHotel(a, { name: "Hotel Sunrise Residency", lat: 28.644, lng: 77.218 })).toBe(true);
    // Same name but 1 km away: a different branch.
    expect(isSameHotel(a, { name: "Sunrise Residency", lat: 28.6525, lng: 77.2175 })).toBe(false);
    // Next door with a different name: a different hotel.
    expect(isSameHotel(a, { name: "Moonlight Palace", lat: 28.6436, lng: 77.2176 })).toBe(false);
  });

  it("merges across sources, keeping every price and the better-supported rating", () => {
    const t = {
      ...hotel("trivago", "t1", "Sunrise Residency", 28.6435, 77.2175, [price("trivago", 3000)]),
      rating_10: 8.1,
      review_count: 1200,
    };
    const h = {
      ...hotel("hotelscasa", "h1", "Hotel Sunrise Residency", 28.6436, 77.2176, [
        price("hotelscasa", 30, "EUR"),
      ]),
      rating_10: 7.0,
      review_count: 10,
      stars: 3,
    };
    const [m, ...rest] = mergeCandidates([t, h]);
    expect(rest).toHaveLength(0);
    expect(m).toMatchObject({
      hotel_id: "trivago:t1",
      also_ids: ["hotelscasa:h1"],
      sources: ["trivago", "hotelscasa"],
      rating_10: 8.1,
      stars: 3,
    });
    expect(m?.prices).toHaveLength(2);
  });

  it("merges a source's own duplicate listing only on the same spot with the same name", () => {
    // Live, Kochi: HotelsCasa listed Sidra Pristine twice, 20 m apart, "and" vs "&".
    const merged = mergeCandidates([
      hotel("hotelscasa", "a", "Sidra Pristine Hotel and Portico Halls", 9.9934, 76.2874, [
        price("hotelscasa", 40),
      ]),
      hotel("hotelscasa", "b", "Sidra Pristine Hotel & Portico Halls", 9.9934, 76.2872, [
        price("hotelscasa", 45),
      ]),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ sources: ["hotelscasa"], also_ids: ["hotelscasa:b"] });
    expect(merged[0]!.prices).toHaveLength(2);

    // Different names on one spot, or the same name 100 m apart, stay separate.
    expect(
      mergeCandidates([
        hotel("trivago", "a", "Sunrise Residency", 28.6435, 77.2175),
        hotel("trivago", "b", "Sunrise Palace", 28.6435, 77.2175),
      ]),
    ).toHaveLength(2);
    expect(
      mergeCandidates([
        hotel("trivago", "a", "Sunrise Residency", 28.6435, 77.2175),
        hotel("trivago", "b", "Sunrise Residency", 28.6444, 77.2175),
      ]),
    ).toHaveLength(2);
  });

  it("joins a listing to the nearer of two same-named hotels", () => {
    const merged = mergeCandidates([
      hotel("trivago", "a", "Sunrise Residency", 28.6435, 77.2175),
      hotel("trivago", "b", "Sunrise Residency", 28.6444, 77.2175),
      hotel("serpapi", "g", "Sunrise Residency", 28.6443, 77.2175),
    ]);
    expect(merged.map((m) => [m.hotel_id, m.also_ids])).toEqual([
      ["trivago:a", []],
      ["trivago:b", ["serpapi:g"]],
    ]);
  });

  it("matches an identical multi-word name a few hundred metres apart across sources, not a similar one", () => {
    // Live, Kochi: Google and trivago placed these 200–280 m apart.
    const royal = { name: "Royal Casa Cochin", lat: 9.968499, lng: 76.28924 };
    expect(isSameHotel(royal, { name: "ROYAL CASA COCHIN", lat: 9.9708557, lng: 76.2884019 })).toBe(true);
    const anupam = { name: "Anupam Residency", lat: 9.9711885, lng: 76.2869971 };
    expect(isSameHotel(anupam, { name: "Anupam Residency", lat: 9.97268, lng: 76.28601 })).toBe(true);
    // Similar but not identical, or a one-word name, needs the usual 150 m.
    expect(isSameHotel(royal, { name: "Royal Casa Residency", lat: 9.9708557, lng: 76.2884019 })).toBe(false);
    expect(
      isSameHotel(
        { name: "Hotel Krishna", lat: 9.9685, lng: 76.2892 },
        { name: "Krishna", lat: 9.9709, lng: 76.2884 },
      ),
    ).toBe(false);
    // A number or brand word the comparison ignores keeps the usual 150 m: numbered branches, franchises.
    expect(
      isSameHotel(
        { name: "Hotel Sai Palace 1", lat: 9.9685, lng: 76.2892 },
        { name: "Hotel Sai Palace 2", lat: 9.9709, lng: 76.2884 },
      ),
    ).toBe(false);
    expect(
      isSameHotel(
        { name: "OYO 1234 Sunrise Residency", lat: 9.9685, lng: 76.2892 },
        { name: "Sunrise Residency", lat: 9.9709, lng: 76.2884 },
      ),
    ).toBe(false);
    // Beyond 500 m, no match.
    expect(isSameHotel(royal, { name: "Royal Casa Cochin", lat: 9.975, lng: 76.2892 })).toBe(false);
  });
});

describe("searchHotels", () => {
  const q: HotelSearchQuery = {
    lat: 28.643,
    lng: 77.2194,
    radius_km: 2,
    check_in: "2026-11-10",
    check_out: "2026-11-11",
    adults: 2,
  };
  const info = (id: string): ProviderInfo => ({
    id,
    name: id,
    kind: "hotel-prices",
    official: false,
    needsKey: false,
    limitations: [],
  });
  const provider = (id: string, fn: () => Promise<HotelCandidate[]>): HotelSearchProvider => ({
    info: info(id),
    search: fn,
  });
  const fx = {
    rates: async () => ({ toInr: { INR: 1, EUR: 100 }, date: "2026-10-02", source: "frankfurter" }),
  };

  function deps(providers: HotelSearchProvider[], disabled: string[] = []): HotelSearchDeps {
    const registry = new ProviderRegistry(disabled);
    providers.forEach((p) => registry.register(p.info));
    registry.register(FX_INFO);
    return { registry, providers, fx };
  }

  const near = hotel("a", "1", "Near Inn", 28.6435, 77.2194, [price("a", 4000)]);
  const cheapFar = hotel("b", "2", "Budget Lodge", 28.652, 77.2194, [
    price("b", 15, "EUR", { available: true }),
  ]);
  const outside = hotel("a", "3", "Far Away Hotel", 28.7, 77.2194, [price("a", 1000)]);

  it("converts to INR, filters by radius and sorts by price", async () => {
    const d = deps([provider("a", async () => [near, outside]), provider("b", async () => [cheapFar])]);
    const r = await searchHotels(d, q, { sort: "price" });
    expect(r.hotels.map((h) => h.name)).toEqual(["Budget Lodge", "Near Inn"]);
    expect(r.hotels[0]?.cheapest).toMatchObject({ per_night_inr: 1500, currency: "EUR", per_night: 15 });
    expect(r.hotels).toHaveLength(2);
    expect(r.fx).toEqual({ date: "2026-10-02", source: "frankfurter" });
    expect(d.registry.status().find((x) => x.id === "frankfurter")?.last_success_at).not.toBeNull();
  });

  it("filters by minimum guest rating, leaving out and counting unrated hotels", async () => {
    const rated = { ...near, rating_10: 6.4, review_count: 10 };
    const low = { ...hotel("a", "9", "Low Rated", 28.644, 77.2194, [price("a", 900)]), rating_10: 5.8 };
    const unrated = hotel("a", "8", "No Reviews", 28.6436, 77.2196, [price("a", 800)]);
    const d = deps([provider("a", async () => [rated, low, unrated])]);
    const r = await searchHotels(d, q, { sort: "price", min_rating_10: 6 });
    expect(r.hotels.map((h) => h.name)).toEqual(["Near Inn"]);
    expect(r.unrated_hidden).toBe(1);
    // Map-only listings (no price) are not counted as "left out for having no rating".
    const withOsm = deps([
      provider("a", async () => [rated, unrated, hotel("osm", "1", "Map Only", 28.6437, 77.2197)]),
    ]);
    const r2 = await searchHotels(withOsm, q, { sort: "price", min_rating_10: 6, include_unpriced: true });
    expect(r2.unrated_hidden).toBe(1);
  });

  it("returns partial results and names the failed source", async () => {
    const d = deps([
      provider("a", async () => [near]),
      provider("b", async () => {
        throw new AppError("UPSTREAM_UNAVAILABLE", "b is down");
      }),
    ]);
    const r = await searchHotels(d, q, { sort: "distance" });
    expect(r.hotels).toHaveLength(1);
    expect(r.sources_ok).toEqual(["a"]);
    expect(r.sources_failed).toEqual([{ source: "b", code: "UPSTREAM_UNAVAILABLE", message: "b is down" }]);
  });

  it("skips disabled providers without calling them", async () => {
    let called = false;
    const d = deps(
      [provider("a", async () => [near]), provider("b", async () => ((called = true), [cheapFar]))],
      ["b"],
    );
    const r = await searchHotels(d, q, { sort: "distance" });
    expect(called).toBe(false);
    expect(r.sources_ok).toEqual(["a"]);
  });

  it("leaves foreign prices unconverted (not guessed) when FX is down, and applies the price cap only to known INR prices", async () => {
    const d = deps([provider("a", async () => [near]), provider("b", async () => [cheapFar])]);
    d.fx = {
      rates: async () => {
        throw new AppError("UPSTREAM_UNAVAILABLE", "fx down");
      },
    };
    const r = await searchHotels(d, q, { sort: "distance", max_price_inr: 5000 });
    expect(r.hotels.map((h) => h.name)).toEqual(["Near Inn"]);
    expect(r.sources_failed[0]).toMatchObject({ source: "frankfurter" });
  });
});
