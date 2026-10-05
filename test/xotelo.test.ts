import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { HotelSearchQuery } from "../src/core/types.js";
import {
  createXotelo,
  parseTripadvisorUrl,
  pickXoteloKeys,
  xoteloError,
  type XoteloKeyRow,
} from "../src/providers/xotelo.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const query: HotelSearchQuery = {
  lat: 28.6,
  lng: 77.2,
  radius_km: 3,
  check_in: "2026-11-10",
  check_out: "2026-11-11",
  adults: 2,
};

const KEYS: XoteloKeyRow[] = [
  { key: "g9900001", name: "Testpur", lat: 28.61, lng: 77.21, hotels: 3 },
  { key: "g9900009", name: "Faraway", lat: 19.07, lng: 72.87, hotels: 500 },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** fetch mock routing /list and /rates to fixtures (or overrides) and recording URLs. */
function mockFetch(overrides: { list?: unknown; rates?: unknown } = {}) {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/api/list")) return json(overrides.list ?? fixture("xotelo-list.json"));
    return json(overrides.rates ?? fixture("xotelo-rates.json"));
  });
  return { urls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

/** A fake clock whose sleep advances time, so throttle gaps are observable without waiting. */
function fakeClock() {
  let t = Date.parse("2026-10-05T10:00:00Z");
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => (t += ms),
    sleeps,
  };
}

function make(overrides: Parameters<typeof mockFetch>[0] = {}, extra: { keys?: XoteloKeyRow[] } = {}) {
  const m = mockFetch(overrides);
  const clock = fakeClock();
  const xotelo = createXotelo({
    http: { userAgent: "test", fetchImpl: m.fetchImpl, retries: 0 },
    keys: extra.keys ?? KEYS,
    now: clock.now,
    sleep: clock.sleep,
  });
  return { ...m, clock, xotelo };
}

describe("xotelo helpers", () => {
  it("parses the hotel's own geo, id and place from the TripAdvisor URL", () => {
    expect(
      parseTripadvisorUrl(
        "https://www.tripadvisor.com/Hotel_Review-g9900002-d9900102-Reviews-Sample_Hostel_Testpur-Sub_Area_Testpur_Testpur_District_Examplestan.html",
      ),
    ).toEqual({ geo: "g9900002", id: "d9900102", place: "Sub Area Testpur Testpur District Examplestan" });
    expect(parseTripadvisorUrl("https://example.invalid/x")).toBeNull();
  });

  it("picks at most 3 keys within radius + 10 km, nearest first", () => {
    const keys: XoteloKeyRow[] = [
      { key: "gA", name: "A", lat: 28.7, lng: 77.2, hotels: 1 }, // ~11 km
      { key: "gB", name: "B", lat: 28.6, lng: 77.2, hotels: 1 }, // 0 km
      { key: "gC", name: "C", lat: 28.65, lng: 77.2, hotels: 1 }, // ~5.6 km
      { key: "gD", name: "D", lat: 28.62, lng: 77.2, hotels: 1 }, // ~2.2 km
      { key: "gE", name: "E", lat: 29.6, lng: 77.2, hotels: 1 }, // ~111 km
    ];
    expect(pickXoteloKeys(keys, { lat: 28.6, lng: 77.2 }, 2).map((k) => k.key)).toEqual(["gB", "gD", "gC"]);
    expect(pickXoteloKeys(keys, { lat: 28.6, lng: 77.2 }, 0.5, 10).map((k) => k.key)).toEqual([
      "gB",
      "gD",
      "gC",
    ]);
    expect(pickXoteloKeys(keys, { lat: 20, lng: 70 }, 5)).toEqual([]);
  });

  it.each([
    [{ status_code: 400, message: "Invalid location_key" }, "NOT_FOUND"],
    [{ status_code: 400, message: "limit must be less than or equal to 100" }, "SCHEMA_CHANGED"],
    [
      { status_code: 400, message: "chk_out (2026-11-10) must be greater than chk_in (2026-11-11)" },
      "INVALID_INPUT",
    ],
    [{ status_code: 401, message: "This endpoint is available only for RapidAPI" }, "UPSTREAM_UNAVAILABLE"],
    [{ status_code: 500, message: "boom" }, "UPSTREAM_UNAVAILABLE"],
    [{ status_code: 429, message: "slow down" }, "RATE_LIMITED"],
  ])("maps in-band error %o to %s", (err, code) => {
    expect(xoteloError(err).code).toBe(code);
  });
});

describe("xotelo provider", () => {
  it("lists hotels of nearby keys only, filters by radius and prices the nearest", async () => {
    const { xotelo, urls } = make();
    const hotels = await xotelo.search(query);

    const listCalls = urls.filter((u) => u.includes("/api/list"));
    expect(listCalls).toHaveLength(1); // the far key is not queried; short page stops paging
    const list = new URL(listCalls[0]!);
    expect(Object.fromEntries(list.searchParams)).toEqual({
      location_key: "g9900001",
      limit: "100",
      offset: "0",
      sort: "best_value",
    });

    // Demo Residency (~6 km away) is outside 3 km.
    expect(hotels.map((h) => h.name)).toEqual(["Hotel Fixture Grand", "Sample Hostel Testpur"]);
    const grand = hotels[0]!;
    expect(grand).toMatchObject({
      source: "xotelo",
      source_id: "g9900001-d9900101",
      rating_10: 9,
      review_count: 1234,
      stars: null,
      url: expect.stringContaining("Hotel_Review-g9900001-d9900101"),
      // Stamped after the throttled list + 2 rates calls (2 gaps of 1.2 s on the fake clock).
      fetched_at: "2026-10-05T10:00:02.400Z",
    });
    // The canonical key uses the URL's geo, not the rewritten `key` prefix.
    expect(hotels[1]!.source_id).toBe("g9900002-d9900102");
    expect(hotels[1]!.rating_10).toBe(8.2);

    const rateCalls = urls.filter((u) => u.includes("/api/rates")).map((u) => new URL(u).searchParams);
    expect(rateCalls).toHaveLength(2);
    expect(Object.fromEntries(rateCalls[0]!)).toEqual({
      hotel_key: "g9900001-d9900101",
      chk_in: "2026-11-10",
      chk_out: "2026-11-11",
      adults: "2",
      rooms: "1",
      currency: "INR",
    });

    expect(grand.prices.map((p) => [p.seller, p.per_night])).toEqual([
      ["Booking.com", 2100],
      ["Agoda.com", 1985],
      ["Vio.com", 2450],
    ]);
    expect(grand.prices[0]).toMatchObject({
      source: "xotelo",
      currency: "INR",
      per_night_inr: 2100,
      includes_taxes: null,
      total: null,
    });
  });

  it("prices only the nearest N hotels and leaves the rest unpriced", async () => {
    const m = mockFetch();
    const clock = fakeClock();
    const xotelo = createXotelo({
      http: { userAgent: "test", fetchImpl: m.fetchImpl, retries: 0 },
      keys: KEYS,
      now: clock.now,
      sleep: clock.sleep,
      ratesForNearest: 1,
    });
    const hotels = await xotelo.search({ ...query, radius_km: 10 });
    expect(hotels).toHaveLength(3);
    expect(hotels.map((h) => h.prices.length)).toEqual([3, 0, 0]);
    expect(hotels[2]!.rating_10).toBeNull(); // rating 0 = no reviews
    expect(hotels[2]!.review_count).toBeNull();
  });

  it("returns hotels with prices: [] when Xotelo has no rates", async () => {
    const { xotelo } = make({
      rates: {
        error: null,
        result: { chk_in: "2026-11-10", chk_out: "2026-11-11", currency: "INR", rates: [] },
      },
    });
    const hotels = await xotelo.search(query);
    expect(hotels).toHaveLength(2);
    expect(hotels.every((h) => h.prices.length === 0)).toBe(true);
  });

  it("adds a stated tax and marks the price as tax-inclusive", async () => {
    const { xotelo } = make({
      rates: {
        error: null,
        result: { currency: "INR", rates: [{ code: "X", name: "Example OTA", rate: 1000, tax: 180 }] },
      },
    });
    const quotes = await xotelo.rates("g1-d2", "2026-11-10", "2026-11-11");
    expect(quotes).toEqual([
      expect.objectContaining({
        seller: "Example OTA",
        per_night: 1180,
        includes_taxes: true,
        source: "xotelo",
      }),
    ]);
  });

  it("maps an HTTP-200 error field to an AppError", async () => {
    const { xotelo } = make({
      list: { error: { status_code: 400, message: "Invalid location_key" }, result: null },
    });
    await expect(xotelo.search(query)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const bad = make({
      rates: { error: { status_code: 400, message: "chk_out must be greater than chk_in" } },
    });
    await expect(bad.xotelo.rates("g1-d2", "2026-11-11", "2026-11-10")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("reports a changed payload shape as SCHEMA_CHANGED", async () => {
    const { xotelo } = make({ list: { error: null, result: { hotels: [] } } });
    await expect(xotelo.search(query)).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
  });

  it("returns no hotels (and makes no calls) when no key is near the point", async () => {
    const { xotelo, urls } = make();
    expect(await xotelo.search({ ...query, lat: 10, lng: 90 })).toEqual([]);
    expect(urls).toHaveLength(0);
  });

  it("spaces requests to data.xotelo.com at least 1.2 s apart", async () => {
    const m = mockFetch();
    const clock = fakeClock();
    const starts: number[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      starts.push(clock.now());
      return (m.fetchImpl as (i: unknown) => Promise<Response>)(input);
    }) as typeof fetch;
    const xotelo = createXotelo({
      http: { userAgent: "test", fetchImpl, retries: 0 },
      keys: KEYS,
      now: clock.now,
      sleep: clock.sleep,
    });
    await xotelo.search({ ...query, radius_km: 10 }); // 1 list + 3 rates
    expect(starts).toHaveLength(4);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(1200);
  });

  it("caches /list for 7 days and /rates for 3 hours (empty rates for 1 hour)", async () => {
    const { xotelo, urls, clock } = make();
    await xotelo.search(query);
    expect(urls).toHaveLength(3);
    await xotelo.search(query);
    expect(urls).toHaveLength(3);

    clock.advance(3 * 3_600_000 + 1); // rates expire, list does not
    await xotelo.search(query);
    expect(urls.filter((u) => u.includes("/api/list"))).toHaveLength(1);
    expect(urls.filter((u) => u.includes("/api/rates"))).toHaveLength(4);

    const empty = make({ rates: { error: null, result: { currency: "INR", rates: [] } } });
    await empty.xotelo.rates("g1-d2", "2026-11-10", "2026-11-11");
    empty.clock.advance(30 * 60_000);
    await empty.xotelo.rates("g1-d2", "2026-11-10", "2026-11-11");
    expect(empty.urls).toHaveLength(1);
    empty.clock.advance(31 * 60_000);
    await empty.xotelo.rates("g1-d2", "2026-11-10", "2026-11-11");
    expect(empty.urls).toHaveLength(2);
  });
});
