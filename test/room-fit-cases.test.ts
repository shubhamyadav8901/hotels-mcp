import { describe, expect, it, vi } from "vitest";
import type { Anchor } from "../src/core/anchors.js";
import { AppError } from "../src/core/errors.js";
import { HotelMemory } from "../src/core/hotel-memory.js";
import { planStay } from "../src/core/itinerary.js";
import { roomStatus } from "../src/core/occupancy.js";
import { RetiringRooms } from "../src/core/retiring.js";
import { parseIstDateTime } from "../src/core/time.js";
import type { HotelCandidate, PriceQuote } from "../src/core/types.js";
import { FX_INFO } from "../src/providers/fx.js";
import { createOsrm } from "../src/providers/osrm.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { SERPAPI_INFO, type GoogleRoomOffer } from "../src/providers/serpapi.js";
import { TRIVAGO_INFO } from "../src/providers/trivago.js";
import type { HotelSearchProvider } from "../src/providers/types.js";
import { XOTELO_INFO } from "../src/providers/xotelo.js";
import { connect, testDeps } from "./helpers.js";

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
const familyFor4 = () =>
  quote("hotelscasa", 4200, { seller: null, room: "Family Room for 4", available: true });

// OSRM stub: 10 minutes and 5 km for every leg.
const osrmFetch = vi.fn(async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const s = url.searchParams.get("sources")!.split(";");
  const d = url.searchParams.get("destinations")!.split(";");
  return new Response(
    JSON.stringify({
      code: "Ok",
      durations: s.map(() => d.map(() => 600)),
      distances: s.map(() => d.map(() => 5000)),
      sources: s.map(() => ({ distance: 3 })),
      destinations: d.map(() => ({ distance: 3 })),
    }),
  );
}) as unknown as typeof fetch;
const makeOsrm = () =>
  createOsrm({
    carUrl: "https://osrm.local/car",
    footUrl: "https://osrm.local/foot",
    http: { userAgent: "t", fetchImpl: osrmFetch },
  });

describe("one-room price beats a cheaper unknown price", () => {
  it("plan_stays ranks a candidate by its one-room price and shows the cheaper other price", async () => {
    const registry = new ProviderRegistry();
    const p = provider("p", async () => [
      listing("p", "h1", [quote("trivago", 3000, { seller: "Agoda" }), familyFor4()]),
    ]);
    const osrm = makeOsrm();
    [p.info, osrm.info, FX_INFO].forEach((i) => registry.register(i));
    const NDLS: Anchor & { label: string } = {
      kind: "station",
      name: "New Delhi",
      code: "NDLS",
      context: null,
      lat: 28.6419,
      lng: 77.2218,
      source: "t",
      label: "arrive NDLS",
    };
    const s = await planStay(
      {
        hotels: {
          registry,
          providers: [p],
          fx: { rates: async () => ({ toInr: { INR: 1 }, date: "d", source: "s" }) },
        },
        travel: { osrm, registry, metroMultiplier: 1, otherMultiplier: 1 },
        retiring: new RetiringRooms([]),
        memory: new HotelMemory(),
      },
      {
        arrive: NDLS,
        arrive_at: parseIstDateTime("2026-11-10T20:10"),
        depart: NDLS,
        depart_at: parseIstDateTime("2026-11-11T09:00"),
      },
      {
        adults: 4,
        children_ages: [],
        radius_km: 3,
        candidates: 3,
        value_of_time_inr_per_hour: 300,
        train_buffer_min: 30,
        flight_buffer_min: 120,
      },
      1,
    );
    expect(s.candidates).toHaveLength(1);
    expect(s.candidates[0]).toMatchObject({
      per_night_inr: 4200,
      fit: "one_room",
      room_status: "one_room",
      cheaper_other_per_night_inr: 3000,
    });
  });

  it("compare_hotels shows the one-room price a 4-adult search ranked the hotel by", async () => {
    const tv = provider("trivago", async () => [
      listing("trivago", "tv1", [quote("trivago", 3000, { seller: "Agoda" })]),
    ]);
    const casa = provider("hotelscasa", async () => [listing("hotelscasa", "hc1", [familyFor4()])]);
    const osrm = makeOsrm();
    const registry = new ProviderRegistry();
    [tv.info, casa.info, osrm.info, FX_INFO].forEach((i) => registry.register(i));
    const c = await connect(
      testDeps({
        registry,
        hotelProviders: [tv, casa],
        memory: new HotelMemory(),
        travel: { osrm, registry, metroMultiplier: 1, otherMultiplier: 1 },
        now: () => new Date(T),
      }),
    );
    const s = await c.callTool({ name: "search_hotels", arguments: { lat: 28.643, lng: 77.2194, ...stay } });
    const id = (s.structuredContent as { hotels: { hotel_id: string }[] }).hotels[0]!.hotel_id;
    const r = await c.callTool({
      name: "compare_hotels",
      arguments: { hotels: [{ hotel_id: id }], places: [{ lat: 28.6419, lng: 77.2218, label: "arrive" }] },
    });
    expect(r.isError).toBeFalsy();
    const h = (r.structuredContent as { hotels: { cheapest: Record<string, unknown> }[] }).hotels[0]!;
    expect(h.cheapest).toMatchObject({
      per_night_inr: 4200,
      fit: "one_room",
      source: "hotelscasa",
      adults: 4,
    });
  });
});

describe("search_hotels max_price_inr with a two-room-only hotel", () => {
  it("keeps a hotel priced only as two rooms under the cap, sorted after an unverified dearer one", async () => {
    const tv = provider("trivago", async () => [
      listing(
        "trivago",
        "doubled",
        [quote("trivago", 3000, { seller: "Agoda", two_adult_per_night: 1500 })],
        {
          name: "Hotel Doubled",
          lat: 28.6435,
        },
      ),
      listing("trivago", "single", [quote("trivago", 3500, { seller: "Agoda", two_adult_per_night: 2500 })], {
        name: "Hotel Single",
        lat: 28.6475,
      }),
    ]);
    const registry = new ProviderRegistry();
    [tv.info, FX_INFO].forEach((i) => registry.register(i));
    const c = await connect(
      testDeps({ registry, hotelProviders: [tv], memory: new HotelMemory(), now: () => new Date(T) }),
    );
    const r = await c.callTool({
      name: "search_hotels",
      arguments: { lat: 28.643, lng: 77.2194, ...stay, sort: "price", max_price_inr: 4000 },
    });
    const hotels = (
      r.structuredContent as {
        hotels: { name: string; room_status: string; cheapest: { per_night_inr: number } }[];
      }
    ).hotels;
    // Current intended behaviour: the two-room price (₹3,000) is under the cap, so the hotel is kept, but it
    // sorts after the unverified ₹3,500 hotel.
    expect(hotels.map((h) => [h.name, h.room_status, h.cheapest.per_night_inr])).toEqual([
      ["Hotel Single", "unverified", 3500],
      ["Hotel Doubled", "two_rooms_only", 3000],
    ]);
  });
});

describe("verify_room", () => {
  const offer = (
    seller: string,
    room: string,
    guests: number | null,
    per_night: number,
  ): GoogleRoomOffer => ({
    seller,
    room,
    guests,
    per_night,
    currency: "INR",
    url: null,
  });
  const rateArgs = { name: "Sunrise Residency", lat: 28.6435, lng: 77.2194, ...stay };

  it("keeps only room-list offers that say something about one room for the party", async () => {
    const tv = provider("trivago", async () => [
      listing("trivago", "tv1", [quote("trivago", 3000, { seller: "Booking.com" })]),
    ]);
    const google = provider("serpapi", async () => [
      listing("serpapi", "tok1", [quote("serpapi", 2900, { seller: "Google Hotels" })]),
    ]);
    google.info = SERPAPI_INFO;
    const rooms = vi.fn(async () => [
      offer("Expedia", "Family Room for 4", null, 2500), // sleeps 4, but priced for the list's 2 adults
      offer("Expedia", "Deluxe Room", null, 2200), // says nothing about 4 guests
      offer("Booking.com", "Triple Room", 3, 2700), // rate for fewer guests
    ]);
    const registry = new ProviderRegistry();
    [tv.info, SERPAPI_INFO, FX_INFO, XOTELO_INFO].forEach((i) => registry.register(i));
    const c = await connect(
      testDeps({
        registry,
        hotelProviders: [tv, google],
        memory: new HotelMemory(),
        xotelo: { info: XOTELO_INFO, rates: vi.fn(async () => []) },
        serp: { info: SERPAPI_INFO, rooms },
        now: () => new Date(T),
      }),
    );
    const r = await c.callTool({ name: "get_hotel_rates", arguments: { ...rateArgs, verify_room: true } });
    expect(r.isError).toBeFalsy();
    expect(rooms).toHaveBeenCalled();
    const out = r.structuredContent as {
      prices: { seller: string; room: string | null; fit: string; fit_note: string | null }[];
      cheapest_inr: number | null;
      cheapest_one_room_inr: number | null;
    };
    const fromRooms = out.prices.filter((p) => p.room !== null);
    expect(fromRooms.map((p) => [p.seller, p.room, p.fit])).toEqual([
      ["Expedia", "Family Room for 4", "unknown"],
    ]);
    expect(fromRooms[0]!.fit_note).toMatch(/for 2 guests/);
    // The Expedia ₹2,500 is a 2-guest price, not the party's.
    expect(out.cheapest_inr).not.toBe(2500);
    expect(out.cheapest_inr).toBe(2900);
    expect(out.cheapest_one_room_inr).toBeNull();
  });

  it("keeps the search's 2-adult price when its own 2-adult lookup returns nothing", async () => {
    const search = vi.fn(async () => [
      listing("trivago", "tv1", [quote("trivago", 3000, { seller: "Agoda", two_adult_per_night: 1500 })]),
    ]);
    const tv = provider("trivago", search);
    const lookup = vi.fn(async () => null);
    const registry = new ProviderRegistry();
    [tv.info, FX_INFO, XOTELO_INFO].forEach((i) => registry.register(i));
    const c = await connect(
      testDeps({
        registry,
        hotelProviders: [tv],
        memory: new HotelMemory(),
        xotelo: { info: XOTELO_INFO, rates: vi.fn(async () => []) },
        trivago: { info: TRIVAGO_INFO, lookup },
        serp: null,
        now: () => new Date(T),
      }),
    );
    const s = await c.callTool({ name: "search_hotels", arguments: { lat: 28.643, lng: 77.2194, ...stay } });
    const h = (s.structuredContent as { hotels: { hotel_id: string; cheapest: { fit: string } }[] })
      .hotels[0]!;
    expect(h.cheapest.fit).toBe("two_rooms");
    const r = await c.callTool({
      name: "get_hotel_rates",
      arguments: { hotel_id: h.hotel_id, ...stay, verify_room: true },
    });
    const out = r.structuredContent as {
      prices: { source: string; fit: string; fit_basis: string }[];
      room_status: string;
      notes: string[];
    };
    expect(lookup).toHaveBeenCalledWith(
      "tv1",
      "Sunrise Residency",
      undefined,
      expect.objectContaining({ adults: 2 }),
    );
    expect(out.notes.join("\n")).toMatch(/trivago did not return a 2-adult price/);
    expect(out.prices.find((p) => p.source === "trivago")).toMatchObject({
      fit: "two_rooms",
      fit_basis: "price_ratio",
    });
    expect(out.room_status).toBe("two_rooms_only");
  });
});

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
    expect(out.prices.map((p) => [p.source, p.per_night_inr])).toEqual([["trivago", 3000]]);
    expect(out.notes.join("\n")).toMatch(/prices from the search/);
    expect(lookup).toHaveBeenCalled();
    for (const call of lookup.mock.calls as unknown as [string, string][]) {
      expect(call[0]).toBe("tv1");
      expect(call[1]).toBe("Cochin Hotel Inn");
    }
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
    expect(out.prices).toEqual([expect.objectContaining({ currency: "EUR", per_night_inr: null })]);
    expect(out.sources_failed).toEqual([
      expect.objectContaining({ source: "fx", message: expect.stringMatching(/fx is down/) }),
    ]);
  });
});

describe("roomStatus with an unconverted price", () => {
  it("counts a one-room price with no INR conversion", () => {
    const prices = [
      quote("hotelscasa", 50, { currency: "EUR", per_night_inr: null, fit: "one_room" }),
      quote("trivago", 3000, { per_night_inr: 3000, fit: "two_rooms" }),
    ];
    expect(roomStatus(prices)).toBe("one_room");
  });
});
