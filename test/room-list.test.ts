import { describe, expect, it, vi } from "vitest";
import { HotelMemory } from "../src/core/hotel-memory.js";
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
  per_night_inr: null,
  includes_taxes: null,
  available: null,
  refundable: null,
  url: null,
  room: null,
  fetched_at: T,
  ...extra,
});
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
  prices,
});
const provider = (id: string, search: HotelSearchProvider["search"]): HotelSearchProvider => ({
  info: { id, name: id, kind: "hotel-prices", official: true, needsKey: false, limitations: [] },
  search,
});
const offer = (
  seller: string,
  room: string,
  guests: number | null,
  per_night: number,
  currency = "INR",
): GoogleRoomOffer => ({ seller, room, guests, per_night, currency, url: `https://x/${room}` });

const stay = { check_in: "2026-11-10", check_out: "2026-11-11", adults: 4 };
const rateArgs = { name: "Sunrise Residency", lat: 28.6435, lng: 77.2194, ...stay };

type RoomEntry = {
  seller: string;
  room: string;
  guests: number | null;
  per_night_inr: number | null;
  url: string | null;
};
type Out = {
  prices: { seller: string; room: string | null }[];
  room_list: RoomEntry[] | null;
  notes: string[];
};

async function rates(rooms: (() => Promise<GoogleRoomOffer[]>) | null, args: Record<string, unknown>) {
  const tv = provider("trivago", async () => [
    listing("trivago", "tv1", [quote("trivago", 3000, { seller: "Booking.com" })]),
  ]);
  const google = provider("serpapi", async () => [
    listing("serpapi", "tok1", [quote("serpapi", 2900, { seller: "Google Hotels" })]),
  ]);
  google.info = SERPAPI_INFO;
  const registry = new ProviderRegistry();
  [tv.info, SERPAPI_INFO, FX_INFO, XOTELO_INFO].forEach((i) => registry.register(i));
  const c = await connect(
    testDeps({
      registry,
      hotelProviders: [tv, google],
      memory: new HotelMemory(),
      xotelo: { info: XOTELO_INFO, rates: vi.fn(async () => []) },
      serp: rooms ? { info: SERPAPI_INFO, rooms } : null,
      now: () => new Date(T),
    }),
  );
  const r = await c.callTool({ name: "get_hotel_rates", arguments: { ...rateArgs, ...args } });
  expect(r.isError).toBeFalsy();
  return r.structuredContent as Out;
}

describe("get_hotel_rates room_list", () => {
  it("lists every room offer, including ones the fit rules drop from prices, sorted by seller then price", async () => {
    const rooms = vi.fn(async () => [
      offer("Expedia", "Family Room for 4", null, 2500), // kept in prices
      offer("Expedia", "Premium Room with Extra Bed", null, 2400), // dropped from prices
      offer("Booking.com", "Suite", null, 5000), // dropped
      offer("Booking.com", "Triple Room", 3, 2700), // rate for fewer guests: dropped
      offer("Agoda", "Deluxe Room", 2, 80, "USD"), // not INR
    ]);
    const out = await rates(rooms, { verify_room: true });
    expect(rooms).toHaveBeenCalledTimes(1);
    expect(out.prices.filter((p) => p.room !== null).map((p) => p.room)).toEqual(["Family Room for 4"]);
    expect(out.room_list).toEqual([
      { seller: "Agoda", room: "Deluxe Room", guests: 2, per_night_inr: null, url: "https://x/Deluxe Room" },
      {
        seller: "Booking.com",
        room: "Triple Room",
        guests: 3,
        per_night_inr: 2700,
        url: "https://x/Triple Room",
      },
      { seller: "Booking.com", room: "Suite", guests: null, per_night_inr: 5000, url: "https://x/Suite" },
      {
        seller: "Expedia",
        room: "Premium Room with Extra Bed",
        guests: null,
        per_night_inr: 2400,
        url: "https://x/Premium Room with Extra Bed",
      },
      {
        seller: "Expedia",
        room: "Family Room for 4",
        guests: null,
        per_night_inr: 2500,
        url: "https://x/Family Room for 4",
      },
    ]);
    expect(out.notes.some((n) => /room_list shows the first/.test(n))).toBe(false);
  });

  it("is null when verify_room is false", async () => {
    const rooms = vi.fn(async () => [offer("Expedia", "Suite", null, 5000)]);
    const out = await rates(rooms, { verify_room: false });
    expect(rooms).not.toHaveBeenCalled();
    expect(out.room_list).toBeNull();
  });

  it("is null when SerpApi is not configured", async () => {
    const out = await rates(null, { verify_room: true });
    expect(out.room_list).toBeNull();
  });

  it("caps at 60 entries and notes the truncation", async () => {
    const many = Array.from({ length: 75 }, (_, i) => offer("Expedia", `Room ${i}`, null, 1000 + i));
    const out = await rates(async () => many, { verify_room: true });
    expect(out.room_list).toHaveLength(60);
    expect(out.room_list![0]!.per_night_inr).toBe(1000);
    expect(out.room_list![59]!.per_night_inr).toBe(1059);
    expect(out.notes).toContain(
      "verify_room: room_list shows the first 60 of Google's 75 room offers (by seller, then price).",
    );
  });
});
