import { describe, expect, it, vi } from "vitest";
import { HotelMemory } from "../src/core/hotel-memory.js";
import { cheapestOneRoom, rankPrice, roomFit, roomStatus } from "../src/core/occupancy.js";
import type { HotelCandidate, PriceQuote } from "../src/core/types.js";
import { FX_INFO } from "../src/providers/fx.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { SERPAPI_INFO, type GoogleRoomOffer } from "../src/providers/serpapi.js";
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
const provider = (id: string, search: HotelSearchProvider["search"]): HotelSearchProvider => ({
  info: { id, name: id, kind: "hotel-prices", official: true, needsKey: false, limitations: [] },
  search,
});
const rateArgs = {
  name: "Sunrise Residency",
  lat: 28.6435,
  lng: 77.2194,
  check_in: "2026-11-10",
  check_out: "2026-11-11",
  adults: 4,
};

describe("roomFit", () => {
  it("calls every price one room for 1–2 guests, from the party search", () => {
    for (const q of [quote("trivago", 1), quote("hotelscasa", 1, { available: true })])
      expect(roomFit(q, 2)).toEqual({ fit: "one_room", fit_basis: "party_search", fit_note: null });
  });

  it("leaves trivago and Xotelo unknown for larger parties without a 2-adult price, with a reason", () => {
    for (const s of ["trivago", "xotelo"]) {
      const l = roomFit(quote(s, 1), 4);
      expect(l).toMatchObject({ fit: "unknown", fit_basis: "none" });
      expect(l.fit_note).toMatch(/two rooms/);
    }
  });

  it("calls a price one room only when the room name says it sleeps the party", () => {
    for (const room of [
      "Family Room, Room Only",
      "Four bed Room",
      "Comfort Quadruple Room",
      "4 Bed - AC Room",
      "Room with 2 Double Beds",
    ]) {
      expect(roomFit(quote("hotelscasa", 1, { room }), 4), room).toMatchObject({
        fit: "one_room",
        fit_basis: "room_name",
      });
    }
    expect(roomFit(quote("hotelscasa", 1, { room: "Deluxe Double Room, Room Only" }), 4)).toMatchObject({
      fit: "unknown",
      fit_basis: "party_search",
      fit_note: expect.stringMatching(/does not say how many it sleeps/),
    });
  });

  it("leaves Google's unnamed listing price unknown, since it can be a multi-room deal", () => {
    expect(roomFit(quote("serpapi", 1), 4)).toMatchObject({ fit: "unknown", fit_basis: "party_search" });
  });

  it("uses a site's stated guests for the rate, and names a combo as two rooms", () => {
    const bk = (room_guests: number) =>
      quote("serpapi", 1, { seller: "Booking.com", room: "Room", room_guests });
    expect(roomFit(bk(4), 4)).toMatchObject({ fit: "one_room", fit_basis: "room_capacity" });
    expect(roomFit(bk(3), 4)).toMatchObject({ fit: "unknown", fit_basis: "room_capacity" });
    const combo = quote("serpapi", 1, { seller: "Agoda", room: "Cheapest combo rooms", room_guests: 4 });
    expect(roomFit(combo, 4)).toMatchObject({ fit: "two_rooms", fit_basis: "room_name" });
    // A room that sleeps 4, priced for the list's 2 adults, may cost more for 4.
    const priced2 = quote("serpapi", 1, { room: "Family Room", priced_for_guests: 2 });
    expect(roomFit(priced2, 4)).toMatchObject({ fit: "unknown", fit_basis: "room_name" });
  });
});

describe("price ratio against the same site's 2-adult price, and the hotel's one-room price", () => {
  it.each([
    [12000, 6000, "two_rooms", "price_ratio"],
    [10425, 5213, "two_rooms", "price_ratio"],
    [8085, 2840, "unknown", "price_ratio"],
    [2697, 1767, "unknown", "price_ratio"], // an extra-guest charge does not prove one room
    [1979, 1039, "two_rooms", "price_ratio"],
    [2237, 2237, "unknown", "price_ratio"],
    [2843, 955, "unknown", "price_ratio"],
    [102375, 12187, "unknown", "price_ratio"],
    [8000, null, "unknown", "none"],
  ])("%s vs 2-adult %s → %s (%s)", (party, two, fit, basis) => {
    expect(roomFit(quote("trivago", party, { two_adult_per_night: two }), 4)).toMatchObject({
      fit,
      fit_basis: basis,
    });
  });

  it("picks the cheapest one-room price, and ranks by it, else by the cheapest not known to be two rooms", () => {
    const prices = [
      quote("trivago", 1000, { fit: "two_rooms" }),
      quote("trivago", 1200, { fit: "unknown" }),
      quote("hotelscasa", 1500, { fit: "one_room" }),
      quote("serpapi", 1400, { fit: "one_room", available: false }),
    ];
    expect(cheapestOneRoom(prices)?.per_night).toBe(1500);
    expect(rankPrice(prices)?.per_night).toBe(1500);
    expect(roomStatus(prices)).toBe("one_room");
    const noOne = prices.slice(0, 2);
    expect(cheapestOneRoom(noOne)).toBeNull();
    expect(rankPrice(noOne)?.per_night).toBe(1200);
    expect(roomStatus(noOne)).toBe("unverified");
    expect(rankPrice(prices.slice(0, 1))?.per_night).toBe(1000);
    expect(roomStatus(prices.slice(0, 1))).toBe("two_rooms_only");
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
  // trivago-like source: 4 guests cost exactly double the same site's 2-adult price (two rooms).
  const trivago = provider(
    "trivago",
    vi.fn(async (q) => [
      cand("trivago", [quote("trivago", q.adults >= 4 ? 3800 : 1900, { seller: "Agoda" })]),
    ]),
  );
  const casa = provider(
    "hotelscasa",
    vi.fn(async () => [
      cand("hotelscasa", [quote("hotelscasa", 4200, { seller: null, room: "Family Room", available: true })]),
    ]),
  );
  function deps() {
    const registry = new ProviderRegistry();
    [trivago.info, casa.info, FX_INFO, XOTELO_INFO].forEach((i) => registry.register(i));
    return testDeps({
      registry,
      hotelProviders: [trivago, casa],
      memory: new HotelMemory(),
      xotelo: { info: XOTELO_INFO, rates: vi.fn(async () => []) },
      serp: null,
      now: () => new Date(T),
    });
  }
  const args = { lat: 28.643, lng: 77.2194, check_in: "2026-11-10", check_out: "2026-11-11", adults: 4 };

  it("search_hotels labels every price, gives the rank price (one room) when it differs, and room_status", async () => {
    const c = await connect(deps());
    const r = await c.callTool({ name: "search_hotels", arguments: args });
    const sc = r.structuredContent as { hotels: Record<string, any>[]; notes: string[] };
    const h = sc.hotels[0]!;
    expect(h.cheapest).toMatchObject({
      per_night_inr: 3800,
      source: "trivago",
      fit: "unknown",
      fit_basis: "none",
    });
    expect(h.rank_price).toMatchObject({
      per_night_inr: 4200,
      source: "hotelscasa",
      fit: "one_room",
      fit_basis: "room_name",
    });
    expect(h.room_status).toBe("one_room");
    expect(sc.notes.join("\n")).toMatch(/Of 1 hotels, 1 have a price known to be one room for 4/);
  });

  it("get_hotel_rates with verify_room labels a price exactly double the same site's 2-adult price two rooms", async () => {
    const c = await connect(deps());
    const r = await c.callTool({ name: "get_hotel_rates", arguments: { ...rateArgs, verify_room: true } });
    expect(r.isError).toBeFalsy();
    const out = r.structuredContent as Record<string, any>;
    const tv = out.prices.find((p: any) => p.source === "trivago")!;
    expect(tv).toMatchObject({
      fit: "two_rooms",
      fit_basis: "price_ratio",
      fit_note: expect.stringMatching(/^2x Agoda's/),
    });
    expect(tv.single_room_check).toBeUndefined();
    expect(out.prices.find((p: any) => p.source === "hotelscasa")).toMatchObject({ fit: "one_room" });
    expect(out).toMatchObject({ room_status: "one_room", cheapest_one_room_inr: 4200, cheapest_inr: 3800 });
    // Only the cheapest-offer source was asked again, for 2 adults.
    expect((casa.search as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((trivago.search as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({ adults: 2 });
  });

  it("get_hotel_rates with verify_room says Google's room list needs SerpApi when it is not configured", async () => {
    const c = await connect(deps());
    const r = await c.callTool({ name: "get_hotel_rates", arguments: { ...rateArgs, verify_room: true } });
    const out = r.structuredContent as { notes: string[]; sources_failed: unknown[] };
    expect(out.notes.join("\n")).toMatch(/verify_room: Google's room list needs SerpApi/);
    expect(out.sources_failed).toEqual([]);
  });
});

describe("verify_room with Google's room list", () => {
  const listing = (source: string, id: string, prices: PriceQuote[]): HotelCandidate => ({
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
    prices: prices.map((p) => ({ ...p, per_night_inr: null })),
  });
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

  it("turns a Booking.com 4-guest rate into one_room and an Agoda combo into two_rooms", async () => {
    const tv = provider("trivago", async () => [
      listing("trivago", "tv1", [quote("trivago", 3000, { seller: "Booking.com" })]),
    ]);
    const google = {
      info: SERPAPI_INFO,
      search: async () => [listing("serpapi", "tok1", [quote("serpapi", 2900, { seller: "Google Hotels" })])],
    };
    const rooms = vi.fn(async () => [
      offer("Booking.com", "Standard Family Room", 4, 4200),
      offer("Booking.com", "Standard Double Room", 2, 2500), // for fewer guests: no evidence, left out
      offer("Agoda", "Cheapest combo rooms", 4, 2080),
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
    const before = await c.callTool({ name: "get_hotel_rates", arguments: rateArgs });
    expect((before.structuredContent as { room_status: string }).room_status).toBe("unverified");
    expect(rooms).not.toHaveBeenCalled();

    const r = await c.callTool({ name: "get_hotel_rates", arguments: { ...rateArgs, verify_room: true } });
    const out = r.structuredContent as Record<string, any>;
    expect(rooms).toHaveBeenCalledWith("tok1", expect.objectContaining({ adults: 2 }));
    const fromRooms = out.prices.filter((p: any) => p.room !== null);
    expect(
      fromRooms.map((p: any) => [p.source, p.seller, p.room, p.room_guests, p.fit, p.fit_basis]),
    ).toEqual([
      ["serpapi", "Agoda", "Cheapest combo rooms", 4, "two_rooms", "room_name"],
      ["serpapi", "Booking.com", "Standard Family Room", 4, "one_room", "room_capacity"],
    ]);
    expect(out).toMatchObject({ room_status: "one_room", cheapest_one_room_inr: 4200, cheapest_inr: 2080 });
    expect(out.notes.join("\n")).toMatch(
      /Google's room list had \d+ offers; 2 say something about one room for 4/,
    );
  });

  it("says so when Google does not list the hotel", async () => {
    const tv = provider("trivago", async () => [listing("trivago", "tv1", [quote("trivago", 3000)])]);
    const rooms = vi.fn(async () => []);
    const registry = new ProviderRegistry();
    [tv.info, SERPAPI_INFO, FX_INFO, XOTELO_INFO].forEach((i) => registry.register(i));
    const c = await connect(
      testDeps({
        registry,
        hotelProviders: [tv],
        memory: new HotelMemory(),
        xotelo: { info: XOTELO_INFO, rates: vi.fn(async () => []) },
        serp: { info: SERPAPI_INFO, rooms },
        now: () => new Date(T),
      }),
    );
    const r = await c.callTool({ name: "get_hotel_rates", arguments: { ...rateArgs, verify_room: true } });
    expect((r.structuredContent as { notes: string[] }).notes.join("\n")).toMatch(
      /Google Hotels does not list this hotel/,
    );
    expect(rooms).not.toHaveBeenCalled();
  });
});

describe("trivago 2-adult comparison", () => {
  it("compares only with the same booking site: a changed cheapest advertiser leaves the price unknown", async () => {
    const tv = provider(
      "trivago",
      vi.fn(async (q) => [
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
          // Exactly 2.0x, but Booking.com's 2-adult price says nothing about Agoda's 4-guest one.
          prices: [
            quote("trivago", q.adults >= 4 ? 8380 : 4190, {
              seller: q.adults >= 4 ? "Agoda" : "Booking.com",
              per_night_inr: null,
            }),
          ],
        },
      ]),
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
    const r = await c.callTool({ name: "get_hotel_rates", arguments: { ...rateArgs, verify_room: true } });
    const out = r.structuredContent as Record<string, any>;
    expect(out.prices[0]).toMatchObject({ seller: "Agoda", fit: "unknown", fit_basis: "none" });
    expect(out.room_status).toBe("unverified");
  });
});

describe("review fixes", () => {
  it("calls a room one room only when its name says it sleeps the whole party", () => {
    const label = (room: string, guests: number) => {
      const f = roomFit(quote("hotelscasa", 1, { room }), guests);
      return `${f.fit}/${f.fit_basis}`;
    };
    expect(label("Triple Room, Room Only", 3)).toBe("one_room/room_name");
    expect(label("Triple Room, Room Only", 4)).toBe("unknown/room_name");
    expect(label("Family Room", 4)).toBe("one_room/room_name");
    expect(label("Family Room", 6)).toBe("unknown/room_name");
    expect(label("6 Bed Room", 6)).toBe("one_room/room_name");
    expect(label("Junior Suite", 4)).toBe("unknown/party_search");
    expect(label("Studio Apartment", 4)).toBe("unknown/party_search");
    expect(label("Bed in 8-Bed Dormitory", 4)).toBe("unknown/party_search");
  });

  it("gives no ratio verdict above 4 guests (three rooms would not show as doubling)", () => {
    expect(roomFit(quote("trivago", 15000, { two_adult_per_night: 5000 }), 6).fit).toBe("unknown");
    expect(roomFit(quote("trivago", 10000, { two_adult_per_night: 5000 }), 6).fit).toBe("unknown");
    expect(roomFit(quote("trivago", 10000, { two_adult_per_night: 5000 }), 4).fit).toBe("two_rooms");
  });

  it("sorts and filters by the one-room price, not a cheaper unknown price", async () => {
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
    const p = provider("x", async () => [mk("1", 3000, 7000), mk("2", 5000, 6000)]);
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
    // Hotel 1 is cheapest only on trivago's unknown ₹3,000; on one-room prices Hotel 2 (₹6,000) wins.
    expect(r.hotels.map((h) => h.name)).toEqual(["Hotel 2", "Hotel 1"]);
    expect(r.hotels.map((h) => h.room_status)).toEqual(["one_room", "one_room"]);
    const capped = await searchHotels(d, q, { sort: "price", max_price_inr: 6500 });
    expect(capped.hotels.map((h) => h.name)).toEqual(["Hotel 2"]);
  });
});

describe("verify_room failures", () => {
  it("reports a failed 2-adult re-search instead of silently answering unknown", async () => {
    const { AppError } = await import("../src/core/errors.js");
    const tv = provider(
      "trivago",
      vi.fn(async (q) => {
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
    const r = await c.callTool({ name: "get_hotel_rates", arguments: { ...rateArgs, verify_room: true } });
    const out = r.structuredContent as {
      prices: Record<string, any>[];
      sources_failed: { source: string }[];
    };
    expect(out.prices[0]).toMatchObject({ fit: "unknown", fit_basis: "none" });
    expect(out.sources_failed.map((f) => f.source)).toContain("verify_room:trivago");
  });

  it("notes a preloaded 2-adult lookup that found nothing, and reports one that failed", async () => {
    const { AppError } = await import("../src/core/errors.js");
    const { TRIVAGO_INFO } = await import("../src/providers/trivago.js");
    const listing: HotelCandidate = {
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
      prices: [{ ...quote("trivago", 3800), per_night_inr: null }],
    };
    const tv = provider("trivago", async () => [listing]);
    const registry = new ProviderRegistry();
    [tv.info, FX_INFO, XOTELO_INFO].forEach((i) => registry.register(i));
    const run = async (lookup: () => Promise<HotelCandidate | null>) => {
      const c = await connect(
        testDeps({
          registry,
          hotelProviders: [tv],
          memory: new HotelMemory(),
          xotelo: { info: XOTELO_INFO, rates: vi.fn(async () => []) },
          trivago: { info: TRIVAGO_INFO, lookup },
          now: () => new Date(T),
        }),
      );
      const d = { check_in: "2026-11-10", check_out: "2026-11-11", adults: 4 };
      const s = await c.callTool({ name: "search_hotels", arguments: { lat: 28.643, lng: 77.2194, ...d } });
      const id = (s.structuredContent as { hotels: { hotel_id: string }[] }).hotels[0]!.hotel_id;
      const r = await c.callTool({
        name: "get_hotel_rates",
        arguments: { hotel_id: id, ...d, verify_room: true },
      });
      return r.structuredContent as { notes: string[]; sources_failed: { source: string }[] };
    };
    const empty = await run(async () => null);
    expect(empty.notes.join("\n")).toMatch(/verify_room: trivago did not return a 2-adult price/);
    const failed = await run(async () => {
      throw new AppError("UPSTREAM_UNAVAILABLE", "trivago is down");
    });
    expect(failed.sources_failed.map((f) => f.source)).toContain("verify_room:trivago");
  });
});

describe("agent-test fixes", () => {
  it("reads 'N Bedroom' as a multi-room unit, not as how many a room sleeps", () => {
    const fit = (room: string) => roomFit(quote("hotelscasa", 1, { room }), 4);
    expect(fit("Four Bedroom, Room Only")).toMatchObject({ fit: "two_rooms", fit_basis: "room_name" });
    expect(fit("Five Bedroom Standard")).toMatchObject({ fit: "two_rooms", fit_basis: "room_name" });
    expect(fit("Deluxe Four Bed AC")).toMatchObject({ fit: "one_room", fit_basis: "room_name" });
  });

  it("get_hotel_rates falls back to the search's prices when the live re-check misses the hotel", async () => {
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
    const r = await c.callTool({ name: "get_hotel_rates", arguments: { hotel_id: id, ...dates } });
    expect(r.isError).toBeFalsy();
    const out = r.structuredContent as {
      prices: { per_night_inr: number; fit: string }[];
      notes: string[];
      room_status: string;
    };
    expect(out.prices[0]).toMatchObject({ per_night_inr: 3000, fit: "unknown" });
    expect(out.room_status).toBe("unverified");
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

  it("gets the same site's 2-adult price by name when trivago's area search leaves the hotel out", async () => {
    // Area search lists the hotel only for the party of 4; the 2-adult re-search misses it.
    const tv = provider(
      "trivago",
      vi.fn(async (q) => (q.adults === 4 ? [listing(3800)] : [])),
    );
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
    const r = await c.callTool({ name: "get_hotel_rates", arguments: { ...rateArgs, verify_room: true } });
    const p = (r.structuredContent as { prices: Record<string, any>[] }).prices.find(
      (x) => x.source === "trivago",
    )!;
    expect(p).toMatchObject({
      fit: "two_rooms",
      fit_basis: "price_ratio",
      fit_note: expect.stringMatching(/^2x trivago-seller's 2-adult price/),
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
        trivago: { info: TRIVAGO_INFO, lookup: vi.fn(async () => listing(3300)) },
      }),
    );
    const d = { check_in: "2026-11-10", check_out: "2026-11-11", adults: 4 };
    const s = await c.callTool({ name: "search_hotels", arguments: { lat: 28.643, lng: 77.2194, ...d } });
    const id = (s.structuredContent as { hotels: { hotel_id: string }[] }).hotels[0]!.hotel_id;
    const r = await c.callTool({ name: "get_hotel_rates", arguments: { hotel_id: id, ...d } });
    const prices = (
      r.structuredContent as { prices: { source: string; per_night_inr: number; fit: string }[] }
    ).prices;
    expect(prices.filter((p) => p.source === "trivago").map((p) => [p.per_night_inr, p.fit])).toEqual([
      [3300, "unknown"],
    ]);
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
    const r = await c.callTool({ name: "get_hotel_rates", arguments: { hotel_id: id, ...d } });
    const out = r.structuredContent as {
      prices: { source: string; per_night_inr: number; fit: string }[];
      room_status: string;
      cheapest_one_room_inr: number | null;
    };
    expect(lookup).toHaveBeenCalledWith(
      "tv1",
      expect.any(String),
      undefined,
      expect.objectContaining({ adults: 4 }),
    );
    expect(out.prices.map((p) => [p.source, p.per_night_inr, p.fit])).toEqual([
      ["trivago", 3100, "unknown"],
      ["hotelscasa", 4200, "one_room"],
    ]);
    expect(out).toMatchObject({ room_status: "one_room", cheapest_one_room_inr: 4200 });
  });
});

describe("get_hotel_rates timing", () => {
  it("starts the trivago and 2-adult lookups alongside the re-search, not after it", async () => {
    const events: string[] = [];
    const listing = (price: number): HotelCandidate => ({
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
      prices: [{ ...quote("trivago", price), per_night_inr: null }],
    });
    let first = true;
    const tv = provider(
      "trivago",
      vi.fn(async () => {
        if (first) return ((first = false), [listing(3800)]);
        events.push("re-search start");
        await new Promise((r) => setTimeout(r, 50));
        events.push("re-search end");
        return [];
      }),
    );
    const lookup = vi.fn(async (_id: string, _n: string, _c: string | undefined, q: { adults: number }) => {
      events.push(`lookup ${q.adults}`);
      return listing(q.adults === 2 ? 1900 : 3800);
    });
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
    const d = { check_in: "2026-11-10", check_out: "2026-11-11", adults: 4 };
    const s = await c.callTool({ name: "search_hotels", arguments: { lat: 28.643, lng: 77.2194, ...d } });
    const id = (s.structuredContent as { hotels: { hotel_id: string }[] }).hotels[0]!.hotel_id;
    const r = await c.callTool({
      name: "get_hotel_rates",
      arguments: { hotel_id: id, ...d, verify_room: true },
    });
    const end = events.indexOf("re-search end");
    const party = events.indexOf("lookup 4");
    const base = events.indexOf("lookup 2");
    expect(end).toBeGreaterThan(0);
    // The 2-adult lookup ran, and before the re-search finished.
    expect(base).toBeGreaterThanOrEqual(0);
    expect(base).toBeLessThan(end);
    // The search already had a trivago price, so the party lookup is not started early (it may run later).
    expect(party === -1 || party > end).toBe(true);
    const p = (r.structuredContent as { prices: Record<string, any>[] }).prices.find(
      (x) => x.source === "trivago",
    )!;
    expect(p).toMatchObject({ fit: "two_rooms", fit_basis: "price_ratio" });
  });
});

describe("room labels from live Ernakulam results", () => {
  const label = (room: string) => roomFit(quote("hotelscasa", 1, { room }), 4);
  it("reads a room's own capacity even when it also says '1 Bedroom'", () => {
    expect(label("Family Quadruple Room, 1 Bedroom, Private Bathroom, Room Only")).toMatchObject({
      fit: "one_room",
      fit_basis: "room_name",
    });
  });
  it.each([
    "Interconnecting 2-Bedroom Apartment, Room Only",
    "Two Bedroom Apartment, Room Only",
    "Two-Bedroom Villa, Room Only",
    "3BHK Apartment",
  ])("labels %s a multi-room unit, two rooms", (room) => {
    expect(label(room)).toMatchObject({
      fit: "two_rooms",
      fit_basis: "room_name",
      fit_note: expect.stringMatching(/bedroom unit, not one room/),
    });
  });
  it("reads 'for N adults' as the room's capacity", () => {
    expect(label("Standard Triple Room for 3 Adults, Room Only")).toMatchObject({
      fit: "unknown",
      fit_basis: "room_name",
      fit_note: expect.stringMatching(/sleeps 3/),
    });
    expect(label("Family room for 4 adults, Room Only").fit).toBe("one_room");
  });

  it("adds adults and children named in a room ('2 Adults + 2 Children' sleeps 4)", () => {
    expect(label("Family Room, 2 Adults + 2 Children, Room Only").fit).toBe("one_room");
  });

  it("still treats one-room names normally", () => {
    expect(label("Deluxe Quadruple Room, Room Only").fit).toBe("one_room");
    expect(label("Suite with Balcony, Room Only")).toMatchObject({
      fit: "unknown",
      fit_basis: "party_search",
    });
    expect(label("Four Bedroom, Room Only").fit).toBe("two_rooms");
  });
});
