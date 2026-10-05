import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/core/errors.js";
import { HotelMemory } from "../src/core/hotel-memory.js";
import type { HotelCandidate, PriceQuote } from "../src/core/types.js";
import { FX_INFO } from "../src/providers/fx.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { TRIVAGO_INFO } from "../src/providers/trivago.js";
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
  per_night_inr: null,
  includes_taxes: null,
  available: null,
  refundable: null,
  url: null,
  room: null,
  fetched_at: T,
  ...extra,
});
const listing = (
  source: string,
  id: string,
  prices: PriceQuote[],
  extra: Partial<HotelCandidate> = {},
): HotelCandidate => ({
  source,
  source_id: id,
  name: "Sunrise Residency",
  lat: 28.6435,
  lng: 77.2194,
  stars: 3,
  rating_10: 8,
  review_count: 10,
  url: null,
  fetched_at: T,
  prices,
  ...extra,
});
const provider = (id: string, search: HotelSearchProvider["search"]): HotelSearchProvider => ({
  info: { id, name: id, kind: "hotel-prices", official: true, needsKey: false, limitations: [] },
  search,
});
const stay = { check_in: "2026-11-10", check_out: "2026-11-11", adults: 4 };

describe("get_hotel_rates regressions", () => {
  it("uses the search's prices when the re-check finds only a similar-named unpriced listing nearby", async () => {
    let tvCalls = 0;
    const tv = provider("trivago", async () =>
      tvCalls++ === 0
        ? [
            listing("trivago", "tv1", [quote("trivago", 3000, { seller: "Agoda" })], {
              name: "Cochin Hotel Inn",
              lat: 9.969,
              lng: 76.291,
            }),
          ]
        : [],
    );
    let osmCalls = 0;
    // Another source lists a different property ~20 m away with a similar name and no prices, only on the re-check.
    const osm = provider("osm_lodging", async () =>
      osmCalls++ === 0
        ? []
        : [listing("osm_lodging", "n9", [], { name: "NEW COCHIN INN HOMESTAY", lat: 9.9691, lng: 76.2911 })],
    );
    const lookup = vi.fn(async () => null);
    const registry = new ProviderRegistry();
    [tv.info, osm.info, FX_INFO, XOTELO_INFO].forEach((i) => registry.register(i));
    const c = await connect(
      testDeps({
        registry,
        hotelProviders: [tv, osm],
        memory: new HotelMemory(),
        xotelo: { info: XOTELO_INFO, rates: vi.fn(async () => []) },
        trivago: { info: TRIVAGO_INFO, lookup },
        now: () => new Date(T),
      }),
    );
    const s = await c.callTool({ name: "search_hotels", arguments: { lat: 9.969, lng: 76.291, ...stay } });
    const id = (s.structuredContent as { hotels: { hotel_id: string }[] }).hotels[0]!.hotel_id;
    expect(id).toBe("trivago:tv1");
    const r = await c.callTool({ name: "get_hotel_rates", arguments: { hotel_id: id, ...stay } });
    expect(r.isError).toBeFalsy();
    const out = r.structuredContent as {
      prices: { source: string; per_night_inr: number }[];
      notes: string[];
    };
    expect(offers(out).map((p) => [p.source, p.per_night_inr])).toEqual([["trivago", 3000]]);
    expect(out.notes.join("\n")).toMatch(/prices from the search/);
    expect(lookup).toHaveBeenCalled();
    for (const call of lookup.mock.calls as unknown as [string, string][]) {
      expect(call[0]).toBe("tv1");
      expect(call[1]).toBe("Cochin Hotel Inn");
    }
  });

  it("answers for the hotel asked about when the re-check finds it under another source's listing", async () => {
    // Live, Thiruvananthapuram: trivago's "ROYAL INN" (7.5, 633 reviews) came back as Google's "Treebo Trip
    // Royal Inn" (7.6, 66 reviews) with Google's id when trivago's re-check missed it.
    let tvCalls = 0;
    const tv = provider("trivago", async () =>
      tvCalls++ === 0
        ? [
            listing("trivago", "tv1", [quote("trivago", 3000, { seller: "Agoda" })], {
              name: "ROYAL INN",
              rating_10: 7.5,
              review_count: 633,
            }),
          ]
        : [],
    );
    let gCalls = 0;
    const google = provider("serpapi", async () =>
      gCalls++ === 0
        ? []
        : [
            listing("serpapi", "g1", [quote("serpapi", 3300, { seller: "Booking.com" })], {
              name: "Treebo Trip Royal Inn",
              lat: 28.6436,
              rating_10: 7.6,
              review_count: 66,
            }),
          ],
    );
    const registry = new ProviderRegistry();
    [tv.info, google.info, FX_INFO, XOTELO_INFO].forEach((i) => registry.register(i));
    const c = await connect(
      testDeps({
        registry,
        hotelProviders: [tv, google],
        memory: new HotelMemory(),
        xotelo: { info: XOTELO_INFO, rates: vi.fn(async () => []) },
        trivago: { info: TRIVAGO_INFO, lookup: vi.fn(async () => null) },
        now: () => new Date(T),
      }),
    );
    const s = await c.callTool({ name: "search_hotels", arguments: { lat: 28.643, lng: 77.2194, ...stay } });
    const id = (s.structuredContent as { hotels: { hotel_id: string }[] }).hotels[0]!.hotel_id;
    expect(id).toBe("trivago:tv1");
    const r = await c.callTool({ name: "get_hotel_rates", arguments: { hotel_id: id, ...stay } });
    const out = r.structuredContent as {
      hotel: { hotel_id: string; also_ids: string[]; name: string; rating_10: number; review_count: number };
      notes: string[];
    };
    expect(out.hotel).toMatchObject({
      hotel_id: "trivago:tv1",
      name: "ROYAL INN",
      rating_10: 7.5,
      review_count: 633,
    });
    expect(out.hotel.also_ids).toContain("serpapi:g1");
    expect(out.notes.join("\n")).toMatch(/lists this hotel as "Treebo Trip Royal Inn"/);
    // The same id keeps resolving to the same hotel.
    const again = await c.callTool({ name: "get_hotel_rates", arguments: { hotel_id: id, ...stay } });
    expect((again.structuredContent as { hotel: { name: string } }).hotel.name).toBe("ROYAL INN");
  });

  it("reports an exchange-rate failure from a direct lookup as source fx", async () => {
    let tvCalls = 0;
    const tv = provider("trivago", async () =>
      tvCalls++ === 0 ? [listing("trivago", "tv1", [quote("trivago", 3000, { seller: "Agoda" })])] : [],
    );
    const lookup = vi.fn(async () =>
      listing("trivago", "tv1", [quote("trivago", 40, { seller: "Agoda", currency: "EUR" })]),
    );
    const registry = new ProviderRegistry();
    [tv.info, FX_INFO, XOTELO_INFO].forEach((i) => registry.register(i));
    const c = await connect(
      testDeps({
        registry,
        hotelProviders: [tv],
        memory: new HotelMemory(),
        xotelo: { info: XOTELO_INFO, rates: vi.fn(async () => []) },
        trivago: { info: TRIVAGO_INFO, lookup },
        fx: {
          rates: async () => {
            throw new AppError("UPSTREAM_UNAVAILABLE", "fx is down");
          },
        },
        now: () => new Date(T),
      }),
    );
    const s = await c.callTool({ name: "search_hotels", arguments: { lat: 28.643, lng: 77.2194, ...stay } });
    const id = (s.structuredContent as { hotels: { hotel_id: string }[] }).hotels[0]!.hotel_id;
    const r = await c.callTool({ name: "get_hotel_rates", arguments: { hotel_id: id, ...stay } });
    expect(r.isError).toBeFalsy();
    const out = r.structuredContent as {
      prices: { currency: string; per_night_inr: number | null }[];
      sources_failed: { source: string; message: string }[];
    };
    expect(lookup).toHaveBeenCalled();
    expect(offers(out)).toEqual([expect.objectContaining({ currency: "EUR", per_night_inr: null })]);
    expect(out.sources_failed).toEqual([
      expect.objectContaining({ source: "fx", message: expect.stringMatching(/fx is down/) }),
    ]);
  });
});
