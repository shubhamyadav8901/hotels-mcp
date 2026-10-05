import { describe, expect, it, vi } from "vitest";
import { Gazetteer } from "../src/core/anchors.js";
import { HotelMemory } from "../src/core/hotel-memory.js";
import type { AirportRow, BusStationRow, StationRow } from "../src/data/datasets.js";
import type { GeocodeHit } from "../src/providers/geocoders.js";
import { createOsrm } from "../src/providers/osrm.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { connect, testDeps } from "./helpers.js";

// Synthetic gazetteer: invented names, realistic codes and coordinates.
const stations: StationRow[] = [
  { osm_id: "n1", code: "NDLS", name: "New Delhi", kind: "station", lat: 28.6419, lng: 77.2218 },
  { osm_id: "n2", code: "DLI", name: "Delhi Junction", kind: "station", lat: 28.6609, lng: 77.2277 },
  { osm_id: "n3", code: "BSBS", name: "Banaras", kind: "station", lat: 25.2992, lng: 82.971 },
  { osm_id: "n4", code: "XYZ", name: "Delhi Halt", kind: "halt", lat: 28.7, lng: 77.3 },
];
const airports: AirportRow[] = [
  {
    iata: "DEL",
    icao: "VIDP",
    name: "Indira Gandhi International Airport",
    city: "New Delhi",
    type: "large",
    scheduled: true,
    lat: 28.5556,
    lng: 77.0952,
  },
];
const busStations: BusStationRow[] = [
  { osm_id: "n9", name: "Kashmere Gate ISBT", operator: null, lat: 28.6675, lng: 77.2285 },
];

function gazetteer(geocode: (q: string) => Promise<GeocodeHit[]> = async () => []) {
  const registry = new ProviderRegistry();
  registry.register({
    id: "photon",
    name: "Photon",
    kind: "geocoding",
    official: true,
    needsKey: false,
    limitations: [],
  });
  const search = vi.fn(geocode);
  return {
    g: new Gazetteer({ stations, airports, busStations, registry, geocoders: [{ id: "photon", search }] }),
    search,
  };
}

describe("Gazetteer", () => {
  it("resolves station codes, including current codes OSM still lists under an old code", () => {
    const { g } = gazetteer();
    expect(g.station("ndls")).toMatchObject({ kind: "station", code: "NDLS", lat: 28.6419 });
    expect(g.station("BNRS")).toMatchObject({ name: "Banaras", code: "BNRS" });
    expect(g.station("QQQ")).toBeNull();
    expect(g.airport("del")).toMatchObject({ kind: "airport", code: "DEL" });
  });

  it("ranks the kind a query names first and skips the geocoder for good local matches", async () => {
    const { g, search } = gazetteer();
    const r = await g.search("Delhi railway station");
    expect(r.anchors[0]).toMatchObject({ kind: "station", code: "DLI" });
    expect(search).not.toHaveBeenCalled();
    const air = await g.search("Delhi airport");
    expect(air.anchors[0]).toMatchObject({ kind: "airport", code: "DEL" });
  });

  it("matches exact codes before names", async () => {
    const { g } = gazetteer();
    const r = await g.search("DEL");
    expect(r.anchors[0]).toMatchObject({ kind: "airport", code: "DEL" });
  });

  it("falls back to geocoding for landmarks and classifies the hits", async () => {
    const { g, search } = gazetteer(async () => [
      {
        name: "Taj Mahal",
        context: "Agra, Uttar Pradesh",
        category: "tourism",
        type: "attraction",
        lat: 27.175,
        lng: 78.042,
        source: "photon",
      },
    ]);
    const r = await g.search("Taj Mahal");
    expect(search).toHaveBeenCalledOnce();
    expect(r.anchors[0]).toMatchObject({ kind: "landmark", name: "Taj Mahal", source: "photon" });
  });

  it("reports geocoder failures instead of hiding them", async () => {
    const { g } = gazetteer(async () => {
      throw new Error("photon down");
    });
    const r = await g.search("Some Ghat");
    expect(r.anchors).toEqual([]);
    expect(r.geocoder_errors[0]).toMatch(/photon down/);
  });

  it("finds nearby transport points for coordinates", () => {
    const { g } = gazetteer();
    const n = g.nearby({ lat: 28.643, lng: 77.2194 });
    expect(n.stations.map((s) => s.code)).toEqual(["NDLS", "DLI"]);
    expect(n.airports[0]).toMatchObject({ code: "DEL" });
    expect(n.bus_stations[0]).toMatchObject({ name: "Kashmere Gate ISBT" });
  });

  it("requires exactly one way of naming a point", async () => {
    const { g } = gazetteer();
    await expect(g.resolvePoint({ lat: 28.6, lng: 77.2, iata: "DEL" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(g.resolvePoint({ lat: 28.6 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(g.resolvePoint({ station_code: "QQQ" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(g.resolvePoint({ iata: "DEL", label: "fly out" })).resolves.toMatchObject({
      label: "fly out",
      code: "DEL",
    });
  });
});

describe("travel tools over MCP", () => {
  // Fake OSRM: 10 minutes and 5 km for every leg.
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const s = url.searchParams.get("sources")!.split(";");
    const d = url.searchParams.get("destinations")!.split(";");
    return new Response(
      JSON.stringify({
        code: "Ok",
        durations: s.map(() => d.map(() => 600)),
        distances: s.map(() => d.map(() => 5000)),
        sources: s.map(() => ({ distance: 3 })),
        destinations: d.map(() => ({ distance: 3 })),
      }),
    );
  }) as unknown as typeof fetch;

  function deps() {
    const registry = new ProviderRegistry();
    const osrm = createOsrm({
      carUrl: "https://osrm.local/car",
      footUrl: "https://osrm.local/foot",
      http: { userAgent: "t", fetchImpl },
    });
    registry.register(osrm.info);
    const { g } = gazetteer();
    const memory = new HotelMemory();
    memory.remember(
      [
        {
          hotel_id: "trivago:abc",
          also_ids: ["hotelscasa:xyz"],
          name: "Fixture Inn",
          lat: 28.6435,
          lng: 77.2175,
          stars: 3,
          rating_10: 8,
          review_count: 10,
          sources: ["trivago", "hotelscasa"],
          prices: [
            {
              source: "hotelscasa",
              seller: null,
              per_night: 20,
              total: 20,
              currency: "EUR",
              per_night_inr: 2100,
              includes_taxes: true,
              available: true,
              refundable: true,
              url: null,
              fetched_at: "t",
            },
          ],
        },
      ],
      { check_in: "2026-11-10", check_out: "2026-11-11" },
    );
    return testDeps({
      registry,
      gazetteer: g,
      memory,
      travel: { osrm, registry, metroMultiplier: 1.5, otherMultiplier: 1.2 },
    });
  }

  it("travel_times resolves codes and returns traffic-adjusted legs", async () => {
    const client = await connect(deps());
    const r = await client.callTool({
      name: "travel_times",
      arguments: { origins: [{ station_code: "NDLS" }], destinations: [{ iata: "DEL", label: "airport" }] },
    });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { legs: unknown[] }).legs).toEqual([
      expect.objectContaining({
        from: "NDLS",
        to: "airport",
        road_km: 5,
        minutes_raw: 10,
        minutes: 15,
        traffic_multiplier: 1.5,
      }),
    ]);
  });

  it("compare_hotels accepts ids from a recent search (any source id) and raw coordinates", async () => {
    const client = await connect(deps());
    const r = await client.callTool({
      name: "compare_hotels",
      arguments: {
        hotels: [{ hotel_id: "hotelscasa:xyz" }, { name: "Other Hotel", lat: 28.65, lng: 77.22 }],
        places: [
          { station_code: "NDLS", label: "arrive" },
          { iata: "DEL", label: "depart" },
        ],
      },
    });
    expect(r.isError).toBeFalsy();
    const hotels = (
      r.structuredContent as {
        hotels: {
          name: string;
          rank: number;
          total_minutes: number;
          cheapest: { per_night_inr: number } | null;
        }[];
      }
    ).hotels;
    expect(hotels).toHaveLength(2);
    // Equal times, so the hotel with a known price ranks first.
    expect(hotels[0]).toMatchObject({
      name: "Fixture Inn",
      rank: 1,
      total_minutes: 30,
      cheapest: {
        per_night_inr: 2100,
        seller: "hotelscasa",
        source: "hotelscasa",
        fetched_at: "t",
        check_in: "2026-11-10",
        check_out: "2026-11-11",
      },
    });
    expect(hotels[1]).toMatchObject({ name: "Other Hotel", rank: 2, cheapest: null });
  });

  it("compare_hotels explains how to recover from an unknown hotel_id", async () => {
    const client = await connect(deps());
    const r = await client.callTool({
      name: "compare_hotels",
      arguments: { hotels: [{ hotel_id: "trivago:gone" }], places: [{ station_code: "NDLS" }] },
    });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toMatch(/search_hotels again/);
  });

  it("resolve_place returns nearby transport for coordinates", async () => {
    const client = await connect(deps());
    const r = await client.callTool({ name: "resolve_place", arguments: { lat: 28.643, lng: 77.2194 } });
    expect(r.structuredContent).toMatchObject({ nearby: { stations: [{ code: "NDLS" }, { code: "DLI" }] } });
  });
});
