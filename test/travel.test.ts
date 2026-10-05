import { describe, expect, it, vi } from "vitest";
import { metroOf, trafficMultiplier } from "../src/core/traffic.js";
import { travelMatrix } from "../src/core/travel.js";
import { createOsrm } from "../src/providers/osrm.js";
import { ProviderRegistry } from "../src/providers/registry.js";

const NDLS = { lat: 28.643, lng: 77.2194 };
const DEL = { lat: 28.5562, lng: 77.1 };
const AGRA = { lat: 27.1767, lng: 78.0081 };

/** Fake OSRM: duration = 60 s and distance = 1000 m per index step, so results are predictable. */
function fakeOsrmFetch(opts: { snap?: number; code?: string } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const sources = url.searchParams.get("sources")!.split(";").map(Number);
    const dests = url.searchParams.get("destinations")!.split(";").map(Number);
    const body = {
      code: opts.code ?? "Ok",
      durations: sources.map((s) => dests.map((d) => Math.abs(d - s) * 60)),
      distances: sources.map((s) => dests.map((d) => Math.abs(d - s) * 1000)),
      sources: sources.map(() => ({ distance: opts.snap ?? 5 })),
      destinations: dests.map(() => ({ distance: opts.snap ?? 5 })),
    };
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

function osrm(fetchImpl: typeof fetch, url = "https://osrm.local/car") {
  return createOsrm({
    carUrl: url,
    footUrl: "https://osrm.local/foot",
    http: { userAgent: "test", fetchImpl },
    sleep: async () => undefined,
  });
}

describe("traffic multiplier", () => {
  it("applies the metro factor when either end is in a metro", () => {
    expect(metroOf(NDLS)).toBe("Delhi NCR");
    expect(metroOf(AGRA)).toBeNull();
    expect(trafficMultiplier(AGRA, NDLS, 1.5, 1.2)).toBe(1.5);
    expect(trafficMultiplier(AGRA, { lat: 27.18, lng: 78.02 }, 1.5, 1.2)).toBe(1.2);
  });
});

describe("OSRM provider", () => {
  it("requests a sources/destinations table and converts units", async () => {
    const f = fakeOsrmFetch();
    const legs = await osrm(f as unknown as typeof fetch).table("drive", [NDLS], [DEL, AGRA]);
    expect(String(f.mock.calls[0]![0])).toMatch(
      /\/car\/table\/v1\/driving\/77\.219400,28\.643000;.*\?sources=0&destinations=1;2&annotations=duration,distance$/,
    );
    expect(legs[0]).toEqual([
      { distance_km: 1, minutes: 1, snap_m: 5 },
      { distance_km: 2, minutes: 2, snap_m: 5 },
    ]);
  });

  it("serves repeated legs from cache", async () => {
    const f = fakeOsrmFetch();
    const o = osrm(f as unknown as typeof fetch);
    await o.table("drive", [NDLS], [DEL]);
    await o.table("drive", [NDLS], [DEL]);
    expect(f).toHaveBeenCalledTimes(1);
    // Walking is cached separately.
    await o.table("walk", [NDLS], [DEL]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("splits large tables into requests under the public size cap", async () => {
    const f = fakeOsrmFetch();
    const dests = Array.from({ length: 200 }, (_, i) => ({ lat: 28 + i / 1000, lng: 77 }));
    const legs = await osrm(f as unknown as typeof fetch).table("drive", [NDLS], dests);
    expect(f.mock.calls.length).toBe(3);
    expect(legs[0]).toHaveLength(200);
    expect(legs[0]!.every((l) => l.minutes !== null)).toBe(true);
  });

  it("spaces requests to public servers at least the minimum interval apart", async () => {
    let clock = 0;
    const waits: number[] = [];
    const o = createOsrm({
      carUrl: "https://routing.openstreetmap.de/routed-car",
      footUrl: "https://routing.openstreetmap.de/routed-foot",
      http: { userAgent: "test", fetchImpl: fakeOsrmFetch() as unknown as typeof fetch },
      publicMinIntervalMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    await Promise.all([o.table("drive", [NDLS], [DEL]), o.table("drive", [NDLS], [AGRA])]);
    expect(waits).toEqual([1000]);
  });

  it("raises an upstream error when OSRM cannot route", async () => {
    const f = fakeOsrmFetch({ code: "NoTable" });
    await expect(osrm(f as unknown as typeof fetch).table("drive", [NDLS], [DEL])).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
  });
});

describe("travelMatrix", () => {
  function deps(f: ReturnType<typeof fakeOsrmFetch>) {
    const registry = new ProviderRegistry();
    const o = osrm(f as unknown as typeof fetch);
    registry.register(o.info);
    return { osrm: o, registry, metroMultiplier: 1.5, otherMultiplier: 1.2 };
  }

  it("reports raw and traffic-adjusted minutes plus straight-line distance", async () => {
    const [[leg]] = (await travelMatrix(
      deps(fakeOsrmFetch()),
      [{ ...NDLS, label: "NDLS" }],
      [{ ...DEL, label: "DEL" }],
      "drive",
    )) as [[import("../src/core/travel.js").TravelLeg]];
    expect(leg).toMatchObject({
      from: "NDLS",
      to: "DEL",
      road_km: 1,
      minutes_raw: 1,
      minutes: 2,
      traffic_multiplier: 1.5,
    });
    expect(leg.straight_km).toBeGreaterThan(14);
    expect(leg.warning).toBeNull();
  });

  it("does not apply traffic to walking and warns about far-off-road points", async () => {
    const [[leg]] = (await travelMatrix(
      deps(fakeOsrmFetch({ snap: 900 })),
      [{ ...NDLS, label: "a" }],
      [{ ...DEL, label: "b" }],
      "walk",
    )) as [[import("../src/core/travel.js").TravelLeg]];
    expect(leg.traffic_multiplier).toBe(1);
    expect(leg.warning).toMatch(/900 m/);
  });
});
