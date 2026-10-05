import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { SnapshotInfo } from "../providers/types.js";

export interface StationRow {
  osm_id: string;
  code: string;
  name: string;
  kind: "station" | "halt";
  lat: number;
  lng: number;
}

export interface BusStationRow {
  osm_id: string;
  name: string;
  operator: string | null;
  lat: number;
  lng: number;
}

export interface LodgingRow {
  osm_id: string;
  name: string;
  type: "hotel" | "guest_house" | "hostel" | "motel";
  stars: number | null;
  brand: string | null;
  has_phone: boolean;
  has_website: boolean;
  lat: number;
  lng: number;
}

export interface AirportRow {
  iata: string | null;
  icao: string | null;
  name: string;
  city: string | null;
  type: "large" | "medium" | "small";
  scheduled: boolean;
  lat: number;
  lng: number;
}

export interface RetiringRoomRow {
  station_code: string;
  station_name: string;
  managed_by: string;
  lat: number | null;
  lng: number | null;
}

export type DatasetId = "stations" | "bus_stations" | "lodging" | "airports" | "retiring_rooms" | "xotelo_keys";

export interface Manifest {
  datasets: Partial<Record<DatasetId, { rows: number; built_at: string; source: string; licence: string }>>;
}

const DESCRIPTIONS: Record<DatasetId, string> = {
  stations: "Indian Railways stations and halts with station codes",
  bus_stations: "Bus stations and terminals",
  lodging: "Hotels, guest houses, hostels and motels (locations only, no prices)",
  airports: "Indian airports with IATA codes",
  retiring_rooms: "Railway stations with IRCTC retiring rooms",
  xotelo_keys: "TripAdvisor location keys with centres, for Xotelo price lookups",
};

/**
 * The project's data/ directory: the nearest ancestor of `start` holding package.json, plus "data".
 * Works from both src/data (tsx) and dist/src/data (compiled), and inside the Docker image.
 */
export function findDataDir(start: string): string {
  let dir = start;
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No package.json above ${start}; cannot locate data/`);
    dir = parent;
  }
  return join(dir, "data");
}

export const DEFAULT_DATA_DIR = findDataDir(dirname(fileURLToPath(import.meta.url)));

export function loadDataset<T>(id: DatasetId, dir = DEFAULT_DATA_DIR): T[] {
  const file = join(dir, `${id}.json.gz`);
  if (!existsSync(file)) return [];
  return JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as T[];
}

export function readManifest(dir = DEFAULT_DATA_DIR): Manifest {
  const file = join(dir, "manifest.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Manifest) : { datasets: {} };
}

export function snapshotInfo(manifest: Manifest): SnapshotInfo[] {
  return (Object.keys(DESCRIPTIONS) as DatasetId[]).map((id) => {
    const m = manifest.datasets[id];
    return {
      id,
      description: DESCRIPTIONS[id],
      rows: m?.rows ?? 0,
      built_at: m?.built_at ?? null,
      source: m?.source ?? "not built",
      licence: m?.licence ?? "",
    };
  });
}
