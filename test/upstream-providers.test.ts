import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { HotelSearchQuery } from "../src/core/types.js";
import { createHotelsCasaProvider, propertyType } from "../src/providers/hotelscasa.js";
import { parseAmount } from "../src/providers/shared.js";
import { createTrivagoProvider, nightsBetween } from "../src/providers/trivago.js";
import type { UpstreamResult } from "../src/providers/upstream-mcp.js";

const fixture = (name: string): UpstreamResult =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const NOW = () => new Date("2026-10-05T10:00:00Z");
const query: HotelSearchQuery = {
  lat: 28.643,
  lng: 77.2194,
  radius_km: 5,
  check_in: "2026-11-10",
  check_out: "2026-11-11",
  adults: 2,
};

describe("parseAmount", () => {
  it.each([
    ["₹21,689", 21689],
    ["US$ 1,234.50", 1234.5],
    ["8.1", 8.1],
    ["", null],
    [null, null],
    ["n/a", null],
  ])("%s → %s", (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it("counts nights between ISO dates", () => {
    expect(nightsBetween("2026-11-10", "2026-11-13")).toBe(3);
  });
});

describe("trivago provider", () => {
  it("sends an India/INR search and keeps only the data fields", async () => {
    const call = vi.fn().mockResolvedValue(fixture("trivago-radius-search.json"));
    const hotels = await createTrivagoProvider(call, NOW).search(query);

    expect(call).toHaveBeenCalledWith(
      "trivago-accommodation-radius-search",
      expect.objectContaining({ latitude: 28.643, country: "IN", currency: "INR", language: "EN_IN" }),
    );
    expect(hotels.length).toBeGreaterThan(0);
    const first = hotels.find((h) => h.source_id === "a1b2c3d4e5f6");
    expect(first).toMatchObject({
      source: "trivago",
      name: "Fixture Grand Paharganj",
      lat: 28.6445,
      lng: 77.215,
      stars: 3,
      rating_10: 8.1,
      review_count: 1204,
      fetched_at: "2026-10-05T10:00:00.000Z",
    });
    expect(first?.prices[0]).toMatchObject({ seller: "Booking.com", per_night: 3250, currency: "INR" });
    // Upstream formatting instructions and images never leave the provider.
    expect(JSON.stringify(hotels)).not.toMatch(/system_message|IMPORTANT|main_image|base64/);
  });

  it("maps top_amenities to a list and the distance's place to area, only when stated", async () => {
    const base = fixture("trivago-radius-search.json") as {
      structuredContent: { accommodations: Record<string, unknown>[] };
    };
    const [a, b, c] = base.structuredContent.accommodations;
    const accommodations = [
      a,
      { ...b, top_amenities: null, distance: "3.0 km to City centre" },
      { ...c, top_amenities: " , ", distance: undefined },
    ];
    const call = vi.fn().mockResolvedValue({ structuredContent: { accommodations } });
    const hotels = await createTrivagoProvider(call, NOW).search({ ...query, radius_km: 50 });
    const byId = new Map(hotels.map((h) => [h.source_id, h]));

    expect(byId.get("a1b2c3d4e5f6")).toMatchObject({
      amenities: ["WiFi in lobby", "WiFi in rooms", "A/C", "Restaurant"],
      area: "Delhi",
    });
    for (const id of ["0f9e8d7c6b5a", "123abc456def"]) {
      expect(byId.get(id)).not.toHaveProperty("amenities");
      expect(byId.get(id)).not.toHaveProperty("area");
    }
  });

  it("drops hotels outside the requested radius (trivago has no radius parameter)", async () => {
    const call = vi.fn().mockResolvedValue(fixture("trivago-radius-search.json"));
    const all = await createTrivagoProvider(call, NOW).search({ ...query, radius_km: 50 });
    const near = await createTrivagoProvider(call, NOW).search({ ...query, radius_km: 0.05 });
    expect(near.length).toBeLessThan(all.length);
  });

  it("turns trivago validation errors (sent without isError) into INVALID_INPUT", async () => {
    const call = vi.fn().mockResolvedValue(fixture("trivago-validation-error.json"));
    await expect(createTrivagoProvider(call, NOW).search(query)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("arrival must be today or in the future"),
    });
  });

  it("reports a changed payload shape as SCHEMA_CHANGED, not as zero hotels", async () => {
    const call = vi.fn().mockResolvedValue({ structuredContent: { hotels: [] } });
    await expect(createTrivagoProvider(call, NOW).search(query)).rejects.toMatchObject({
      code: "SCHEMA_CHANGED",
    });
  });
});

describe("HotelsCasa provider", () => {
  it("searches by radius in English and keeps EUR prices with availability", async () => {
    const call = vi.fn().mockResolvedValue(fixture("hotelscasa-search.json"));
    const hotels = await createHotelsCasaProvider(call, { now: NOW }).search(query);

    expect(call).toHaveBeenCalledWith(
      "search_hotels",
      expect.objectContaining({ lat: 28.643, lng: 77.2194, radius_km: 5, lang: "en", page: 1 }),
    );
    const first = hotels[0];
    expect(first).toMatchObject({
      source: "hotelscasa",
      source_id: "fixture-inn-paharganj-new-delhi",
      lat: 28.6435,
      stars: 3,
      rating_10: 7.8,
    });
    expect(first?.prices[0]).toMatchObject({
      per_night: 18.5,
      currency: "EUR",
      includes_taxes: true,
      available: true,
      refundable: true,
    });
  });

  it("maps type to property_type and keeps the room name and board apart", async () => {
    const base = fixture("hotelscasa-search.json") as {
      structuredContent: { items: Record<string, unknown>[] } & Record<string, unknown>;
    };
    const [a, b] = base.structuredContent.items;
    const items = [a, { ...b, type: null, board: null }];
    const call = vi.fn().mockResolvedValue({ structuredContent: { ...base.structuredContent, items } });
    const [first, second] = await createHotelsCasaProvider(call, { now: NOW }).search(query);

    expect(first?.property_type).toBe("Hotel");
    expect(first?.prices[0]).toMatchObject({ room: "Deluxe Double Room", meal_plan: "Room Only" });
    expect(second).not.toHaveProperty("property_type");
    expect(second?.prices[0]?.room).toBe("Standard Twin");
    expect(second?.prices[0]).not.toHaveProperty("meal_plan");
  });

  it("caps the radius at 50 km and stops paging on a short page", async () => {
    const call = vi.fn().mockResolvedValue(fixture("hotelscasa-search.json"));
    await createHotelsCasaProvider(call, { maxPages: 3, now: NOW }).search({ ...query, radius_km: 80 });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[1]).toMatchObject({ radius_km: 50 });
  });

  it("surfaces isError results as an upstream error", async () => {
    const call = vi.fn().mockResolvedValue(fixture("hotelscasa-get-hotel-not-found.json"));
    await expect(createHotelsCasaProvider(call, { now: NOW }).search(query)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
  });
});

describe("HotelsCasa property types", () => {
  it("translates the Spanish category names that leak through and keeps English ones", () => {
    expect(propertyType("Posadas")).toBe("Inn");
    expect(propertyType("Casas de huéspedes")).toBe("Guest house");
    expect(propertyType("Hotel")).toBe("Hotel");
    expect(propertyType("Bed and breakfast")).toBe("Bed and breakfast");
  });
});

describe("HotelsCasa indicative prices", () => {
  it("does not present 'from' prices as live when availability was not checked", async () => {
    const live = fixture("hotelscasa-search.json") as { structuredContent: Record<string, unknown> };
    const unchecked = { structuredContent: { ...live.structuredContent, availability_checked: false } };
    const call = vi.fn().mockResolvedValue(unchecked);
    const hotels = await createHotelsCasaProvider(call, { now: NOW }).search(query);
    expect(hotels.length).toBeGreaterThan(0);
    expect(hotels.every((h) => h.prices.length === 0)).toBe(true);
  });
});

describe("occupancy and preferences sent upstream", () => {
  it("trivago gets children with dash-separated ages and a star filter", async () => {
    const call = vi.fn().mockResolvedValue(fixture("trivago-radius-search.json"));
    await createTrivagoProvider(call, NOW).search({
      ...query,
      children_ages: [4, 9],
      prefer: { min_stars: 4 },
    });
    expect(call.mock.calls[0]?.[1]).toMatchObject({
      adults: 2,
      rooms: 1,
      children: 2,
      children_ages: "4-9",
      hotel_rating: { "4star": true, "5star": true },
    });
  });

  it("HotelsCasa gets the occupancy, sort by price and minimum stars", async () => {
    const call = vi.fn().mockResolvedValue(fixture("hotelscasa-search.json"));
    await createHotelsCasaProvider(call, { now: NOW }).search({
      ...query,
      adults: 4,
      children_ages: [],
      prefer: { sort: "price", min_stars: 3 },
    });
    const args = call.mock.calls[0]?.[1];
    expect(args).toMatchObject({ adults: 4, sort: "price", stars_min: 3 });
    expect(args).not.toHaveProperty("children");
  });
});

describe("trivago guest-rating filter", () => {
  it("is not sent to trivago (the floor applies to merged ratings, after merging)", async () => {
    const call = vi.fn().mockResolvedValue(fixture("trivago-radius-search.json"));
    await createTrivagoProvider(call, NOW).search({ ...query, prefer: { min_rating_10: 8 } });
    expect(call.mock.calls[0]?.[1]).not.toHaveProperty("review_rating");
  });
});

describe("HotelsCasa room names", () => {
  it("passes the room name and board through with the price", async () => {
    const call = vi.fn().mockResolvedValue(fixture("hotelscasa-search.json"));
    const [first] = await createHotelsCasaProvider(call, { now: NOW }).search(query);
    expect(first?.prices[0]).toMatchObject({ room: "Deluxe Double Room", meal_plan: "Room Only" });
  });
});

describe("trivago name lookup", () => {
  const acc = (id: string, name: string, price: string) => ({
    structuredContent: {
      accommodations: [
        {
          accommodation_id: id,
          accommodation_name: name,
          latitude: 9.969,
          longitude: 76.289,
          currency: "INR",
          price_per_night: price,
          price_per_stay: price,
          advertisers: "Agoda",
        },
      ],
    },
  });

  it("asks trivago's text search by name for the party, and accepts only the same accommodation id", async () => {
    const call = vi.fn().mockResolvedValue(acc("abc123", "Paulson Park Kochi", "₹2,669"));
    const p = createTrivagoProvider(call, NOW);
    const hit = await p.lookup("abc123", "Paulson Park Kochi", undefined, {
      check_in: "2026-11-12",
      check_out: "2026-11-13",
      adults: 4,
    });
    expect(call).toHaveBeenCalledWith(
      "trivago-accommodation-search",
      expect.objectContaining({ query: "Paulson Park Kochi", adults: 4, rooms: 1 }),
    );
    expect(hit?.prices[0]).toMatchObject({ per_night: 2669, seller: "Agoda" });
  });

  it("rejects trivago's best match when it is a different hotel", async () => {
    const call = vi.fn().mockResolvedValue(acc("zzz999", "Evershine Residency", "₹1,500"));
    const p = createTrivagoProvider(call, NOW);
    expect(
      await p.lookup("abc123", "Anupam Residency", undefined, {
        check_in: "2026-11-12",
        check_out: "2026-11-13",
        adults: 2,
      }),
    ).toBeNull();
  });
});
