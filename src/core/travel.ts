import type { Osrm, TravelMode } from "../providers/osrm.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { haversineKm, roundTo } from "./geo.js";
import { trafficMultiplier } from "./traffic.js";
import type { LatLng } from "./types.js";

export interface LabelledPoint extends LatLng {
  label: string;
}

export interface TravelLeg {
  from: string;
  to: string;
  straight_km: number;
  road_km: number | null;
  /** Free-flow minutes from the router. */
  minutes_raw: number | null;
  /** Minutes after the traffic multiplier (drive) — the figure to plan with. Equals raw for walking. */
  minutes: number | null;
  traffic_multiplier: number;
  /** Set when the router had to move a point more than 500 m to reach a road. */
  warning: string | null;
}

export interface TravelDeps {
  osrm: Osrm;
  registry: ProviderRegistry;
  metroMultiplier: number;
  otherMultiplier: number;
}

const SNAP_WARN_M = 500;

export async function travelMatrix(
  deps: TravelDeps,
  origins: LabelledPoint[],
  dests: LabelledPoint[],
  mode: TravelMode,
): Promise<TravelLeg[][]> {
  const table = await deps.registry.run("osrm", () => deps.osrm.table(mode, origins, dests));
  return origins.map((o, i) =>
    dests.map((d, j) => {
      const leg = table[i]![j]!;
      const mult = mode === "drive" ? trafficMultiplier(o, d, deps.metroMultiplier, deps.otherMultiplier) : 1;
      return {
        from: o.label,
        to: d.label,
        straight_km: roundTo(haversineKm(o, d), 2),
        road_km: leg.distance_km,
        minutes_raw: leg.minutes,
        minutes: leg.minutes === null ? null : Math.round(leg.minutes * mult),
        traffic_multiplier: mult,
        warning:
          leg.snap_m > SNAP_WARN_M
            ? `A point is ${leg.snap_m} m from the nearest routable road; this leg may be inaccurate.`
            : leg.minutes === null
              ? "No route found."
              : null,
      };
    }),
  );
}
