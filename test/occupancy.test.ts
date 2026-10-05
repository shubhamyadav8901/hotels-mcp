import { describe, expect, it, vi } from "vitest";
import { HotelMemory } from "../src/core/hotel-memory.js";
import { cheapestSingleRoom, occupancyLabel, singleRoomVerdict } from "../src/core/occupancy.js";
import type { HotelCandidate, PriceQuote } from "../src/core/types.js";
import { FX_INFO } from "../src/providers/fx.js";
import { ProviderRegistry } from "../src/providers/registry.js";
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
  per_night_inr: per_night,
  includes_taxes: null,
  available: null,
  refundable: null,
  url: null,
  room: null,
  fetched_at: T,
  ...extra,
});

describe("occupancyLabel", () => {
  it("treats 1–2 guests as ordinary, confirming live HotelsCasa availability", () => {
    expect(occupancyLabel(quote("trivago", 1), 2).occupancy).toBe("likely");
    expect(occupancyLabel(quote("hotelscasa", 1, { available: true }), 2).occupancy).toBe("confirmed");
  });

  it("marks trivago and Xotelo unverified for larger parties, with a reason", () => {
    for (const s of ["trivago", "xotelo"]) {
      const l = occupancyLabel(quote(s, 1), 4);
      expect(l.occupancy).toBe("unverified");
      expect(l.occupancy_note).toMatch(/two rooms/);
    }
  });

  it("confirms HotelsCasa only when the room name says it sleeps the party", () => {
    for (const room of [
      "Family Room, Room Only",
      "Four bed Room",
      "Comfort Quadruple Room",
      "4 Bed - AC Room",
      "Room with 2 Double Beds",
    ]) {
      expect(occupancyLabel(quote("hotelscasa", 1, { room }), 4).occupancy, room).toBe("confirmed");
    }
    const dbl = occupancyLabel(quote("hotelscasa", 1, { room: "Deluxe Double Room, Room Only" }), 4);
    expect(dbl).toMatchObject({ occupancy: "likely", occupancy_note: expect.stringMatching(/extra beds/) });
  });

  it("calls Google likely, since it filters by guests but names no room", () => {
    expect(occupancyLabel(quote("serpapi", 1), 4).occupancy).toBe("likely");
  });
});

describe("singleRoomVerdict and cheapestSingleRoom", () => {
  it.each([
    [12000, 6000, "looks_like_2_rooms"],
    [10425, 5213, "looks_like_2_rooms"],
    [8085, 2840, "unusually_high"],
    [2697, 1767, "plausible_single_room"],
    [1979, 1039, "looks_like_2_rooms"],
    [2237, 2237, "priced_as_2_adults"],
    [2843, 955, "unusually_high"],
    [102375, 12187, "implausible"],
    [8000, null, "unknown"],
  ])("%s vs 2-adult %s → %s", (party, two, verdict) => {
    expect(singleRoomVerdict(party, two, 4)).toBe(verdict);
  });

  it("skips unverified prices", () => {
    const best = cheapestSingleRoom([
      quote("trivago", 1000, { occupancy: "unverified" }),
      quote("hotelscasa", 1500, { occupancy: "confirmed" }),
      quote("serpapi", 1400, { occupancy: "likely" }),
    ]);
    expect(best?.source).toBe("serpapi");
  });
});

describe("over MCP", () => {
  const cand = (source: string, prices: PriceQuote[]): HotelCandidate => ({
    source,
    source_id: "h1",
    name: "Sunrise Residency",
    lat: 28.6435,
    lng: 77.2194,
    stars: 3,
    rating_10: 8,
    review_count: 10,
    url: null,
    prices: prices.map((p) => ({ ...p, per_night_inr: null })),
    fetched_at: T,
  });
  // trivago-like source: 4 guests cost exactly double the 2-adult price (two rooms).
  const trivago: HotelSearchProvider = {
    info: {
      id: "trivago",
      name: "trivago",
      kind: "hotel-prices",
      official: true,
      needsKey: false,
      limitations: [],
    },
    search: vi.fn(async (q) => [
      cand("trivago", [quote("trivago", q.adults >= 4 ? 3800 : 1900, { seller: "Agoda" })]),
    ]),
  };
  const casa: HotelSearchProvider = {
    info: {
      id: "hotelscasa",
      name: "hotelscasa",
      kind: "hotel-prices",
      official: true,
      needsKey: false,
      limitations: [],
    },
    search: vi.fn(async () => [
      cand("hotelscasa", [quote("hotelscasa", 4200, { seller: null, room: "Family Room", available: true })]),
    ]),
  };
  function deps() {
    const registry = new ProviderRegistry();
    [trivago.info, casa.info, FX_INFO, XOTELO_INFO].forEach((i) => registry.register(i));
    return testDeps({
      registry,
      hotelProviders: [trivago, casa],
      memory: new HotelMemory(),
      xotelo: { info: XOTELO_INFO, rates: vi.fn(async () => []) },
      now: () => new Date(T),
    });
  }
  const args = { lat: 28.643, lng: 77.2194, check_in: "2026-11-10", check_out: "2026-11-11", adults: 4 };

  it("search_hotels returns all prices labelled, plus the cheapest single-room price when they differ", async () => {
    const c = await connect(deps());
    const r = await c.callTool({ name: "search_hotels", arguments: args });
    const h = (r.structuredContent as { hotels: Record<string, any>[] }).hotels[0]!;
    expect(h.cheapest).toMatchObject({ per_night_inr: 3800, source: "trivago", occupancy: "unverified" });
    expect(h.cheapest_single_room).toMatchObject({
      per_night_inr: 4200,
      source: "hotelscasa",
      occupancy: "confirmed",
    });
  });

  it("get_hotel_rates with check_single_room flags a price that is exactly double the 2-adult price", async () => {
    const c = await connect(deps());
    const r = await c.callTool({
      name: "get_hotel_rates",
      arguments: {
        name: "Sunrise Residency",
        lat: 28.6435,
        lng: 77.2194,
        check_in: "2026-11-10",
        check_out: "2026-11-11",
        adults: 4,
        check_single_room: true,
      },
    });
    expect(r.isError).toBeFalsy();
    const prices = (r.structuredContent as { prices: Record<string, any>[] }).prices;
    const tv = prices.find((p) => p.source === "trivago")!;
    expect(tv.single_room_check).toEqual({
      verdict: "looks_like_2_rooms",
      two_adult_per_night_inr: 1900,
      ratio: 2,
    });
    expect(prices.find((p) => p.source === "hotelscasa")!.single_room_check).toBeNull();
    // Only the unverified source was asked again, for 2 adults.
    expect((casa.search as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((trivago.search as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({ adults: 2 });
  });
});

describe("trivago single-room check", () => {
  it("compares with trivago's 2-adult price even when its cheapest advertiser changes", async () => {
    const tv: HotelSearchProvider = {
      info: {
        id: "trivago",
        name: "trivago",
        kind: "hotel-prices",
        official: true,
        needsKey: false,
        limitations: [],
      },
      search: vi.fn(async (q) => [
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
          prices: [
            quote("trivago", q.adults >= 4 ? 8379 : 4190, {
              seller: q.adults >= 4 ? "Agoda" : "Booking.com",
              per_night_inr: null,
            }),
          ],
        },
      ]),
    };
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
    const r = await c.callTool({
      name: "get_hotel_rates",
      arguments: {
        name: "Sunrise Residency",
        lat: 28.6435,
        lng: 77.2194,
        check_in: "2026-11-10",
        check_out: "2026-11-11",
        adults: 4,
        check_single_room: true,
      },
    });
    const p = (r.structuredContent as { prices: Record<string, any>[] }).prices[0]!;
    expect(p.single_room_check).toMatchObject({
      verdict: "looks_like_2_rooms",
      two_adult_per_night_inr: 4190,
    });
  });
});

describe("review fixes", () => {
  it("confirms a room only when its name says it sleeps the whole party", () => {
    const label = (room: string, guests: number) =>
      occupancyLabel(quote("hotelscasa", 1, { room }), guests).occupancy;
    expect(label("Triple Room, Room Only", 3)).toBe("confirmed");
    expect(label("Triple Room, Room Only", 4)).toBe("likely");
    expect(label("Family Room", 4)).toBe("confirmed");
    expect(label("Family Room", 6)).toBe("likely");
    expect(label("6 Bed Room", 6)).toBe("confirmed");
    expect(label("Junior Suite", 4)).toBe("likely");
    expect(label("Studio Apartment", 4)).toBe("likely");
    expect(label("Bed in 8-Bed Dormitory", 4)).toBe("likely");
  });

  it("gives no doubling verdict above 4 guests (three rooms would look plausible)", () => {
    expect(singleRoomVerdict(15000, 5000, 6)).toBe("unknown");
    expect(singleRoomVerdict(10000, 5000, 4)).toBe("looks_like_2_rooms");
  });

  it("sorts and filters by the single-room price, not a cheaper possible two-room price", async () => {
    const mk = (id: string, tv: number, casa: number | null): HotelCandidate => ({
      source: "x",
      source_id: id,
      name: `Hotel ${id}`,
      lat: 28.6435 + Number(id) * 0.001,
      lng: 77.2194,
      stars: 3,
      rating_10: 8,
      review_count: 10,
      url: null,
      fetched_at: T,
      prices: [
        { ...quote("trivago", tv), per_night_inr: null },
        ...(casa === null
          ? []
          : [
              { ...quote("hotelscasa", casa, { room: "Family Room", available: true }), per_night_inr: null },
            ]),
      ],
    });
    const p: HotelSearchProvider = {
      info: { id: "x", name: "x", kind: "hotel-prices", official: true, needsKey: false, limitations: [] },
      search: async () => [mk("1", 3000, 7000), mk("2", 5000, 6000)],
    };
    const registry = new ProviderRegistry();
    [p.info, FX_INFO].forEach((i) => registry.register(i));
    const { searchHotels } = await import("../src/core/hotel-search.js");
    const d = {
      registry,
      providers: [p],
      fx: { rates: async () => ({ toInr: { INR: 1 }, date: "d", source: "s" }) },
    };
    const q = { lat: 28.643, lng: 77.2194, radius_km: 3, check_in: "x", check_out: "y", adults: 4 };
    const r = await searchHotels(d, q, { sort: "price" });
    // Hotel 1 is cheapest only on trivago's unverified ₹3,000; on single-room prices Hotel 2 (₹6,000) wins.
    expect(r.hotels.map((h) => h.name)).toEqual(["Hotel 2", "Hotel 1"]);
    const capped = await searchHotels(d, q, { sort: "price", max_price_inr: 6500 });
    expect(capped.hotels.map((h) => h.name)).toEqual(["Hotel 2"]);
  });
});

describe("single-room check failures", () => {
  it("reports a failed 2-adult re-search instead of silently answering unknown", async () => {
    const { AppError } = await import("../src/core/errors.js");
    const tv: HotelSearchProvider = {
      info: {
        id: "trivago",
        name: "trivago",
        kind: "hotel-prices",
        official: true,
        needsKey: false,
        limitations: [],
      },
      search: vi.fn(async (q) => {
        if (q.adults === 2) throw new AppError("UPSTREAM_UNAVAILABLE", "trivago is down");
        return [
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
            prices: [{ ...quote("trivago", 8000), per_night_inr: null }],
          },
        ];
      }),
    };
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
    const r = await c.callTool({
      name: "get_hotel_rates",
      arguments: {
        name: "Sunrise Residency",
        lat: 28.6435,
        lng: 77.2194,
        check_in: "2026-11-10",
        check_out: "2026-11-11",
        adults: 4,
        check_single_room: true,
      },
    });
    const out = r.structuredContent as {
      prices: Record<string, any>[];
      sources_failed: { source: string }[];
    };
    expect(out.prices[0]!.single_room_check.verdict).toBe("unknown");
    expect(out.sources_failed.map((f) => f.source)).toContain("single_room_check:trivago");
  });
});

describe("agent-test fixes", () => {
  it("does not read 'N Bedroom' as how many a room sleeps", () => {
    const label = (room: string) => occupancyLabel(quote("hotelscasa", 1, { room }), 4).occupancy;
    expect(label("Four Bedroom, Room Only")).toBe("likely");
    expect(label("Five Bedroom Standard")).toBe("likely");
    expect(label("Deluxe Four Bed AC")).toBe("confirmed");
  });

  it("get_hotel_rates falls back to the search's prices when the live re-check misses the hotel", async () => {
    let calls = 0;
    const tv: HotelSearchProvider = {
      info: {
        id: "trivago",
        name: "trivago",
        kind: "hotel-prices",
        official: true,
        needsKey: false,
        limitations: [],
      },
      // Lists the hotel only on the first (search) call, like trivago's fixed 25 results around a point.
      search: vi.fn(async () =>
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
    };
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
    const r = await c.callTool({ name: "get_hotel_rates", arguments: { hotel_id: id, ...dates } });
    expect(r.isError).toBeFalsy();
    const out = r.structuredContent as { prices: { per_night_inr: number }[]; notes: string[] };
    expect(out.prices[0]!.per_night_inr).toBe(3000);
    expect(out.notes.join(" ")).toMatch(/prices from the search/);
    // A different party or dates does not reuse those prices.
    const other = await c.callTool({
      name: "get_hotel_rates",
      arguments: { hotel_id: id, ...dates, adults: 2 },
    });
    expect(other.isError).toBe(true);
  });
});

describe("trivago name lookup in get_hotel_rates", () => {
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

  it("gets the 2-adult comparison price by name when trivago's area search leaves the hotel out", async () => {
    // Area search lists the hotel only for the party of 4; the 2-adult re-search misses it.
    const tv: HotelSearchProvider = {
      info: {
        id: "trivago",
        name: "trivago",
        kind: "hotel-prices",
        official: true,
        needsKey: false,
        limitations: [],
      },
      search: vi.fn(async (q) => (q.adults === 4 ? [listing(3800)] : [])),
    };
    const lookup = vi.fn(async (_id: string, _n: string, _c: string | undefined, q: { adults: number }) =>
      q.adults === 2 ? listing(1900) : null,
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
        trivago: { info: TRIVAGO_INFO, lookup },
      }),
    );
    const r = await c.callTool({
      name: "get_hotel_rates",
      arguments: {
        name: "Sunrise Residency",
        lat: 28.6435,
        lng: 77.2194,
        check_in: "2026-11-10",
        check_out: "2026-11-11",
        adults: 4,
        check_single_room: true,
      },
    });
    const p = (r.structuredContent as { prices: Record<string, any>[] }).prices.find(
      (x) => x.source === "trivago",
    )!;
    expect(p.single_room_check).toMatchObject({
      verdict: "looks_like_2_rooms",
      two_adult_per_night_inr: 1900,
    });
    expect(lookup).toHaveBeenCalledWith(
      "h1",
      "Sunrise Residency",
      undefined,
      expect.objectContaining({ adults: 2 }),
    );
  });

  it("prefers a live trivago price by name over the search's remembered one when the re-check misses the hotel", async () => {
    let n = 0;
    const tv: HotelSearchProvider = {
      info: {
        id: "trivago",
        name: "trivago",
        kind: "hotel-prices",
        official: true,
        needsKey: false,
        limitations: [],
      },
      search: vi.fn(async () => (n++ === 0 ? [listing(3000)] : [])),
    };
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
        trivago: { info: TRIVAGO_INFO, lookup: vi.fn(async () => listing(3300)) },
      }),
    );
    const d = { check_in: "2026-11-10", check_out: "2026-11-11", adults: 4 };
    const s = await c.callTool({ name: "search_hotels", arguments: { lat: 28.643, lng: 77.2194, ...d } });
    const id = (s.structuredContent as { hotels: { hotel_id: string }[] }).hotels[0]!.hotel_id;
    const r = await c.callTool({ name: "get_hotel_rates", arguments: { hotel_id: id, ...d } });
    const prices = (r.structuredContent as { prices: { source: string; per_night_inr: number }[] }).prices;
    expect(prices.filter((p) => p.source === "trivago").map((p) => p.per_night_inr)).toEqual([3300]);
  });
});

describe("trivago lookup with ids from the original search", () => {
  it("looks trivago up by name when another source finds the hotel on the re-check but trivago doesn't", async () => {
    let tvCalls = 0;
    const tv: HotelSearchProvider = {
      info: {
        id: "trivago",
        name: "trivago",
        kind: "hotel-prices",
        official: true,
        needsKey: false,
        limitations: [],
      },
      search: vi.fn(async () =>
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
    };
    const casa: HotelSearchProvider = {
      info: {
        id: "hotelscasa",
        name: "hotelscasa",
        kind: "hotel-prices",
        official: true,
        needsKey: false,
        limitations: [],
      },
      search: vi.fn(async () => [
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
    };
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
    const r = await c.callTool({ name: "get_hotel_rates", arguments: { hotel_id: id, ...d } });
    const prices = (r.structuredContent as { prices: { source: string; per_night_inr: number }[] }).prices;
    expect(lookup).toHaveBeenCalledWith(
      "tv1",
      expect.any(String),
      undefined,
      expect.objectContaining({ adults: 4 }),
    );
    expect(prices.map((p) => [p.source, p.per_night_inr])).toEqual([
      ["trivago", 3100],
      ["hotelscasa", 4200],
    ]);
  });
});
