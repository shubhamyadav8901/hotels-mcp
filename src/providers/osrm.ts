import { z } from "zod";
import { AppError, upstreamText } from "../core/errors.js";
import type { LatLng } from "../core/types.js";
import { TtlCache } from "../lib/cache.js";
import { getJson, type HttpOptions } from "../lib/http.js";
import { parseUpstream } from "./shared.js";
import type { ProviderInfo } from "./types.js";

export type TravelMode = "drive" | "walk";

export const OSRM_INFO: ProviderInfo = {
  id: "osrm",
  name: "OSRM routing on OpenStreetMap",
  kind: "routing",
  official: true,
  needsKey: false,
  limitations: [
    "No live or typical traffic: raw drive times are free-flow; a configurable multiplier is applied.",
    "Public instances are for light use; set OSRM_URL to a self-hosted server for heavy use.",
  ],
};

/** One origin→destination leg; null fields mean the router found no route. */
export interface Leg {
  distance_km: number | null;
  minutes: number | null;
  /** How far (m) the router had to move the point to reach a road; large values mean an unreliable leg. */
  snap_m: number;
}

const Table = z.object({
  code: z.string(),
  message: z.string().optional(),
  durations: z.array(z.array(z.number().nullable())).optional(),
  distances: z.array(z.array(z.number().nullable())).optional(),
  sources: z.array(z.object({ distance: z.number() })).optional(),
  destinations: z.array(z.object({ distance: z.number() })).optional(),
});

// Public OSRM servers cap table size; keep each request comfortably below 100 coordinates.
const MAX_COORDS_PER_REQUEST = 80;
const CACHE_TTL_MS = 7 * 24 * 3_600_000;
const PUBLIC_HOSTS = ["routing.openstreetmap.de", "router.project-osrm.org"];

export interface OsrmOptions {
  carUrl: string;
  footUrl: string;
  http: HttpOptions;
  /** Minimum gap between requests to public servers (their usage policy asks for about 1/s). */
  publicMinIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function createOsrm(opts: OsrmOptions) {
  const cache = new TtlCache<Leg>(20_000);
  const {
    publicMinIntervalMs = 1000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
  } = opts;
  let nextSlot = 0;
  let queue: Promise<void> = Promise.resolve();

  /** Serialises requests to public hosts so they are at least `publicMinIntervalMs` apart. */
  function throttle(url: string): Promise<void> {
    if (!PUBLIC_HOSTS.includes(new URL(url).host)) return Promise.resolve();
    const turn = queue.then(async () => {
      const wait = nextSlot - now();
      if (wait > 0) await sleep(wait);
      nextSlot = now() + publicMinIntervalMs;
    });
    queue = turn.catch(() => undefined);
    return turn;
  }

  const key = (mode: TravelMode, a: LatLng, b: LatLng) =>
    `${mode}:${a.lat.toFixed(5)},${a.lng.toFixed(5)}>${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;

  async function fetchTable(mode: TravelMode, origins: LatLng[], dests: LatLng[]): Promise<Leg[][]> {
    const base = mode === "drive" ? opts.carUrl : opts.footUrl;
    const profile = mode === "drive" ? "driving" : "foot";
    const coords = [...origins, ...dests].map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
    const sources = origins.map((_, i) => i).join(";");
    const destinations = dests.map((_, i) => origins.length + i).join(";");
    const url =
      `${base.replace(/\/$/, "")}/table/v1/${profile}/${coords}` +
      `?sources=${sources}&destinations=${destinations}&annotations=duration,distance`;
    await throttle(url);
    const t = parseUpstream("osrm", Table, await getJson(url, { ...opts.http, timeoutMs: 15_000 }));
    if (t.code !== "Ok" || !t.durations || !t.distances) {
      throw new AppError("UPSTREAM_UNAVAILABLE", `OSRM could not route (${upstreamText(t.code, 40)})`);
    }
    return origins.map((_, i) =>
      dests.map((_, j) => {
        const sec = t.durations![i]?.[j] ?? null;
        const m = t.distances![i]?.[j] ?? null;
        const snap = Math.max(t.sources?.[i]?.distance ?? 0, t.destinations?.[j]?.distance ?? 0);
        return {
          distance_km: m === null ? null : Math.round(m / 100) / 10,
          minutes: sec === null ? null : Math.round(sec / 6) / 10,
          snap_m: Math.round(snap),
        };
      }),
    );
  }

  return {
    info: OSRM_INFO,
    /** Matrix of legs [origin][destination], using cached legs where available. */
    async table(mode: TravelMode, origins: LatLng[], dests: LatLng[]): Promise<Leg[][]> {
      const out: (Leg | undefined)[][] = origins.map((o) => dests.map((d) => cache.get(key(mode, o, d))));
      const missingDest = dests.map((_, j) => j).filter((j) => out.some((row) => row[j] === undefined));
      const missingOrig = origins.map((_, i) => i).filter((i) => out[i]!.some((leg) => leg === undefined));

      const chunkSize = Math.max(1, MAX_COORDS_PER_REQUEST - missingOrig.length);
      for (let start = 0; start < missingDest.length; start += chunkSize) {
        const destIdx = missingDest.slice(start, start + chunkSize);
        const legs = await fetchTable(
          mode,
          missingOrig.map((i) => origins[i]!),
          destIdx.map((j) => dests[j]!),
        );
        missingOrig.forEach((i, oi) =>
          destIdx.forEach((j, di) => {
            const leg = legs[oi]![di]!;
            out[i]![j] = leg;
            cache.set(key(mode, origins[i]!, dests[j]!), leg, CACHE_TTL_MS);
          }),
        );
      }
      return out as Leg[][];
    },
  };
}

export type Osrm = ReturnType<typeof createOsrm>;
