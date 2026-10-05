import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { cheapestOneRoom, rankPrice, roomFit } from "../src/core/occupancy.js";
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

describe("labelling 3–4 guest prices against the same site's 2-adult price", () => {
  it("labels about double two_rooms and leaves every other ratio unknown", () => {
    expect(roomFit(quote(4000, 2000), 4)).toMatchObject({
      fit: "two_rooms",
      fit_basis: "price_ratio",
      fit_note: expect.stringMatching(/^2x Agoda's 2-adult price/),
    });
    // Far above double is not proof of two rooms, and an extra-guest charge is not proof of one.
    expect(roomFit(quote(9000, 2000), 4)).toMatchObject({ fit: "unknown", fit_basis: "price_ratio" });
    expect(roomFit(quote(2800, 2000), 4)).toMatchObject({
      fit: "unknown",
      fit_basis: "price_ratio",
      fit_note: expect.stringMatching(/this is 1.4x Agoda's 2-adult price/),
    });
    expect(roomFit(quote(2000, 2000), 4)).toMatchObject({ fit: "unknown", fit_basis: "price_ratio" });
    expect(roomFit(quote(4000, null), 4)).toMatchObject({ fit: "unknown", fit_basis: "none" });
    // Five guests: three rooms would not show as doubling, so no verdict.
    expect(roomFit(quote(4000, 2000), 5)).toMatchObject({ fit: "unknown", fit_basis: "price_ratio" });
    expect(roomFit(quote(4000, 2000, "xotelo"), 3).fit).toBe("two_rooms");
  });

  it("keeps a 2.6x same-site price unknown: family rooms often cost 2.5x or more", () => {
    expect(roomFit(quote(5200, 2000), 4)).toMatchObject({
      fit: "unknown",
      fit_basis: "price_ratio",
      fit_note: expect.stringMatching(/2.6x/),
    });
  });

  it("never picks a two-room price as the cheapest one room, and ranks by a price not known to be two rooms", () => {
    const two = { ...quote(1500, 750), fit: "two_rooms" as const };
    const unknown = { ...quote(2800, 2000), fit: "unknown" as const };
    const one = { ...quote(3200, null), fit: "one_room" as const };
    expect(cheapestOneRoom([two, unknown, one])).toBe(one);
    expect(cheapestOneRoom([two, unknown])).toBeNull();
    expect(rankPrice([two, unknown])).toBe(unknown);
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
  type Out = {
    hotels: {
      name: string;
      room_status: string;
      cheapest: { fit: string; fit_basis: string; fit_note: string; per_night_inr: number };
      rank_price: { per_night_inr: number; fit: string } | null;
    }[];
    notes: string[];
  };
  const runWith = async (search: () => Promise<unknown[]>, extra: Record<string, unknown> = {}) => {
    const p = { info: TRIVAGO_INFO, search } as typeof provider;
    const registry = new ProviderRegistry();
    registry.register(p.info);
    const c = await connect(testDeps({ registry, hotelProviders: [p], now: () => new Date(T) }));
    const r = await c.callTool({ name: "search_hotels", arguments: { ...args, ...extra } });
    return r.structuredContent as Out;
  };
  const run = (extra: Record<string, unknown> = {}) => runWith(provider.search, extra);

  it("keeps a hotel priced only as two rooms, labelled two_rooms_only and sorted after unverified ones", async () => {
    const sc = await run({ min_rating_pct: 60 });
    // Hotel doubled is cheaper (₹3,000) but only as two rooms, so it comes after Hotel single (₹3,500).
    expect(sc.hotels.map((h) => [h.name, h.room_status, h.cheapest.fit])).toEqual([
      ["Hotel single", "unverified", "unknown"],
      ["Hotel doubled", "two_rooms_only", "two_rooms"],
    ]);
    // The unrated one is left out by the rating floor; nothing is left out for being two rooms.
    expect(sc.notes.join("\n")).toMatch(
      /Of 2 hotels, 0 have a price known to be one room for 4, 1 only prices known to be two rooms .*and 1 are unverified/,
    );
    expect(sc.notes.join("\n")).not.toMatch(/left out because every price/);
  });

  it("shows a cheaper two-room price as cheapest, but ranks the hotel by its price not known to be two rooms", async () => {
    const sc = await runWith(async () => [
      {
        ...hotel("mixed", 0.5, 2189, 1095),
        prices: [quote(2189, 1095), { ...quote(2833, null, "serpapi"), seller: "Google Hotels" }],
      },
      hotel("plain", 1, 2500, 2000),
    ]);
    expect(sc.hotels.map((h) => h.name)).toEqual(["Hotel plain", "Hotel mixed"]);
    const h = sc.hotels[1]!;
    expect(h.cheapest).toMatchObject({ per_night_inr: 2189, fit: "two_rooms", fit_basis: "price_ratio" });
    expect(h.cheapest.fit_note).toMatch(/^2x Agoda's 2-adult price/);
    expect(h.room_status).toBe("unverified");
    // Ranked by the price not known to be two rooms, which the output shows as rank_price.
    expect(h.rank_price).toMatchObject({ per_night_inr: 2833, fit: "unknown" });
  });

  it("shows the cheaper unknown price as cheapest when the two-room price is dearer", async () => {
    const sc = await runWith(async () => [
      {
        ...hotel("mixed", 0.5, 4000, 2000),
        prices: [quote(4000, 2000), { ...quote(2833, null, "serpapi"), seller: "Google Hotels" }],
      },
    ]);
    expect(sc.hotels[0]!.cheapest).toMatchObject({
      per_night_inr: 2833,
      fit: "unknown",
      fit_basis: "party_search",
    });
    expect(sc.hotels[0]!.room_status).toBe("unverified");
  });

  it("no longer offers include_two_room_prices: no hotel is hidden for two-room prices", async () => {
    const registry = new ProviderRegistry();
    registry.register(provider.info);
    const c = await connect(testDeps({ registry, hotelProviders: [provider], now: () => new Date(T) }));
    const tools = await c.listTools();
    const search = tools.tools.find((t) => t.name === "search_hotels")!;
    expect(Object.keys(search.inputSchema.properties ?? {})).not.toContain("include_two_room_prices");
    const sc = await run();
    expect(sc.hotels.map((h) => h.name).sort()).toEqual([
      "Hotel doubled",
      "Hotel doubled-unrated",
      "Hotel single",
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
    expect(out.coverage_note).toMatch(/same-site 2-adult prices found for 1 of 1 priced hotels/);
  });

  it("trivago attaches no 2-adult price from a different booking site, so an exact 2.0x stays unknown", async () => {
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
            advertisers: args.adults === 2 ? "Booking.com" : "Agoda",
          },
        ],
      },
    }));
    const out = await createTrivagoProvider(call, () => new Date(T)).searchWithCoverage!(q);
    const p = out.hotels[0]!.prices[0]!;
    expect(p).toMatchObject({ seller: "Agoda", per_night: 3000, two_adult_per_night: null });
    expect(roomFit({ ...p, per_night_inr: 3000 }, 4)).toMatchObject({ fit: "unknown", fit_basis: "none" });
    expect(out.coverage_note).toMatch(/same-site 2-adult prices found for 0 of 1 priced hotels/);
  });

  it("trivago counts failed 2-adult points and name lookups in the coverage note", async () => {
    const call = vi.fn(async (_tool: string, args: Record<string, unknown>) => {
      if (args.adults === 2) throw new Error("trivago is down");
      return {
        structuredContent: {
          accommodations: [
            {
              accommodation_id: "a",
              accommodation_name: "Hotel A",
              latitude: 9.97,
              longitude: 76.291,
              currency: "INR",
              price_per_night: "₹3,000",
              price_per_stay: "₹3,000",
              advertisers: "Agoda",
            },
          ],
        },
      };
    });
    const out = await createTrivagoProvider(call, () => new Date(T)).searchWithCoverage!(q);
    expect(out.hotels[0]!.prices[0]!.two_adult_per_night).toBeNull();
    expect(out.coverage_note).toMatch(
      /same-site 2-adult prices found for 0 of 1 priced hotels.*\(1 2-adult points failed\) \(1 name lookups failed\)/,
    );
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

  it("Xotelo attaches a seller's 2-adult price only when both rates state tax the same way", async () => {
    const rates = (adults: string) => ({
      error: null,
      result: {
        chk_in: "2026-11-10",
        chk_out: "2026-11-11",
        currency: "INR",
        rates:
          adults === "2"
            ? [
                { code: "BookingCom", name: "Booking.com", rate: 1800, tax: 200 },
                { code: "Agoda", name: "Agoda.com", rate: 1000, tax: null },
              ]
            : [
                { code: "BookingCom", name: "Booking.com", rate: 4000, tax: null },
                { code: "Agoda", name: "Agoda.com", rate: 2000, tax: null },
              ],
      },
      timestamp: 1791150000000,
    });
    const list = JSON.parse(readFileSync(new URL("./fixtures/xotelo-list.json", import.meta.url), "utf8"));
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return new Response(
        JSON.stringify(url.pathname.includes("/api/list") ? list : rates(url.searchParams.get("adults")!)),
      );
    }) as unknown as typeof fetch;
    const xotelo = createXotelo({
      http: { userAgent: "test", fetchImpl, retries: 0 },
      keys: [{ key: "g9900001", name: "Testpur", lat: 28.61, lng: 77.21, hotels: 3 }],
      minIntervalMs: 0,
      ratesForNearest: 1,
    });
    const out = await xotelo.searchWithCoverage!({ ...q, lat: 28.6, lng: 77.2, radius_km: 10 });
    const bySeller = Object.fromEntries(out.hotels[0]!.prices.map((p) => [p.seller, p.two_adult_per_night]));
    // Booking.com's 2-adult rate adds tax its party rate doesn't state: not comparable.
    expect(bySeller).toEqual({ "Booking.com": null, "Agoda.com": 1000 });
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
