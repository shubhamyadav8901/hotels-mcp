import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/core/errors.js";
import { HotelMemory } from "../src/core/hotel-memory.js";
import type { HotelCandidate, PriceQuote } from "../src/core/types.js";
import { FX_INFO } from "../src/providers/fx.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { HotelSearchProvider } from "../src/providers/types.js";
import { XOTELO_INFO } from "../src/providers/xotelo.js";
import { connect, testDeps } from "./helpers.js";

const T = "2026-10-05T10:00:00.000Z";
const q = (source: string, seller: string | null, per_night: number, currency = "INR"): PriceQuote => ({
  source,
  seller,
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
});
const cand = (source: string, id: string, name: string, prices: PriceQuote[]): HotelCandidate => ({
  source,
  source_id: id,
  name,
  lat: 28.6435,
  lng: 77.2175,
  stars: 3,
  rating_10: 8,
  review_count: 10,
  url: null,
  prices,
  fetched_at: T,
});
const provider = (id: string, hotels: HotelCandidate[] | Error): HotelSearchProvider => ({
  info: { id, name: id, kind: "hotel-prices", official: false, needsKey: false, limitations: [] },
  search: async () => {
    if (hotels instanceof Error) throw hotels;
    return hotels;
  },
});

function setup(
  providers: HotelSearchProvider[],
  xoteloRates = vi.fn(async () => [q("xotelo", "Trip.com", 2600)]),
) {
  const registry = new ProviderRegistry();
  [...providers.map((p) => p.info), FX_INFO, XOTELO_INFO].forEach((i) => registry.register(i));
  const deps = testDeps({
    registry,
    hotelProviders: providers,
    fx: { rates: async () => ({ toInr: { INR: 1, EUR: 100 }, date: "2026-10-02", source: "frankfurter" }) },
    xotelo: { info: XOTELO_INFO, rates: xoteloRates },
    memory: new HotelMemory(),
    now: () => new Date(T),
  });
  return { deps, xoteloRates };
}

const dates = { check_in: "2026-11-10", check_out: "2026-11-11" };
type Out = {
  prices: { seller: string; per_night_inr: number }[];
  cheapest_inr: number;
  hotel: { hotel_id: string };
  sources_failed: { source: string }[];
};

describe("get_hotel_rates", () => {
  it("lists every source's price for a hotel from a recent search, cheapest first, in INR", async () => {
    const { deps } = setup([
      provider("trivago", [cand("trivago", "t1", "Sunrise Residency", [q("trivago", "MakeMyTrip", 3100)])]),
      provider("hotelscasa", [
        cand("hotelscasa", "h1", "Hotel Sunrise Residency", [q("hotelscasa", null, 25, "EUR")]),
      ]),
    ]);
    const client = await connect(deps);
    await client.callTool({ name: "search_hotels", arguments: { lat: 28.643, lng: 77.2194, ...dates } });
    const r = await client.callTool({
      name: "get_hotel_rates",
      arguments: { hotel_id: "hotelscasa:h1", ...dates },
    });
    expect(r.isError).toBeFalsy();
    const out = r.structuredContent as Out;
    expect(out.hotel.hotel_id).toBe("trivago:t1");
    expect(out.prices.map((p) => [p.seller, p.per_night_inr])).toEqual([
      ["hotelscasa", 2500],
      ["MakeMyTrip", 3100],
    ]);
    expect(out.cheapest_inr).toBe(2500);
  });

  it("fetches Xotelo's per-site prices directly when the search did not price that hotel", async () => {
    const { deps, xoteloRates } = setup([
      provider("trivago", [cand("trivago", "t1", "Sunrise Residency", [q("trivago", "Agoda", 3000)])]),
      provider("xotelo", [cand("xotelo", "g304551-d123", "Sunrise Residency", [])]),
    ]);
    const client = await connect(deps);
    const r = await client.callTool({
      name: "get_hotel_rates",
      arguments: { name: "Sunrise Residency", lat: 28.6435, lng: 77.2175, ...dates },
    });
    expect(xoteloRates).toHaveBeenCalledWith("g304551-d123", "2026-11-10", "2026-11-11", 2, []);
    expect((r.structuredContent as Out).prices.map((p) => p.seller)).toEqual(["Trip.com", "Agoda"]);
  });

  it("keeps other sources' prices and reports a failing Xotelo lookup", async () => {
    const { deps } = setup(
      [
        provider("trivago", [cand("trivago", "t1", "Sunrise Residency", [q("trivago", "Agoda", 3000)])]),
        provider("xotelo", [cand("xotelo", "g1-d2", "Sunrise Residency", [])]),
      ],
      vi.fn(async () => {
        throw new AppError("RATE_LIMITED", "slow down");
      }),
    );
    const client = await connect(deps);
    const r = await client.callTool({
      name: "get_hotel_rates",
      arguments: { name: "Sunrise Residency", lat: 28.6435, lng: 77.2175, ...dates },
    });
    const out = r.structuredContent as Out;
    expect(out.prices).toHaveLength(1);
    expect(out.sources_failed).toEqual([expect.objectContaining({ source: "xotelo" })]);
  });

  it("says how to recover when the hotel id is unknown or no source lists the hotel", async () => {
    const { deps } = setup([provider("trivago", [])]);
    const client = await connect(deps);
    const unknown = await client.callTool({
      name: "get_hotel_rates",
      arguments: { hotel_id: "trivago:zzz", ...dates },
    });
    expect(unknown.isError).toBe(true);
    expect((unknown.content as { text: string }[])[0]!.text).toMatch(/search_hotels again/);
    const missing = await client.callTool({
      name: "get_hotel_rates",
      arguments: { name: "Ghost Inn", lat: 28.6, lng: 77.2, ...dates },
    });
    expect(missing.isError).toBe(true);
    expect((missing.content as { text: string }[])[0]!.text).toMatch(/No source lists/);
  });
});
