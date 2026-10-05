import { describe, expect, it, vi } from "vitest";
import { HotelMemory } from "../src/core/hotel-memory.js";
import type { HotelCandidate, PriceQuote } from "../src/core/types.js";
import { FX_INFO } from "../src/providers/fx.js";
import { HOTELSCASA_INFO } from "../src/providers/hotelscasa.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { SERPAPI_INFO } from "../src/providers/serpapi.js";
import type { HotelSearchProvider } from "../src/providers/types.js";
import { XOTELO_INFO } from "../src/providers/xotelo.js";
import { connect, testDeps } from "./helpers.js";

const T = "2026-10-06T10:00:00.000Z";
const stay = { check_in: "2026-11-10", check_out: "2026-11-11", adults: 4 };
const quote = (source: string, seller: string | null, inr: number): PriceQuote => ({
  source,
  seller,
  per_night: inr,
  total: null,
  currency: "INR",
  per_night_inr: inr,
  includes_taxes: null,
  available: null,
  refundable: null,
  url: null,
  room: null,
  fetched_at: T,
});
const listing = (source: string, id: string, prices: PriceQuote[], extra: Partial<HotelCandidate> = {}) => ({
  source,
  source_id: id,
  name: "South Gate Residency",
  lat: 9.9675,
  lng: 76.2905,
  stars: 3,
  rating_10: 8,
  review_count: 100,
  url: `https://example.invalid/${source}`,
  prices,
  fetched_at: T,
  ...extra,
});
const provider = (id: string, hotels: HotelCandidate[]): HotelSearchProvider => ({
  info: { ...SERPAPI_INFO, id, name: id, official: true },
  search: async () => hotels,
});
type Section = {
  source: string;
  details?: Record<string, unknown>;
  offers: { seller: string | null; per_night_inr: number }[];
};

async function setup(opts: { serp?: boolean } = {}) {
  const tv = provider("trivago", [listing("trivago", "t1", [quote("trivago", "Agoda", 2189)])]);
  const hc = provider("hotelscasa", [listing("hotelscasa", "sgr", [quote("hotelscasa", null, 3511)])]);
  const g = provider("serpapi", [
    listing("serpapi", "tok", [quote("serpapi", "Google Hotels (lowest listed)", 2834)]),
  ]);
  const registry = new ProviderRegistry();
  [tv.info, hc.info, g.info, FX_INFO, XOTELO_INFO].forEach((i) => registry.register(i));
  const hcDetails = vi.fn(async () => ({
    details: {
      address: "Ernakulam South, Kochi",
      pros: ["Next to the station"],
      important_info: ["ID required"],
    },
  }));
  const serpDetails = vi.fn(async () => ({
    details: { phone: "+91 484 000 0000", website: "https://example.invalid/sgr" },
    prices: [quote("serpapi", "Booking.com", 4200), quote("serpapi", "Agoda", 2080)],
  }));
  const c = await connect(
    testDeps({
      registry,
      hotelProviders: [tv, hc, g],
      memory: new HotelMemory(),
      xotelo: { info: XOTELO_INFO, rates: vi.fn(async () => []) },
      hotelscasa: { info: HOTELSCASA_INFO, details: hcDetails },
      serp: opts.serp ? { info: SERPAPI_INFO, details: serpDetails } : null,
      now: () => new Date(T),
    }),
  );
  const s = await c.callTool({ name: "search_hotels", arguments: { lat: 9.969, lng: 76.29095, ...stay } });
  const hotel = (s.structuredContent as { hotels: { hotel_id: string; sources: Section[] }[] }).hotels[0]!;
  return { c, hotel, hcDetails, serpDetails };
}

describe("get_hotel_details", () => {
  it("adds HotelsCasa's hotel page to its section; search results carry no details", async () => {
    const { c, hotel, hcDetails } = await setup();
    expect(hotel.sources.every((x) => x.details === undefined)).toBe(true);
    const r = await c.callTool({
      name: "get_hotel_details",
      arguments: { hotel_id: hotel.hotel_id, ...stay },
    });
    expect(hcDetails).toHaveBeenCalledWith("sgr", expect.objectContaining({ adults: 4 }));
    const hcSection = (r.structuredContent as { sources: Section[] }).sources.find(
      (x) => x.source === "hotelscasa",
    );
    expect(hcSection!.details).toEqual({
      address: "Ernakulam South, Kochi",
      pros: ["Next to the station"],
      important_info: ["ID required"],
    });
  });

  it("with google_prices, replaces Google's lowest price with a price per booking site and adds its details", async () => {
    const { c, hotel, serpDetails } = await setup({ serp: true });
    const r = await c.callTool({
      name: "get_hotel_details",
      arguments: { hotel_id: hotel.hotel_id, ...stay, google_prices: true },
    });
    expect(serpDetails).toHaveBeenCalledWith("tok", expect.objectContaining({ adults: 4 }));
    const g = (r.structuredContent as { sources: Section[] }).sources.find((x) => x.source === "serpapi")!;
    expect(g.offers.map((o) => [o.seller, o.per_night_inr])).toEqual([
      ["Agoda", 2080],
      ["Booking.com", 4200],
    ]);
    expect(g.details).toMatchObject({ phone: "+91 484 000 0000", website: "https://example.invalid/sgr" });
  });

  it("does not fetch Google's page unless asked, and says when it can't", async () => {
    const asked = await setup();
    const r = await asked.c.callTool({
      name: "get_hotel_details",
      arguments: { hotel_id: asked.hotel.hotel_id, ...stay, google_prices: true },
    });
    expect((r.structuredContent as { notes: string[] }).notes.join(" ")).toMatch(
      /google_prices needs SerpApi/,
    );

    const quiet = await setup({ serp: true });
    await quiet.c.callTool({
      name: "get_hotel_details",
      arguments: { hotel_id: quiet.hotel.hotel_id, ...stay },
    });
    expect(quiet.serpDetails).not.toHaveBeenCalled();
  });
});
