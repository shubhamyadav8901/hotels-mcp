import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { coverPoints, haversineKm } from "../src/core/geo.js";
import type { HotelSearchQuery } from "../src/core/types.js";
import { createHotelsCasaProvider } from "../src/providers/hotelscasa.js";
import { createSerpApi } from "../src/providers/serpapi.js";
import { createTrivagoProvider } from "../src/providers/trivago.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { connect, testDeps } from "./helpers.js";

const NOW = () => new Date("2026-10-05T10:00:00Z");
const ERS = { lat: 9.969, lng: 76.29095 };
const q = (radius_km: number): HotelSearchQuery => ({
  ...ERS,
  radius_km,
  check_in: "2026-11-10",
  check_out: "2026-11-11",
  adults: 4,
});

describe("coverPoints", () => {
  it.each([
    [2, 1],
    [5, 7],
    [10, 13],
  ])("covers a %s km circle with %s search points, all inside it", (r, n) => {
    const pts = coverPoints(ERS, r);
    expect(pts).toHaveLength(n);
    for (const p of pts) expect(haversineKm(ERS, p)).toBeLessThanOrEqual(r);
  });
});

describe("trivago across a wide radius", () => {
  const acc = (id: string, lat: number, lng: number) => ({
    accommodation_id: id,
    accommodation_name: `Hotel ${id}`,
    latitude: lat,
    longitude: lng,
    currency: "INR",
    price_per_night: "₹2,000",
    price_per_stay: "₹2,000",
    advertisers: "Agoda",
  });

  it("searches every grid point, merges by id, keeps hotels inside the radius and tolerates a failed point", async () => {
    let n = 0;
    const call = vi.fn(async (_tool: string, args: Record<string, unknown>) => {
      n++;
      if (n === 3) throw new Error("trivago hiccup");
      const lat = args.latitude as number,
        lng = args.longitude as number;
      // Each point returns one hotel at that point, plus a shared one near the station and one far outside.
      return {
        structuredContent: {
          accommodations: [
            acc(`p${lat},${lng}`, lat, lng),
            acc("shared", 9.97, 76.291),
            acc("far", 10.4, 76.29),
          ],
        },
      };
    });
    const out = await createTrivagoProvider(call, NOW).searchWithCoverage!(q(10));
    // 13 points, each searched once for the party.
    expect(call).toHaveBeenCalledTimes(13);
    expect(
      call.mock.calls.every((c) => c[0] === "trivago-accommodation-radius-search" && c[1].adults === 4),
    ).toBe(true);
    const ids = out.hotels.map((h) => h.source_id);
    expect(ids.filter((i) => i === "shared")).toHaveLength(1);
    expect(ids).not.toContain("far");
    expect(out.hotels).toHaveLength(12 + 1); // 12 answering points + the shared hotel
    expect(out.coverage_note).toMatch(/searched 12 of 13 points/);
  });

  it("uses one point for a small radius", async () => {
    const call = vi.fn(async () => ({ structuredContent: { accommodations: [acc("a", 9.97, 76.291)] } }));
    const out = await createTrivagoProvider(call, NOW).searchWithCoverage!(q(2));
    expect(call).toHaveBeenCalledTimes(1);
    expect(out.coverage_note).toMatch(/searched 1 point/);
  });
});

describe("HotelsCasa pages", () => {
  const page = (n: number, more: boolean) => ({
    structuredContent: {
      availability_checked: true,
      next_page: more ? n + 1 : null,
      items: Array.from({ length: more ? 10 : 3 }, (_, i) => ({
        hotel_key: `p${n}-${i}`,
        name: `Hotel ${n}-${i}`,
        lat: 9.97,
        lng: 76.29,
        price_eur_per_night: 20,
        currency: "EUR",
        available: true,
      })),
    },
  });

  it("fetches up to 5 pages for a wide radius, the rest in parallel after page 1", async () => {
    const call = vi.fn(async (_t: string, args: Record<string, unknown>) =>
      page(args.page as number, (args.page as number) < 4),
    );
    const out = await createHotelsCasaProvider(call, { now: NOW }).searchWithCoverage!({
      ...q(10),
      prefer: { sort: "price" },
    });
    expect(call.mock.calls.map((c) => c[1].page)).toEqual([1, 2, 3, 4, 5]);
    expect(out.hotels).toHaveLength(10 + 10 + 10 + 3);
    expect(out.coverage_note).toMatch(/4 pages of up to 10 \(cheapest first\)/);
  });

  it("keeps 2 pages for a small radius and says when more exist", async () => {
    const call = vi.fn(async (_t: string, args: Record<string, unknown>) => page(args.page as number, true));
    const out = await createHotelsCasaProvider(call, { now: NOW }).searchWithCoverage!(q(2));
    expect(call).toHaveBeenCalledTimes(2);
    expect(out.coverage_note).toMatch(/more exist beyond 20/);
  });
});

describe("Google Hotels pages", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/serpapi-google-hotels.json", import.meta.url), "utf8"),
  );
  it("follows next_page_token up to maxPages, one quota search per page", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const u = String(input);
      urls.push(u);
      const token = new URL(u).searchParams.get("next_page_token");
      return new Response(
        JSON.stringify({
          ...fixture,
          serpapi_pagination: { next_page_token: token ? `t${Number(token.slice(1)) + 1}` : "t1" },
        }),
      );
    }) as unknown as typeof fetch;
    const serp = createSerpApi({
      apiKey: "k",
      http: { userAgent: "t", fetchImpl, retries: 0 },
      maxPages: 2,
      monthlyQuota: 10,
    });
    const out = await serp.searchWithCoverage!({ ...q(10), place: "Ernakulam Junction" });
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]!).searchParams.get("next_page_token")).toBe("t1");
    expect(serp.quotaRemaining()).toBe(8);
    expect(out.coverage_note).toMatch(/2 Google Hotels pages .*more pages exist/);
  });
});

describe("coverage in search_hotels", () => {
  it("reports what each source returned within the radius", async () => {
    const T = "2026-10-05T10:00:00.000Z";
    const provider = {
      info: {
        id: "src",
        name: "src",
        kind: "hotel-prices" as const,
        official: true,
        needsKey: false,
        limitations: [],
      },
      search: async () => [],
      searchWithCoverage: async () => ({
        hotels: [0.5, 2.4].map((km, i) => ({
          source: "src",
          source_id: `${i}`,
          name: `Hotel ${i}`,
          lat: 9.969 + km / 111,
          lng: 76.29095,
          stars: 3,
          rating_10: 8,
          review_count: 9,
          url: null,
          fetched_at: T,
          prices: [
            {
              source: "src",
              seller: null,
              per_night: 2000,
              total: null,
              currency: "INR",
              per_night_inr: null,
              includes_taxes: null,
              available: null,
              refundable: null,
              url: null,
              room: null,
              fetched_at: T,
            },
          ],
        })),
        coverage_note: "about 25 hotels per point searched",
      }),
    };
    const registry = new ProviderRegistry();
    registry.register(provider.info);
    const c = await connect(testDeps({ registry, hotelProviders: [provider], now: () => new Date(T) }));
    const r = await c.callTool({
      name: "search_hotels",
      arguments: { ...ERS, radius_km: 10, check_in: "2026-11-10", check_out: "2026-11-11", adults: 4 },
    });
    const sc = r.structuredContent as { coverage: unknown[]; notes: string[] };
    expect(sc.coverage).toEqual([
      { source: "src", hotels: 2, priced: 2, max_km: 2.4, note: "about 25 hotels per point searched" },
    ]);
    expect(sc.notes[0]).toMatch(/not every hotel in the radius/);
  });
});

describe("review fixes for coverage", () => {
  it("HotelsCasa keeps the pages that answered when a later page fails", async () => {
    const item = (n: number, i: number) => ({
      hotel_key: `p${n}-${i}`,
      name: `H ${n}-${i}`,
      lat: 9.97,
      lng: 76.29,
      price_eur_per_night: 20,
      currency: "EUR",
      available: true,
    });
    const call = vi.fn(async (_t: string, args: Record<string, unknown>) => {
      const n = args.page as number;
      if (n === 3) throw new Error("page 3 failed");
      return {
        structuredContent: {
          availability_checked: true,
          next_page: n + 1,
          items: Array.from({ length: 10 }, (_, i) => item(n, i)),
        },
      };
    });
    const out = await createHotelsCasaProvider(call, { now: NOW }).searchWithCoverage!(q(10));
    expect(out.hotels).toHaveLength(40); // pages 1, 2, 4, 5
    expect(out.coverage_note).toMatch(/1 page failed/);
  });

  it("trivago drops a grid point that misses its time budget and keeps the rest", async () => {
    let n = 0;
    const call = vi.fn(async (_t: string, args: Record<string, unknown>) => {
      if (n++ === 0) await new Promise((r) => setTimeout(r, 300)); // the first point is slow
      return {
        structuredContent: {
          accommodations: [
            {
              accommodation_id: `${args.latitude},${args.longitude}`,
              accommodation_name: "H",
              latitude: args.latitude as number,
              longitude: args.longitude as number,
              currency: "INR",
              price_per_night: "₹2,000",
              price_per_stay: "₹2,000",
              advertisers: "Agoda",
            },
          ],
        },
      };
    });
    const out = await createTrivagoProvider(call, NOW, 50).searchWithCoverage!(q(5));
    expect(out.hotels).toHaveLength(6);
    expect(out.coverage_note).toMatch(/searched 6 of 7 points/);
  });

  it("Google notes a failed later page instead of hiding it", async () => {
    const fixture = JSON.parse(
      readFileSync(new URL("./fixtures/serpapi-google-hotels.json", import.meta.url), "utf8"),
    );
    let calls = 0;
    const fetchImpl = vi.fn(async () =>
      calls++ === 0
        ? new Response(JSON.stringify({ ...fixture, serpapi_pagination: { next_page_token: "stale" } }))
        : new Response(JSON.stringify({ error: "Invalid next_page_token" })),
    ) as unknown as typeof fetch;
    const serp = createSerpApi({ apiKey: "k", http: { userAgent: "t", fetchImpl, retries: 0 }, maxPages: 2 });
    // The fixture's hotels are in Delhi.
    const out = await serp.searchWithCoverage!({
      ...q(10),
      lat: 28.643,
      lng: 77.2194,
      place: "New Delhi railway station",
    });
    expect(out.hotels.length).toBeGreaterThan(0);
    expect(out.coverage_note).toMatch(/fetching page 2 failed/);
  });
});
