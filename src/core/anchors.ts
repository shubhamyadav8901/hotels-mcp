import { STATION_CODE_ALIASES } from "../data/aliases.js";
import type { AirportRow, BusStationRow, StationRow } from "../data/datasets.js";
import type { GeocodeHit } from "../providers/geocoders.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { AppError, toAppError } from "./errors.js";
import { roundTo } from "./geo.js";
import { GridIndex } from "./grid.js";
import type { LatLng } from "./types.js";

export type AnchorKind = "station" | "airport" | "bus_station" | "landmark" | "locality" | "point";

/** A resolved place that hotels, distances and itineraries can be anchored to. */
export interface Anchor extends LatLng {
  kind: AnchorKind;
  name: string;
  /** Railway station code or IATA code, when the place has one. */
  code: string | null;
  context: string | null;
  source: string;
}

export interface PointSpec {
  lat?: number | undefined;
  lng?: number | undefined;
  station_code?: string | undefined;
  iata?: string | undefined;
  place?: string | undefined;
  label?: string | undefined;
}

export interface GazetteerDeps {
  stations: StationRow[];
  airports: AirportRow[];
  busStations: BusStationRow[];
  registry: ProviderRegistry;
  geocoders: { id: string; search(q: string, limit?: number): Promise<GeocodeHit[]> }[];
}

const STATION_WORDS = /\b(railway|rly|station|stn|junction|jn|jct|terminus|cantt?|cantonment)\b/i;
const AIRPORT_WORDS = /\b(airport|international|domestic|terminal ?\d?|t\d)\b/i;
const BUS_WORDS = /\b(bus|isbt|depot|stand|ksrtc|msrtc|rsrtc|upsrtc)\b/i;
const FILLER = new Set([
  "railway",
  "rly",
  "station",
  "stn",
  "junction",
  "jn",
  "jct",
  "airport",
  "bus",
  "stand",
  "the",
  "of",
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !FILLER.has(t));
}

const tokenMatches = (q: string, n: string) => n === q || (q.length >= 4 && n.startsWith(q));

/**
 * How well a name matches the query: `query` is the share of query tokens found in the name (a prefix of
 * 4+ letters counts, so "bengal" finds "bengaluru"); `name` is the share of the name's tokens the query
 * covers, which prefers "Delhi Junction" over "New Delhi" for the query "Delhi".
 */
function matchScore(queryTokens: string[], name: string): { query: number; name: number } {
  const nameTokens = tokens(name);
  if (queryTokens.length === 0 || nameTokens.length === 0) return { query: 0, name: 0 };
  const queryHits = queryTokens.filter((q) => nameTokens.some((n) => tokenMatches(q, n))).length;
  const nameHits = nameTokens.filter((n) => queryTokens.some((q) => tokenMatches(q, n))).length;
  return { query: queryHits / queryTokens.length, name: nameHits / nameTokens.length };
}

const stationAnchor = (s: StationRow): Anchor => ({
  kind: "station",
  name: s.name,
  code: s.code,
  context: s.kind === "halt" ? "halt" : null,
  lat: s.lat,
  lng: s.lng,
  source: "openstreetmap",
});

const airportAnchor = (a: AirportRow): Anchor => ({
  kind: "airport",
  name: a.name,
  code: a.iata,
  context: a.city,
  lat: a.lat,
  lng: a.lng,
  source: "ourairports",
});

const busAnchor = (b: BusStationRow): Anchor => ({
  kind: "bus_station",
  name: b.name,
  code: null,
  context: b.operator,
  lat: b.lat,
  lng: b.lng,
  source: "openstreetmap",
});

function geocodeAnchor(h: GeocodeHit): Anchor {
  let kind: AnchorKind = "landmark";
  if (h.category === "place" || h.category === "boundary") kind = "locality";
  else if (h.category === "railway" && h.type === "station") kind = "station";
  else if (h.category === "aeroway") kind = "airport";
  else if (h.category === "amenity" && h.type === "bus_station") kind = "bus_station";
  return { kind, name: h.name, code: null, context: h.context, lat: h.lat, lng: h.lng, source: h.source };
}

export interface NearbyAnchors {
  stations: (Anchor & { distance_km: number })[];
  airports: (Anchor & { distance_km: number })[];
  bus_stations: (Anchor & { distance_km: number })[];
}

/** Resolves station codes, IATA codes, place names and coordinates to anchors. */
export class Gazetteer {
  private readonly stationsByCode: Map<string, StationRow>;
  private readonly airportsByIata: Map<string, AirportRow>;
  private readonly stationIndex: GridIndex<StationRow>;
  private readonly airportIndex: GridIndex<AirportRow>;
  private readonly busIndex: GridIndex<BusStationRow>;

  constructor(private readonly deps: GazetteerDeps) {
    this.stationsByCode = new Map(deps.stations.map((s) => [s.code, s]));
    this.airportsByIata = new Map(deps.airports.filter((a) => a.iata).map((a) => [a.iata!, a]));
    this.stationIndex = new GridIndex(deps.stations);
    this.airportIndex = new GridIndex(deps.airports.filter((a) => a.iata));
    this.busIndex = new GridIndex(deps.busStations);
  }

  station(code: string): Anchor | null {
    const c = code.trim().toUpperCase();
    const row = this.stationsByCode.get(c) ?? this.stationsByCode.get(STATION_CODE_ALIASES[c] ?? "");
    return row ? { ...stationAnchor(row), code: c } : null;
  }

  airport(iata: string): Anchor | null {
    const row = this.airportsByIata.get(iata.trim().toUpperCase());
    return row ? airportAnchor(row) : null;
  }

  /** Ranked matches for free text: exact codes first, then local tables, then geocoders. */
  async search(
    query: string,
    opts: { kind?: AnchorKind | undefined; limit?: number } = {},
  ): Promise<{ anchors: Anchor[]; geocoder_errors: string[] }> {
    const limit = opts.limit ?? 5;
    const q = query.trim();
    if (!q) throw new AppError("INVALID_INPUT", "Place query is empty.");
    const want = (k: AnchorKind) => !opts.kind || opts.kind === k;
    const out: Anchor[] = [];
    const seen = new Set<string>();
    const add = (a: Anchor) => {
      const key = `${a.kind}:${a.code ?? ""}:${a.lat.toFixed(3)},${a.lng.toFixed(3)}`;
      if (!seen.has(key)) (seen.add(key), out.push(a));
    };

    if (/^[A-Za-z]{1,5}$/.test(q)) {
      if (want("airport") && q.length === 3) {
        const a = this.airport(q);
        if (a) add(a);
      }
      if (want("station")) {
        const s = this.station(q);
        if (s) add(s);
      }
    }
    // An all-capitals query that matched a code ("BLR", "NDLS") is a code, not a town name: no geocoding.
    // Mixed case ("Puri") may still mean the town.
    const isCode = out.length > 0 && q === q.toUpperCase();

    const qt = tokens(q);
    const hinted: AnchorKind | null = STATION_WORDS.test(q)
      ? "station"
      : AIRPORT_WORDS.test(q)
        ? "airport"
        : BUS_WORDS.test(q)
          ? "bus_station"
          : null;
    const local: { a: Anchor; score: number }[] = [];
    const consider = (kind: AnchorKind, name: string, make: () => Anchor, bonus = 0) => {
      if (!want(kind)) return;
      const m = matchScore(qt, name);
      if (m.query >= 0.99) {
        local.push({ a: make(), score: m.query + 0.3 * m.name + bonus + (hinted === kind ? 0.5 : 0) });
      }
    };
    for (const s of this.deps.stations)
      consider("station", s.name, () => stationAnchor(s), s.kind === "station" ? 0.1 : 0);
    for (const a of this.deps.airports) {
      if (a.iata) consider("airport", `${a.name} ${a.city ?? ""}`, () => airportAnchor(a), 0.2);
    }
    for (const b of this.deps.busStations) consider("bus_station", b.name, () => busAnchor(b));
    // Prefer kinds the query names, then fuller matches, then shorter (more specific) names.
    local.sort((x, y) => y.score - x.score || x.a.name.length - y.a.name.length);
    for (const { a } of local.slice(0, limit)) add(a);

    const geocoder_errors: string[] = [];
    if (
      // Geocode when nothing local matched, or when the query may be a town, landmark or locality rather
      // than the station/airport/bus terminal it would otherwise name ("Jaipur" the city, not Jaipur Jn).
      !isCode &&
      (local.length === 0 ||
        (hinted === null && (!opts.kind || opts.kind === "landmark" || opts.kind === "locality")))
    ) {
      for (const g of this.deps.geocoders) {
        if (!this.deps.registry.isEnabled(g.id)) continue;
        try {
          const hits = await this.deps.registry.run(g.id, () => g.search(q, limit));
          for (const h of hits) {
            const a = geocodeAnchor(h);
            if (want(a.kind)) add(a);
          }
          break;
        } catch (err) {
          geocoder_errors.push(`${g.id}: ${toAppError(err).message}`);
        }
      }
    }
    // A town or area named exactly as asked ("Jaipur", "Hampi") is what "hotels in X" means: put it first.
    if (hinted === null && !opts.kind) {
      const wanted = tokens(q).join(" ");
      const i = out.findIndex((a) => a.kind === "locality" && tokens(a.name).join(" ") === wanted);
      if (i > 0) out.unshift(...out.splice(i, 1));
    }
    return { anchors: out.slice(0, limit), geocoder_errors };
  }

  /** Nearest railway stations within `maxKm`, nearest first (for places with no station of their own). */
  nearestStations(p: LatLng, maxKm = 150, limit = 3): (Anchor & { distance_km: number })[] {
    // Filter halts before limiting, so a halt-dense area still yields its nearest proper stations.
    return this.stationIndex
      .within(p, maxKm)
      .filter(({ item }) => item.kind === "station")
      .slice(0, limit)
      .map(({ item, km }) => ({ ...stationAnchor(item), distance_km: roundTo(km, 1) }));
  }

  nearby(p: LatLng): NearbyAnchors {
    const withKm =
      <T>(make: (r: T) => Anchor) =>
      (h: { item: T; km: number }) => ({
        ...make(h.item),
        distance_km: roundTo(h.km, 2),
      });
    return {
      stations: this.stationIndex.within(p, 10, 3).map(withKm(stationAnchor)),
      airports: this.airportIndex.within(p, 60, 2).map(withKm(airportAnchor)),
      bus_stations: this.busIndex.within(p, 5, 2).map(withKm(busAnchor)),
    };
  }

  /** Resolves exactly one of lat/lng, station_code, iata or place to a labelled anchor. */
  async resolvePoint(spec: PointSpec): Promise<Anchor & { label: string }> {
    const forms = [
      spec.lat !== undefined || spec.lng !== undefined,
      spec.station_code !== undefined,
      spec.iata !== undefined,
      spec.place !== undefined,
    ].filter(Boolean).length;
    if (forms !== 1) {
      throw new AppError("INVALID_INPUT", "Give exactly one of: lat+lng, station_code, iata or place.");
    }
    let anchor: Anchor | null = null;
    if (spec.lat !== undefined || spec.lng !== undefined) {
      if (spec.lat === undefined || spec.lng === undefined) {
        throw new AppError("INVALID_INPUT", "lat and lng must be given together.");
      }
      anchor = {
        kind: "point",
        name: `${spec.lat},${spec.lng}`,
        code: null,
        context: null,
        lat: spec.lat,
        lng: spec.lng,
        source: "input",
      };
    } else if (spec.station_code !== undefined) {
      anchor = this.station(spec.station_code);
      if (!anchor) {
        throw new AppError(
          "NOT_FOUND",
          `Unknown station code ${spec.station_code}.`,
          "Pass the station's lat/lng instead, or use resolve_place with the station name.",
        );
      }
    } else if (spec.iata !== undefined) {
      anchor = this.airport(spec.iata);
      if (!anchor) {
        throw new AppError(
          "NOT_FOUND",
          `Unknown Indian airport IATA code ${spec.iata}.`,
          "Pass lat/lng or a place name instead.",
        );
      }
    } else {
      const { anchors, geocoder_errors } = await this.search(spec.place!, { limit: 1 });
      anchor = anchors[0] ?? null;
      if (!anchor) {
        const why = geocoder_errors.length ? ` (geocoders: ${geocoder_errors.join("; ")})` : "";
        throw new AppError(
          "NOT_FOUND",
          `No place in India matches "${spec.place}"${why}.`,
          "Try resolve_place with a more specific name.",
        );
      }
    }
    return { ...anchor, label: spec.label ?? anchor.code ?? anchor.name };
  }
}

/**
 * A readable name for searching near an anchor by text (Google Hotels), or undefined when there is none.
 * Coordinates get the name of the nearest railway station within 3 km.
 */
export function searchPlaceName(
  anchor: Anchor,
  gazetteer: Gazetteer,
): { name: string; area: boolean } | undefined {
  const withContext = (name: string) => (anchor.context ? `${name}, ${anchor.context}` : name);
  switch (anchor.kind) {
    case "station":
      return {
        name: /\b(station|junction|jn|terminus|central)\b/i.test(anchor.name)
          ? anchor.name
          : `${anchor.name} railway station`,
        area: false,
      };
    case "airport":
    case "bus_station":
    case "landmark":
      return { name: withContext(anchor.name), area: false };
    case "locality":
      return { name: withContext(anchor.name), area: true };
    case "point": {
      const near = gazetteer.nearby(anchor).stations.find((s) => s.distance_km <= 3);
      return near ? searchPlaceName({ ...near, kind: "station" }, gazetteer) : undefined;
    }
  }
}
