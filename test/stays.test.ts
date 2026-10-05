import { describe, expect, it, vi } from "vitest";
import type { Anchor } from "../src/core/anchors.js";
import { HotelMemory } from "../src/core/hotel-memory.js";
import { searchHotels } from "../src/core/hotel-search.js";
import { planStay, type PlanOptions } from "../src/core/itinerary.js";
import { RetiringRooms } from "../src/core/retiring.js";
import { addDays, istClock, istDate, istIso, parseIstDateTime } from "../src/core/time.js";
import type { HotelCandidate, PriceQuote } from "../src/core/types.js";
import { FX_INFO } from "../src/providers/fx.js";
import { createOsmLodging } from "../src/providers/osm-lodging.js";
import { createOsrm } from "../src/providers/osrm.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { HotelSearchProvider } from "../src/providers/types.js";

describe("IST time helpers", () => {
  it("treats datetimes without an offset as IST and formats back in IST", () => {
    const d = parseIstDateTime("2026-11-10T23:30");
    expect(d.toISOString()).toBe("2026-11-10T18:00:00.000Z");
    expect(istDate(parseIstDateTime("2026-11-10T20:00:00Z"))).toBe("2026-11-11");
    expect(istClock(d)).toMatchObject({ hour: 23, minute: 30, text: "23:30" });
    expect(istIso(d)).toBe("2026-11-10T23:30+05:30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("rejects non-ISO input", () => {
    expect(() => parseIstDateTime("10 Nov 8pm")).toThrow(/ISO-8601/);
  });
});

describe("RetiringRooms", () => {
  const rr = new RetiringRooms([
    { station_code: "NDLS", station_name: "NEW DELHI", managed_by: "Railway", lat: 28.6419, lng: 77.2218 },
    { station_code: "BNRS", station_name: "BANARAS", managed_by: "IRCTC", lat: 25.2992, lng: 82.971 },
    { station_code: "KPD", station_name: "KATPADI", managed_by: "Railway", lat: null, lng: null },
  ]);

  it("finds stations by code, including the OSM-era code of a renamed station", () => {
    expect(rr.atStation("ndls")).toMatchObject({ station_code: "NDLS", distance_km: 0 });
    expect(rr.atStation("BSBS")).toMatchObject({ station_code: "BNRS" });
    expect(rr.atStation("KPD")).toMatchObject({ lat: null });
  });

  it("finds stations near a point, skipping ones without coordinates", () => {
    expect(rr.near({ lat: 28.643, lng: 77.2194 }, 10).map((s) => s.station_code)).toEqual(["NDLS"]);
  });
});

describe("OSM lodging provider and unpriced hotels", () => {
  const rows = [
    {
      osm_id: "n1",
      name: "Map Only Lodge",
      type: "guest_house" as const,
      stars: null,
      brand: null,
      has_phone: false,
      has_website: false,
      lat: 28.644,
      lng: 77.22,
    },
    {
      osm_id: "w2",
      name: "Far Lodge",
      type: "hotel" as const,
      stars: 3,
      brand: null,
      has_phone: true,
      has_website: false,
      lat: 28.8,
      lng: 77.22,
    },
  ];

  it("returns nearby listings with an OSM link and no prices", async () => {
    const p = createOsmLodging(rows, "2026-10-04T00:00:00Z");
    const hits = await p.search({
      lat: 28.643,
      lng: 77.2194,
      radius_km: 2,
      check_in: "x",
      check_out: "y",
      adults: 2,
    });
    expect(hits).toEqual([
      expect.objectContaining({
        source: "osm_lodging",
        name: "Map Only Lodge",
        prices: [],
        url: "https://www.openstreetmap.org/node/1",
      }),
    ]);
  });

  it("hides unpriced hotels by default and counts them", async () => {
    const registry = new ProviderRegistry();
    const osm = createOsmLodging(rows, null);
    registry.register(osm.info);
    registry.register(FX_INFO);
    const deps = {
      registry,
      providers: [osm],
      fx: { rates: async () => ({ toInr: { INR: 1 }, date: "d", source: "s" }) },
    };
    const q = { lat: 28.643, lng: 77.2194, radius_km: 2, check_in: "x", check_out: "y", adults: 2 };
    const hidden = await searchHotels(deps, q, { sort: "distance" });
    expect(hidden.hotels).toEqual([]);
    expect(hidden.unpriced_hidden).toBe(1);
    const shown = await searchHotels(deps, q, { sort: "distance", include_unpriced: true });
    expect(shown.hotels.map((h) => h.name)).toEqual(["Map Only Lodge"]);
  });
});

describe("planStay", () => {
  const T = "2026-10-05T10:00:00.000Z";
  const quote = (per_night: number): PriceQuote => ({
    source: "p",
    seller: "Agoda",
    per_night,
    total: per_night,
    currency: "INR",
    per_night_inr: null,
    includes_taxes: null,
    available: null,
    refundable: null,
    url: null,
    fetched_at: T,
  });
  const hotel = (id: string, name: string, lat: number, lng: number, price: number): HotelCandidate => ({
    source: "p",
    source_id: id,
    name,
    lat,
    lng,
    stars: 3,
    rating_10: 8,
    review_count: 5,
    url: null,
    prices: [quote(price)],
    fetched_at: T,
  });

  const NDLS: Anchor & { label: string } = {
    kind: "station",
    name: "New Delhi",
    code: "NDLS",
    context: null,
    lat: 28.6419,
    lng: 77.2218,
    source: "t",
    label: "arrive NDLS",
  };
  const DEL: Anchor & { label: string } = {
    kind: "airport",
    name: "IGI",
    code: "DEL",
    context: null,
    lat: 28.5556,
    lng: 77.0952,
    source: "t",
    label: "fly DEL",
  };

  // Fake OSRM: minutes = 3 × straight-line km, so nearer hotels are faster.
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const coords = url.pathname
      .split("/")
      .pop()!
      .split(";")
      .map((c) => c.split(",").map(Number) as [number, number]);
    const src = url.searchParams.get("sources")!.split(";").map(Number);
    const dst = url.searchParams.get("destinations")!.split(";").map(Number);
    const km = (i: number, j: number) => {
      const [lng1, lat1] = coords[i]!;
      const [lng2, lat2] = coords[j]!;
      return Math.hypot((lat1 - lat2) * 111, (lng1 - lng2) * 98);
    };
    return new Response(
      JSON.stringify({
        code: "Ok",
        durations: src.map((i) => dst.map((j) => km(i, j) * 180)),
        distances: src.map((i) => dst.map((j) => km(i, j) * 1000)),
      }),
    );
  }) as unknown as typeof fetch;

  function deps(hotels: HotelCandidate[]) {
    const registry = new ProviderRegistry();
    const provider: HotelSearchProvider = {
      info: { id: "p", name: "p", kind: "hotel-prices", official: false, needsKey: false, limitations: [] },
      search: vi.fn(async (q) =>
        hotels.filter((h) => Math.hypot((h.lat - q.lat) * 111, (h.lng - q.lng) * 98) <= q.radius_km),
      ),
    };
    const osrm = createOsrm({
      carUrl: "https://osrm.local/car",
      footUrl: "https://osrm.local/foot",
      http: { userAgent: "t", fetchImpl },
    });
    [provider.info, osrm.info, FX_INFO].forEach((i) => registry.register(i));
    return {
      provider,
      plan: {
        hotels: {
          registry,
          providers: [provider],
          fx: { rates: async () => ({ toInr: { INR: 1 }, date: "d", source: "s" }) },
        },
        travel: { osrm, registry, metroMultiplier: 1, otherMultiplier: 1 },
        retiring: new RetiringRooms([
          {
            station_code: "NDLS",
            station_name: "NEW DELHI",
            managed_by: "Railway",
            lat: 28.6419,
            lng: 77.2218,
          },
        ]),
        memory: new HotelMemory(),
      },
    };
  }
  const opts: PlanOptions = {
    adults: 2,
    children_ages: [],
    radius_km: 3,
    candidates: 3,
    value_of_time_inr_per_hour: 300,
    train_buffer_min: 30,
    flight_buffer_min: 120,
  };

  const nearStation = hotel("a", "Station Inn", 28.6425, 77.2205, 3000);
  const nearAirport = hotel("b", "Airport Inn", 28.556, 77.1, 3500);
  const cheapFar = hotel("c", "Budget Midway", 28.6, 77.16, 1000);

  it("searches near both ends, trades price against transfer time and computes leave-by with the flight buffer", async () => {
    const { plan, provider } = deps([nearStation, nearAirport]);
    const s = await planStay(
      plan,
      {
        arrive: NDLS,
        arrive_at: parseIstDateTime("2026-11-10T20:10"),
        depart: DEL,
        depart_at: parseIstDateTime("2026-11-11T09:00"),
      },
      opts,
      1,
    );
    expect(provider.search).toHaveBeenCalledTimes(2);
    expect(s).toMatchObject({
      check_in: "2026-11-10",
      check_out: "2026-11-11",
      nights: 1,
      searched_around: ["arrive NDLS", "fly DEL"],
    });
    expect(s.candidates.map((c) => c.name).sort()).toEqual(["Airport Inn", "Station Inn"]);
    const top = s.candidates[0]!;
    expect(top.score_inr).toBe(
      Math.round(top.per_night_inr! + ((top.minutes_from_arrival! + top.minutes_to_departure!) / 60) * 300),
    );
    // leave_by = departure − (drive minutes + 120-minute flight buffer)
    const expected = new Date(
      parseIstDateTime("2026-11-11T09:00").getTime() - (top.minutes_to_departure! + 120) * 60_000,
    );
    expect(top.leave_by).toBe(istIso(expected));
    // Overnight stay ≥3 h at a station with retiring rooms lists them.
    expect(s.retiring_rooms.map((r) => r.station_code)).toEqual(["NDLS"]);
  });

  it("with value_of_time 0 ranks purely by price", async () => {
    const { plan } = deps([nearStation, cheapFar]);
    const s = await planStay(
      plan,
      {
        arrive: NDLS,
        arrive_at: parseIstDateTime("2026-11-10T20:10"),
        depart: NDLS,
        depart_at: parseIstDateTime("2026-11-11T09:00"),
      },
      { ...opts, radius_km: 10, value_of_time_inr_per_hour: 0 },
      1,
    );
    expect(s.candidates[0]!.name).toBe("Budget Midway");
    expect(s.searched_around).toEqual(["arrive NDLS"]);
  });

  it("books the previous night for an early-morning arrival and warns", async () => {
    const { plan } = deps([nearStation]);
    const s = await planStay(
      plan,
      {
        arrive: NDLS,
        arrive_at: parseIstDateTime("2026-11-10T04:30"),
        depart: NDLS,
        depart_at: parseIstDateTime("2026-11-10T22:00"),
      },
      opts,
      1,
    );
    expect(s).toMatchObject({ check_in: "2026-11-09", check_out: "2026-11-10", nights: 1 });
    expect(s.warnings.join(" ")).toMatch(/before normal check-in/);
    expect(s.warnings.join(" ")).toMatch(/Late arrival \(04:30\)/);
  });

  it("flags a short same-day stay and suggests the station's retiring room", async () => {
    const { plan } = deps([nearStation]);
    const s = await planStay(
      plan,
      {
        arrive: NDLS,
        arrive_at: parseIstDateTime("2026-11-10T09:00"),
        depart: NDLS,
        depart_at: parseIstDateTime("2026-11-10T15:00"),
      },
      opts,
      1,
    );
    expect(s).toMatchObject({ check_in: "2026-11-10", check_out: "2026-11-11", stay_hours: 6 });
    expect(s.warnings.join(" ")).toMatch(/Same-day stay/);
    expect(s.warnings.join(" ")).toMatch(/NDLS has retiring rooms/);
  });

  it("warns about a short overnight stay even across midnight", async () => {
    const { plan } = deps([nearStation]);
    const s = await planStay(
      plan,
      {
        arrive: NDLS,
        arrive_at: parseIstDateTime("2026-11-10T23:00"),
        depart: DEL,
        depart_at: parseIstDateTime("2026-11-11T03:00"),
      },
      opts,
      1,
    );
    expect(s.stay_hours).toBe(4);
    expect(s.warnings.join(" ")).toMatch(/Short 4 h stay.*station retiring room or an airport hotel/);
  });

  it("keeps hotels next to the arrival point in the shortlist even when many cheaper ones exist", async () => {
    // 30 cheaper hotels ~1.8 km away would fill a price-only shortlist; the station hotel must still be scored.
    const cheap = Array.from({ length: 30 }, (_, i) =>
      hotel(`c${i}`, `Cheap ${i}`, 28.63 + i * 0.0002, 77.21, 500 + i),
    );
    const station = hotel("s", "Station Inn", 28.6425, 77.2205, 1100);
    const { plan } = deps([...cheap, station]);
    const s = await planStay(
      plan,
      {
        arrive: NDLS,
        arrive_at: parseIstDateTime("2026-11-10T20:10"),
        depart: NDLS,
        depart_at: parseIstDateTime("2026-11-11T09:00"),
      },
      { ...opts, candidates: 3, value_of_time_inr_per_hour: 5000 },
      1,
    );
    expect(s.candidates[0]!.name).toBe("Station Inn");
  });

  it("falls back to price-only ranking and reports it when routing fails", async () => {
    const { plan } = deps([nearStation, cheapFar]);
    plan.travel.osrm.table = async () => {
      throw new Error("router down");
    };
    const s = await planStay(
      plan,
      {
        arrive: NDLS,
        arrive_at: parseIstDateTime("2026-11-10T20:10"),
        depart: NDLS,
        depart_at: parseIstDateTime("2026-11-11T09:00"),
      },
      { ...opts, radius_km: 10 },
      1,
    );
    expect(s.candidates[0]).toMatchObject({
      name: "Budget Midway",
      minutes_from_arrival: null,
      score_inr: null,
    });
    expect(s.sources_failed).toEqual([expect.objectContaining({ source: "osrm" })]);
  });
});
