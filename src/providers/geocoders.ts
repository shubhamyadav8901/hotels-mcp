import { z } from "zod";
import { TtlCache } from "../lib/cache.js";
import { getJson, type HttpOptions } from "../lib/http.js";
import { parseUpstream } from "./shared.js";
import type { ProviderInfo } from "./types.js";

/** A geocoder hit, already restricted to India. */
export interface GeocodeHit {
  name: string;
  /** Human-readable context, e.g. "Agra, Uttar Pradesh". */
  context: string | null;
  /** OSM category and type, e.g. "tourism"/"attraction", "railway"/"station". */
  category: string | null;
  type: string | null;
  lat: number;
  lng: number;
  source: string;
}

export const PHOTON_INFO: ProviderInfo = {
  id: "photon",
  name: "Photon geocoder (komoot, OpenStreetMap data)",
  kind: "geocoding",
  official: true,
  needsKey: false,
  limitations: ["Public instance is fair-use only."],
};

export const NOMINATIM_INFO: ProviderInfo = {
  id: "nominatim",
  name: "Nominatim geocoder (OpenStreetMap)",
  kind: "geocoding",
  official: true,
  needsKey: false,
  limitations: ["Public instance allows at most 1 request per second; results are cached."],
};

const INDIA_BBOX = "68,6,97.5,37.5";
const TTL_MS = 7 * 24 * 3_600_000;

const PhotonPayload = z.object({
  features: z.array(
    z.object({
      geometry: z.object({ coordinates: z.tuple([z.number(), z.number()]) }),
      properties: z.object({
        name: z.string().optional(),
        countrycode: z.string().optional(),
        osm_key: z.string().optional(),
        osm_value: z.string().optional(),
        city: z.string().optional(),
        district: z.string().optional(),
        state: z.string().optional(),
      }),
    }),
  ),
});

export function createPhoton(baseUrl: string, http: HttpOptions) {
  const cache = new TtlCache<GeocodeHit[]>(2000);
  return {
    info: PHOTON_INFO,
    async search(query: string, limit = 5): Promise<GeocodeHit[]> {
      const url =
        `${baseUrl.replace(/\/$/, "")}/api/?q=${encodeURIComponent(query)}` +
        `&limit=${limit}&lang=en&bbox=${INDIA_BBOX}`;
      return cache.getOrSet(url, TTL_MS, async () => {
        const data = parseUpstream("photon", PhotonPayload, await getJson(url, http));
        return data.features
          .filter((f) => !f.properties.countrycode || f.properties.countrycode === "IN")
          .map((f) => {
            const p = f.properties;
            const context = [p.city ?? p.district, p.state].filter(Boolean).join(", ");
            return {
              name: p.name ?? query,
              context: context || null,
              category: p.osm_key ?? null,
              type: p.osm_value ?? null,
              lat: f.geometry.coordinates[1],
              lng: f.geometry.coordinates[0],
              source: "photon",
            };
          });
      });
    },
  };
}

const NominatimPayload = z.array(
  z.object({
    lat: z.string(),
    lon: z.string(),
    name: z.string().optional(),
    display_name: z.string(),
    category: z.string().optional(),
    type: z.string().optional(),
  }),
);

export function createNominatim(
  baseUrl: string,
  http: HttpOptions,
  opts: { minIntervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
) {
  const {
    minIntervalMs = 1100,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
  } = opts;
  const cache = new TtlCache<GeocodeHit[]>(2000);
  let nextSlot = 0;
  let queue: Promise<void> = Promise.resolve();
  const throttle = () => {
    const turn = queue.then(async () => {
      const wait = nextSlot - now();
      if (wait > 0) await sleep(wait);
      nextSlot = now() + minIntervalMs;
    });
    queue = turn.catch(() => undefined);
    return turn;
  };

  return {
    info: NOMINATIM_INFO,
    async search(query: string, limit = 5): Promise<GeocodeHit[]> {
      const url =
        `${baseUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}` +
        `&format=jsonv2&countrycodes=in&limit=${limit}&accept-language=en`;
      return cache.getOrSet(url, TTL_MS, async () => {
        await throttle();
        const data = parseUpstream("nominatim", NominatimPayload, await getJson(url, http));
        return data.map((d) => {
          const parts = d.display_name.split(",").map((s) => s.trim());
          return {
            name: d.name || parts[0] || query,
            context: parts.slice(1, 4).join(", ") || null,
            category: d.category ?? null,
            type: d.type ?? null,
            lat: Number(d.lat),
            lng: Number(d.lon),
            source: "nominatim",
          };
        });
      });
    },
  };
}

export type Geocoder = ReturnType<typeof createPhoton>;
