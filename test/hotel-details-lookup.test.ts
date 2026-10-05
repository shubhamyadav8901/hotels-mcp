import { describe, expect, it, vi } from "vitest";
import { HotelMemory } from "../src/core/hotel-memory.js";
import type { HotelCandidate, PriceQuote } from "../src/core/types.js";
import { FX_INFO } from "../src/providers/fx.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { HotelSearchProvider } from "../src/providers/types.js";
import { XOTELO_INFO } from "../src/providers/xotelo.js";
import { connect, testDeps, offers } from "./helpers.js";

const T = "2026-10-05T10:00:00.000Z";
const quote = (source: string, per_night: number, extra: Partial<PriceQuote> = {}): PriceQuote => ({
  source,
  seller: `${source}-seller`,
  per_night,
  total: null,
  currency: "INR",
  per_night_inr: per_night,
  includes_taxes: null,
  available: null,
  refundable: null,
  url: null,
  room: null,
  fetched_at: T,
  ...extra,
});
const provider = (id: string, search: HotelSearchProvider["search"]): HotelSearchProvider => ({
  info: { id, name: id, kind: "hotel-prices", official: true, needsKey: false, limitations: [] },
  search,
});

describe("get_hotel_details fallback to search prices", () => {
  it("get_hotel_details falls back to the search's prices when the live re-check misses the hotel", async () => {
    let calls = 0;
    // Lists the hotel only on the first (search) call, like trivago's fixed 25 results around a point.
    const tv = provider(
      "trivago",
      vi.fn(async () =>
        calls++ === 0
          ? [
              {
                source: "trivago",
                source_id: "h1",
                name: "Sunrise Residency",
                lat: 28.6435,
                lng: 77.2194,
                stars: 3,
                rating_10: 8,
                review_count: 10,
                url: null,
                fetched_at: T,
                prices: [{ ...quote("trivago", 3000), per_night_inr: null }],
              },
            ]
          : [],
      ),
    );
    const registry = new ProviderRegistry();
    [tv.info, FX_INFO, XOTELO_INFO].forEach((i) => registry.register(i));
    const c = await connect(
      testDeps({
        registry,
        hotelProviders: [tv],
        memory: new HotelMemory(),
        xotelo: { info: XOTELO_INFO, rates: vi.fn(async () => []) },
        now: () => new Date(T),
      }),
    );
    const dates = { check_in: "2026-11-10", check_out: "2026-11-11", adults: 4 };
    const s = await c.callTool({ name: "search_hotels", arguments: { lat: 28.643, lng: 77.2194, ...dates } });
    const id = (s.structuredContent as { hotels: { hotel_id: string }[] }).hotels[0]!.hotel_id;
    const r = await c.callTool({ name: "get_hotel_details", arguments: { hotel_id: id, ...dates } });
    expect(r.isError).toBeFalsy();
    const out = r.structuredContent as { prices: { per_night_inr: number }[]; notes: string[] };
    expect(offers(out)[0]).toMatchObject({ per_night_inr: 3000 });
    expect(out.notes.join(" ")).toMatch(/prices from the search/);
    // A different party or dates does not reuse those prices.
    const other = await c.callTool({
      name: "get_hotel_details",
      arguments: { hotel_id: id, ...dates, adults: 2 },
    });
    expect(other.isError).toBe(true);
  });
});

describe("trivago name lookup in get_hotel_details", () => {
  const listing = (price: number): HotelCandidate => ({
    source: "trivago",
    source_id: "h1",
    name: "Sunrise Residency",
    lat: 28.6435,
    lng: 77.2194,
    stars: 3,
    rating_10: 8,
    review_count: 10,
    url: null,
    fetched_at: T,
    prices: [{ ...quote("trivago", price), per_night_inr: null }],
  });

  it("prefers a live trivago price by name over the search's remembered one when the re-check misses the hotel", async () => {
    let n = 0;
    const tv = provider(
      "trivago",
      vi.fn(async () => (n++ === 0 ? [listing(3000)] : [])),
    );
    const registry = new ProviderRegistry();
    [tv.info, FX_INFO, XOTELO_INFO].forEach((i) => registry.register(i));
    const { TRIVAGO_INFO } = await import("../src/providers/trivago.js");
    const c = await connect(
      testDeps({
        registry,
        hotelProviders: [tv],
        memory: new HotelMemory(),
        now: () => new Date(T),
        xotelo: { info: XOTELO_INFO, rates: vi.fn(async () => []) },
        trivago: {
          info: TRIVAGO_INFO,
          lookup: vi.fn(async () => ({
            ...listing(3300),
            rating_10: 9,
            url: "https://example.invalid/tv/h1",
          })),
        },
      }),
    );
    const d = { check_in: "2026-11-10", check_out: "2026-11-11", adults: 4 };
    const s = await c.callTool({ name: "search_hotels", arguments: { lat: 28.643, lng: 77.2194, ...d } });
    const id = (s.structuredContent as { hotels: { hotel_id: string }[] }).hotels[0]!.hotel_id;
    const r = await c.callTool({ name: "get_hotel_details", arguments: { hotel_id: id, ...d } });
    const prices = offers(r.structuredContent);
    expect(prices.filter((p) => p.source === "trivago").map((p) => p.per_night_inr)).toEqual([3300]);
    // The trivago section takes its details from the listing the name lookup found.
    const tvSection = (r.structuredContent as { sources: Record<string, unknown>[] }).sources.find(
      (x) => x.source === "trivago",
    );
    expect(tvSection).toMatchObject({ source_id: "h1", rating_10: 9, url: "https://example.invalid/tv/h1" });
  });
});

describe("trivago lookup with ids from the original search", () => {
  it("looks trivago up by name when another source finds the hotel on the re-check but trivago doesn't", async () => {
    let tvCalls = 0;
    const tv = provider(
      "trivago",
      vi.fn(async () =>
        tvCalls++ === 0
          ? [
              {
                source: "trivago",
                source_id: "tv1",
                name: "Sunrise Residency",
                lat: 28.6435,
                lng: 77.2194,
                stars: 3,
                rating_10: 8,
                review_count: 10,
                url: null,
                fetched_at: T,
                prices: [{ ...quote("trivago", 3000), per_night_inr: null }],
              },
            ]
          : [],
      ),
    );
    const casa = provider(
      "hotelscasa",
      vi.fn(async () => [
        {
          source: "hotelscasa",
          source_id: "hc1",
          name: "Hotel Sunrise Residency",
          lat: 28.6436,
          lng: 77.2195,
          stars: 3,
          rating_10: 8,
          review_count: 5,
          url: null,
          fetched_at: T,
          prices: [
            { ...quote("hotelscasa", 4200, { room: "Family Room", available: true }), per_night_inr: null },
          ],
        },
      ]),
    );
    const lookup = vi.fn(async () => ({
      source: "trivago",
      source_id: "tv1",
      name: "Sunrise Residency",
      lat: 28.6435,
      lng: 77.2194,
      stars: 3,
      rating_10: 8,
      review_count: 10,
      url: null,
      fetched_at: T,
      prices: [{ ...quote("trivago", 3100), per_night_inr: null }],
    }));
    const registry = new ProviderRegistry();
    [tv.info, casa.info, FX_INFO, XOTELO_INFO].forEach((i) => registry.register(i));
    const { TRIVAGO_INFO } = await import("../src/providers/trivago.js");
    const c = await connect(
      testDeps({
        registry,
        hotelProviders: [tv, casa],
        memory: new HotelMemory(),
        now: () => new Date(T),
        xotelo: { info: XOTELO_INFO, rates: vi.fn(async () => []) },
        trivago: { info: TRIVAGO_INFO, lookup },
      }),
    );
    const d = { check_in: "2026-11-10", check_out: "2026-11-11", adults: 4 };
    const s = await c.callTool({ name: "search_hotels", arguments: { lat: 28.643, lng: 77.2194, ...d } });
    const id = (s.structuredContent as { hotels: { hotel_id: string }[] }).hotels[0]!.hotel_id;
    expect(id).toBe("trivago:tv1");
    const r = await c.callTool({ name: "get_hotel_details", arguments: { hotel_id: id, ...d } });
    const out = r.structuredContent as {
      prices: { source: string; per_night_inr: number }[];
      cheapest_inr: number | null;
    };
    expect(lookup).toHaveBeenCalledWith(
      "tv1",
      expect.any(String),
      undefined,
      expect.objectContaining({ adults: 4 }),
    );
    expect(offers(out).map((p) => [p.source, p.per_night_inr])).toEqual([
      ["trivago", 3100],
      ["hotelscasa", 4200],
    ]);
    expect(out.cheapest_inr).toBe(3100);
  });
});

describe("get_hotel_details timing", () => {
  it("starts the trivago party lookup alongside the re-search, not after it", async () => {
    const events: string[] = [];
    const tvListing = (prices: PriceQuote[]): HotelCandidate => ({
      source: "trivago",
      source_id: "tv1",
      name: "Sunrise Residency",
      lat: 28.6435,
      lng: 77.2194,
      stars: 3,
      rating_10: 8,
      review_count: 10,
      url: null,
      fetched_at: T,
      prices,
    });
    // The search lists the hotel at trivago without a price, so get_hotel_details starts trivago's party
    // lookup before the re-search.
    let first = true;
    const tv = provider(
      "trivago",
      vi.fn(async () => {
        if (first) return ((first = false), [tvListing([])]);
        events.push("re-search start");
        await new Promise((r) => setTimeout(r, 50));
        events.push("re-search end");
        return [];
      }),
    );
    const casa = provider(
      "hotelscasa",
      vi.fn(async () => [
        {
          ...tvListing([{ ...quote("hotelscasa", 4200, { available: true }), per_night_inr: null }]),
          source: "hotelscasa",
          source_id: "hc1",
        },
      ]),
    );
    const lookup = vi.fn(async (_id: string, _n: string, _c: string | undefined, q: { adults: number }) => {
      events.push(`lookup ${q.adults}`);
      return tvListing([{ ...quote("trivago", 3800), per_night_inr: null }]);
    });
    const registry = new ProviderRegistry();
    [tv.info, casa.info, FX_INFO, XOTELO_INFO].forEach((i) => registry.register(i));
    const { TRIVAGO_INFO } = await import("../src/providers/trivago.js");
    const c = await connect(
      testDeps({
        registry,
        hotelProviders: [tv, casa],
        memory: new HotelMemory(),
        now: () => new Date(T),
        xotelo: { info: XOTELO_INFO, rates: vi.fn(async () => []) },
        trivago: { info: TRIVAGO_INFO, lookup },
      }),
    );
    const d = { check_in: "2026-11-10", check_out: "2026-11-11", adults: 4 };
    const s = await c.callTool({ name: "search_hotels", arguments: { lat: 28.643, lng: 77.2194, ...d } });
    const hotel = (s.structuredContent as { hotels: { hotel_id: string; also_ids: string[] }[] }).hotels[0]!;
    expect([hotel.hotel_id, ...hotel.also_ids]).toContain("trivago:tv1");
    const r = await c.callTool({ name: "get_hotel_details", arguments: { hotel_id: hotel.hotel_id, ...d } });
    const end = events.indexOf("re-search end");
    const party = events.indexOf("lookup 4");
    expect(end).toBeGreaterThan(0);
    expect(party).toBeGreaterThanOrEqual(0);
    expect(party).toBeLessThan(end);
    const prices = offers(r.structuredContent);
    expect(prices.find((p) => p.source === "trivago")?.per_night_inr).toBe(3800);
  });
});
