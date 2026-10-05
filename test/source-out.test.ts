import { describe, expect, it } from "vitest";
import { mergeCandidates } from "../src/core/merge.js";
import type { HotelCandidate, PriceQuote } from "../src/core/types.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { HotelSearchProvider } from "../src/providers/types.js";
import { sourcesOut } from "../src/tools/source-out.js";
import { connect, testDeps } from "./helpers.js";

const T = "2026-10-06T10:00:00.000Z";
const quote = (
  source: string,
  seller: string | null,
  inr: number,
  extra: Partial<PriceQuote> = {},
): PriceQuote => ({
  source,
  seller,
  per_night: inr,
  total: null,
  currency: "INR",
  per_night_inr: inr,
  includes_taxes: null,
  available: null,
  refundable: null,
  url: `https://example.invalid/${source}/${seller ?? "direct"}`,
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
  name: "South Gate Residency",
  lat: 9.9675,
  lng: 76.2905,
  stars: 3,
  rating_10: 8,
  review_count: 100,
  url: `https://example.invalid/${source}/hotel`,
  prices,
  fetched_at: T,
  ...extra,
});

describe("each source's listing survives the merge", () => {
  it("keeps every source's own name, rating, link and details", () => {
    const [h] = mergeCandidates([
      listing("trivago", "t1", [quote("trivago", "Agoda", 2189)], {
        rating_10: 7.6,
        review_count: 1522,
        amenities: ["Free WiFi", "Parking"],
        area: "Kochi",
      }),
      listing("serpapi", "g1", [quote("serpapi", "Google Hotels (lowest listed)", 2833)], {
        name: "Hotel South Gate Residency",
        rating_10: 7.8,
        review_count: 2100,
        property_type: "hotel",
        check_in_time: "12:00 PM",
      }),
    ]);
    expect(h!.listings.map((l) => [l.source, l.name, l.rating_10, l.url])).toEqual([
      ["trivago", "South Gate Residency", 7.6, "https://example.invalid/trivago/hotel"],
      ["serpapi", "Hotel South Gate Residency", 7.8, "https://example.invalid/serpapi/hotel"],
    ]);
    // The hotel-level rating is still the best-supported one.
    expect(h).toMatchObject({ rating_10: 7.8, review_count: 2100 });
  });
});

describe("sourcesOut", () => {
  const hotel = {
    name: "South Gate Residency",
    hotel_id: "trivago:t1",
    also_ids: ["xotelo:x1", "osm_lodging:n1", "hotelscasa:h9"],
    listings: [
      listing("trivago", "t1", [], { amenities: ["a", "b", "c", "d", "e", "f", "g", "h"] }),
      listing("xotelo", "x1", [], {
        property_type: "Hotel",
        typical_price: { min: 1500, max: 4000, currency: "INR" },
      }),
      listing("osm_lodging", "n1", [], { name: "South Gate" }),
    ],
  };
  const prices = [
    quote("trivago", "Agoda", 2189),
    quote("xotelo", "Booking.com", 4000, { includes_taxes: true }),
    quote("xotelo", "Agoda.com", 2070),
    quote("xotelo", "Trip.com", 3635),
    quote("xotelo", "Expedia", 3900),
    // A source with prices but no listing (e.g. a direct re-check) still gets a section.
    quote("hotelscasa", null, 3510, { room: "Family 4 People", meal_plan: "Room Only", refundable: true }),
  ];

  it("groups offers by source, cheapest source first, with each source's details", () => {
    const out = sourcesOut(hotel, prices, { maxOffers: 3, maxAmenities: 6 });
    expect(out.map((s) => [s.source, s.cheapest_inr, s.offers_total])).toEqual([
      ["xotelo", 2070, 4],
      ["trivago", 2189, 1],
      ["hotelscasa", 3510, 1],
      ["osm_lodging", null, 0],
    ]);
    const xo = out[0]!;
    expect(xo.offers.map((o) => o.seller)).toEqual(["Agoda.com", "Trip.com", "Expedia"]);
    expect(xo).toMatchObject({
      property_type: "Hotel",
      typical_price: { min: 1500, max: 4000, currency: "INR" },
    });
    expect(out[1]!.amenities).toHaveLength(6);
    // No listing: the hotel's name, and its id at that source from also_ids.
    expect(out[2]).toMatchObject({ name: "South Gate Residency", source_id: "h9", url: null });
    expect(out[2]!.offers[0]).toMatchObject({
      room: "Family 4 People",
      meal_plan: "Room Only",
      refundable: true,
    });
    // Fields a source doesn't have are left out, not null.
    expect(out[3]).not.toHaveProperty("amenities");
    expect(out[3]).toMatchObject({ name: "South Gate", offers: [] });
  });

  it("lists every offer when uncapped", () => {
    expect(sourcesOut(hotel, prices).find((s) => s.source === "xotelo")!.offers).toHaveLength(4);
  });
});

describe("search_hotels output", () => {
  it("gives each hotel a section per source with that source's own data", async () => {
    const provider = (id: string, hotels: HotelCandidate[]): HotelSearchProvider => ({
      info: { id, name: id, kind: "hotel-prices", official: true, needsKey: false, limitations: [] },
      search: async () => hotels,
    });
    const tv = provider("trivago", [
      listing("trivago", "t1", [quote("trivago", "Agoda", 2189)], {
        rating_10: 7.6,
        amenities: ["Free WiFi"],
      }),
    ]);
    const hc = provider("hotelscasa", [
      listing("hotelscasa", "h1", [quote("hotelscasa", null, 3510, { room: "Family 4 People" })], {
        rating_10: 8.4,
        review_count: 300,
      }),
    ]);
    const registry = new ProviderRegistry();
    registry.register(tv.info);
    registry.register(hc.info);
    const c = await connect(testDeps({ registry, hotelProviders: [tv, hc], now: () => new Date(T) }));
    const r = await c.callTool({
      name: "search_hotels",
      arguments: { lat: 9.969, lng: 76.29095, check_in: "2026-11-10", check_out: "2026-11-11", adults: 4 },
    });
    const h = (r.structuredContent as { hotels: Record<string, any>[] }).hotels[0]!;
    expect(h.cheapest).toEqual({
      per_night_inr: 2189,
      source: "trivago",
      seller: "Agoda",
      url: "https://example.invalid/trivago/Agoda",
    });
    expect(h.sources.map((s: Record<string, unknown>) => [s.source, s.rating_10, s.url])).toEqual([
      ["trivago", 7.6, "https://example.invalid/trivago/hotel"],
      ["hotelscasa", 8.4, "https://example.invalid/hotelscasa/hotel"],
    ]);
    expect(h.sources[0].amenities).toEqual(["Free WiFi"]);
    expect(h.sources[1].offers[0]).toMatchObject({ room: "Family 4 People", per_night_inr: 3510 });
  });
});
