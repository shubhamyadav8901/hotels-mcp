import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { cheapestSingleRoom, occupancyLabel } from "../src/core/occupancy.js";
import type { HotelSearchQuery, PriceQuote } from "../src/core/types.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { createTrivagoProvider, TRIVAGO_INFO } from "../src/providers/trivago.js";
import { createXotelo, type XoteloKeyRow } from "../src/providers/xotelo.js";
import { connect, testDeps } from "./helpers.js";

const T = "2026-10-05T10:00:00.000Z";
const quote = (per_night: number, two_adult_per_night: number | null, source = "trivago"): PriceQuote => ({
  source,
  seller: "Agoda",
  per_night,
  total: null,
  currency: "INR",
  per_night_inr: per_night,
  includes_taxes: null,
  available: null,
  refundable: null,
  url: null,
  room: null,
  two_adult_per_night,
  fetched_at: T,
});

describe("labelling 3–4 guest prices against the 2-adult price", () => {
  it("labels about double two_rooms, an extra-guest charge likely, and keeps the rest unverified", () => {
    expect(occupancyLabel(quote(4000, 2000), 4)).toMatchObject({
      occupancy: "two_rooms",
      occupancy_note: expect.stringMatching(/^2x trivago's 2-adult price/),
    });
    expect(occupancyLabel(quote(9000, 2000), 4).occupancy).toBe("two_rooms"); // implausible as one room
    expect(occupancyLabel(quote(2800, 2000), 4)).toMatchObject({
      occupancy: "likely",
      occupancy_note: expect.stringMatching(/^1.4x/),
    });
    expect(occupancyLabel(quote(2000, 2000), 4).occupancy_note).toMatch(/two-person room, or a whole unit/);
    expect(occupancyLabel(quote(2000, 2000), 4).occupancy).toBe("unverified");
    expect(occupancyLabel(quote(4000, null), 4).occupancy).toBe("unverified");
    // Five guests: three rooms would not show as doubling, so no verdict.
    expect(occupancyLabel(quote(4000, 2000), 5).occupancy).toBe("unverified");
    expect(occupancyLabel(quote(4000, 2000, "xotelo"), 3).occupancy).toBe("two_rooms");
  });

  it("never picks a two-room price as the cheapest single room", () => {
    const two = { ...quote(1500, 750), occupancy: "two_rooms" as const };
    const one = { ...quote(2800, 2000), occupancy: "likely" as const };
    expect(cheapestSingleRoom([two, one])).toBe(one);
  });
});

describe("search_hotels with two-room prices", () => {
  const hotel = (id: string, km: number, perNight: number, base: number) => ({
    source: "trivago",
    source_id: id,
    name: `Hotel ${id}`,
    lat: 9.969 + km / 111,
    lng: 76.29095,
    stars: 3,
    rating_10: 8,
    review_count: 50,
    url: null,
    fetched_at: T,
    prices: [quote(perNight, base)],
  });
  const provider = {
    info: TRIVAGO_INFO,
    search: async () => [
      hotel("doubled", 0.5, 3000, 1500),
      hotel("single", 1, 3500, 2500),
      { ...hotel("doubled-unrated", 1.5, 3000, 1500), rating_10: null },
    ],
  };
  const args = {
    lat: 9.969,
    lng: 76.29095,
    radius_km: 5,
    check_in: "2026-11-10",
    check_out: "2026-11-11",
    adults: 4,
    sort: "price",
  };
  const run = async (extra: Record<string, unknown> = {}) => {
    const registry = new ProviderRegistry();
    registry.register(provider.info);
    const c = await connect(testDeps({ registry, hotelProviders: [provider], now: () => new Date(T) }));
    const r = await c.callTool({ name: "search_hotels", arguments: { ...args, ...extra } });
    return r.structuredContent as {
      hotels: { name: string; cheapest: { occupancy: string; per_night_inr: number } }[];
      notes: string[];
    };
  };

  it("leaves out a hotel priced only as two rooms and says so", async () => {
    const sc = await run({ min_rating_pct: 60 });
    expect(sc.hotels.map((h) => h.name)).toEqual(["Hotel single"]);
    expect(sc.hotels[0]!.cheapest.occupancy).toBe("likely");
    // The unrated one is left out by the rating floor, not counted as two-room only.
    expect(sc.notes.join("\n")).toMatch(/1 hotels were left out because every price found was for two rooms/);
  });

  it("shows a cheaper two-room price it left out next to the price it kept", async () => {
    const both = {
      info: TRIVAGO_INFO,
      search: async () => [
        {
          ...hotel("mixed", 0.5, 2189, 1095),
          prices: [quote(2189, 1095), { ...quote(2833, null, "serpapi"), seller: "Google Hotels" }],
        },
      ],
    };
    const registry = new ProviderRegistry();
    registry.register(both.info);
    const c = await connect(testDeps({ registry, hotelProviders: [both], now: () => new Date(T) }));
    const r = await c.callTool({ name: "search_hotels", arguments: args });
    const h = (
      r.structuredContent as {
        hotels: Record<string, { per_night_inr: number; occupancy: string; occupancy_note: string }>[];
      }
    ).hotels[0]!;
    expect(h.cheapest!.per_night_inr).toBe(2833);
    expect(h.two_rooms_left_out).toMatchObject({ per_night_inr: 2189, occupancy: "two_rooms" });
    expect(h.two_rooms_left_out!.occupancy_note).toMatch(/^2x trivago's 2-adult price/);
  });

  it("leaves two_rooms_left_out null when the dropped price is not cheaper than the one shown", async () => {
    const dearer = {
      info: TRIVAGO_INFO,
      search: async () => [
        {
          ...hotel("mixed", 0.5, 4000, 2000),
          prices: [quote(4000, 2000), { ...quote(2833, null, "serpapi"), seller: "Google Hotels" }],
        },
      ],
    };
    const registry = new ProviderRegistry();
    registry.register(dearer.info);
    const c = await connect(testDeps({ registry, hotelProviders: [dearer], now: () => new Date(T) }));
    const r = await c.callTool({ name: "search_hotels", arguments: args });
    expect(
      (r.structuredContent as { hotels: { two_rooms_left_out: unknown }[] }).hotels[0]!.two_rooms_left_out,
    ).toBeNull();
  });

  it("lists it, labelled, with include_two_room_prices", async () => {
    const sc = await run({ include_two_room_prices: true, min_rating_pct: 60 });
    expect(
      (sc.hotels as unknown as { two_rooms_left_out: unknown }[]).every((h) => h.two_rooms_left_out === null),
    ).toBe(true);
    expect(sc.hotels.map((h) => [h.name, h.cheapest.occupancy])).toEqual([
      ["Hotel doubled", "two_rooms"],
      ["Hotel single", "likely"],
    ]);
  });
});

describe("sources fetch the 2-adult price for 3–4 guests", () => {
  const q: HotelSearchQuery = {
    lat: 9.969,
    lng: 76.29095,
    radius_km: 2,
    check_in: "2026-11-10",
    check_out: "2026-11-11",
    adults: 4,
  };

  it("trivago searches each point for 2 adults too and attaches that hotel's price", async () => {
    const call = vi.fn(async (_tool: string, args: Record<string, unknown>) => ({
      structuredContent: {
        accommodations: [
          {
            accommodation_id: "a",
            accommodation_name: "Hotel A",
            latitude: 9.97,
            longitude: 76.291,
            currency: "INR",
            price_per_night: args.adults === 2 ? "₹1,500" : "₹3,000",
            price_per_stay: args.adults === 2 ? "₹1,500" : "₹3,000",
            advertisers: "Agoda",
          },
        ],
      },
    }));
    const out = await createTrivagoProvider(call, () => new Date(T)).searchWithCoverage!(q);
    expect(call.mock.calls.map((c) => c[1].adults)).toEqual([4, 2]);
    expect(out.hotels[0]!.prices[0]).toMatchObject({ per_night: 3000, two_adult_per_night: 1500 });
    expect(out.coverage_note).toMatch(/2-adult prices found for 1 of 1 priced hotels/);
  });

  it("trivago looks a hotel up by name for 2 adults when its area search for 2 adults leaves it out", async () => {
    const acc = (id: string, price: string) => ({
      accommodation_id: id,
      accommodation_name: `Hotel ${id}`,
      latitude: 9.97,
      longitude: 76.291,
      currency: "INR",
      price_per_night: price,
      price_per_stay: price,
      advertisers: "Agoda",
    });
    const call = vi.fn(async (tool: string, args: Record<string, unknown>) => ({
      structuredContent: {
        accommodations:
          tool === "trivago-accommodation-search"
            ? [acc(args.query === "Hotel b" ? "b" : "other", "₹2,000")]
            : args.adults === 2
              ? [acc("a", "₹1,500")]
              : [acc("a", "₹3,000"), acc("b", "₹2,800")],
      },
    }));
    const out = await createTrivagoProvider(call, () => new Date(T)).searchWithCoverage!(q);
    const byName = call.mock.calls.filter((c) => c[0] === "trivago-accommodation-search");
    expect(byName.map((c) => [c[1].query, c[1].adults])).toEqual([["Hotel b", 2]]);
    expect(out.hotels.map((h) => [h.source_id, h.prices[0]!.two_adult_per_night])).toEqual([
      ["a", 1500],
      ["b", 2000],
    ]);
  });

  it("trivago skips the 2-adult search for 2 guests", async () => {
    const call = vi.fn(async () => ({ structuredContent: { accommodations: [] } }));
    await createTrivagoProvider(call, () => new Date(T)).searchWithCoverage!({ ...q, adults: 2 });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("Xotelo fetches each priced hotel's 2-adult rates and matches them by seller", async () => {
    const fixture = (name: string): unknown =>
      JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      return new Response(
        JSON.stringify(fixture(url.includes("/api/list") ? "xotelo-list.json" : "xotelo-rates.json")),
      );
    }) as unknown as typeof fetch;
    const keys: XoteloKeyRow[] = [{ key: "g9900001", name: "Testpur", lat: 28.61, lng: 77.21, hotels: 3 }];
    const xotelo = createXotelo({
      http: { userAgent: "test", fetchImpl, retries: 0 },
      keys,
      minIntervalMs: 0,
      ratesForNearest: 1,
    });
    const out = await xotelo.searchWithCoverage!({ ...q, lat: 28.6, lng: 77.2, radius_km: 10 });
    const rateAdults = urls
      .filter((u) => u.includes("/api/rates"))
      .map((u) => new URL(u).searchParams.get("adults"));
    expect(rateAdults).toEqual(["4", "2"]);
    const prices = out.hotels[0]!.prices;
    expect(prices.length).toBeGreaterThan(0);
    // Same fixture for both, so each seller's 2-adult price equals its party price.
    for (const p of prices) expect(p.two_adult_per_night).toBe(p.per_night);
    expect(out.coverage_note).toMatch(/2-adult prices found for 1 of them/);
  });

  it("Xotelo books the party's rates before the 2-adult ones, all within the search budget", async () => {
    const fixture = (name: string): unknown =>
      JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
    const rateCalls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/rates")) rateCalls.push(new URL(url).searchParams.get("adults")!);
      return new Response(
        JSON.stringify(fixture(url.includes("/api/list") ? "xotelo-list.json" : "xotelo-rates.json")),
      );
    }) as unknown as typeof fetch;
    // A clock that moves only when the throttle sleeps, with the production spacing of 1.2 s.
    let t = Date.parse(T);
    const xotelo = createXotelo({
      http: { userAgent: "test", fetchImpl, retries: 0 },
      keys: [{ key: "g9900001", name: "Testpur", lat: 28.61, lng: 77.21, hotels: 3 }],
      now: () => t,
      sleep: async (ms: number) => {
        const target = t + ms;
        await Promise.resolve();
        t = Math.max(t, target);
      },
      ratesForNearest: 3,
      searchBudgetMs: 14_000,
    });
    const out = await xotelo.searchWithCoverage!({ ...q, lat: 28.6, lng: 77.2, radius_km: 10 });
    expect(rateCalls).toEqual(["4", "4", "4", "2", "2", "2"]);
    expect(out.coverage_note).toMatch(/2-adult prices found for 3 of them/);
  });
});
