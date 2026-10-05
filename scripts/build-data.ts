/**
 * Builds the bundled datasets in data/ from OpenStreetMap (Overpass), OurAirports and, only with
 * --with-irctc, IRCTC's public retiring-room station list. Run by hand about once a month:
 *
 *   HTTP_USER_AGENT="india-hotels-mcp/0.1 (you@example.com)" npm run build:data [-- --with-irctc] [-- --only=stations]
 *
 * IRCTC's terms forbid automated access, so its list is fetched only on an explicit, manual refresh.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { constants as cryptoConstants } from "node:crypto";
import { get as httpsGet } from "node:https";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  AirportRow,
  BusStationRow,
  LodgingRow,
  Manifest,
  RetiringRoomRow,
  StationRow,
} from "../src/data/datasets.js";
import { STATION_CODE_ALIASES } from "../src/data/aliases.js";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const UA = process.env.HTTP_USER_AGENT;
if (!UA) {
  console.error("Set HTTP_USER_AGENT (app name + contact) as the Overpass and Nominatim policies require.");
  process.exit(1);
}
const args = process.argv.slice(2);
const only = args
  .find((a) => a.startsWith("--only="))
  ?.slice(7)
  .split(",");
const withIrctc = args.includes("--with-irctc");
const want = (id: string) => !only || only.includes(id);

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const AREA = `area["ISO3166-1"="IN"][admin_level=2]->.a;`;
const HEADER = `[out:json][timeout:600][maxsize:536870912];`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

async function overpass(selector: string): Promise<OsmElement[]> {
  const query = `${HEADER}${AREA}${selector}(area.a);out center tags;`;
  for (const endpoint of OVERPASS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "User-Agent": UA!, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(700_000),
      }).catch((err: unknown) => err as Error);
      if (res instanceof Response && res.ok) {
        const json = (await res.json()) as { elements: OsmElement[]; remark?: string };
        if (json.remark?.includes("error")) throw new Error(`Overpass: ${json.remark}`);
        return json.elements;
      }
      const why = res instanceof Response ? `HTTP ${res.status}` : res.message;
      console.error(`  ${new URL(endpoint).host} attempt ${attempt} failed (${why}); retrying in 15 s`);
      await sleep(15_000);
    }
  }
  throw new Error(`All Overpass endpoints failed for ${selector}`);
}

const coords = (e: OsmElement) => {
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  return lat === undefined || lon === undefined ? null : { lat: round5(lat), lng: round5(lon) };
};
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;
const osmId = (e: OsmElement) => `${e.type[0]}${e.id}`;
const now = new Date().toISOString();

function write(file: string, rows: unknown[]): number {
  const buf = gzipSync(JSON.stringify(rows));
  writeFileSync(join(DATA_DIR, file), buf);
  console.error(`  wrote ${file}: ${rows.length} rows, ${(buf.length / 1024).toFixed(0)} KB gz`);
  return rows.length;
}

const manifestPath = join(DATA_DIR, "manifest.json");
const manifest: Manifest = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest)
  : { datasets: {} };
const OSM_SOURCE = "OpenStreetMap via Overpass API";
const ODBL = "ODbL 1.0 — © OpenStreetMap contributors";

async function buildStations(): Promise<StationRow[]> {
  console.error("stations…");
  const byCode = new Map<string, StationRow>();
  for (const e of await overpass(`nwr["railway"~"^(station|halt)$"]`)) {
    const t = e.tags ?? {};
    // Metro, monorail and light-rail stations carry their own refs that clash with Indian Railways codes.
    if (t.station && /^(subway|monorail|light_rail|tram)$/.test(t.station)) continue;
    const code = (t.ref ?? t["railway:ref"] ?? "").trim().toUpperCase();
    const p = coords(e);
    if (!/^[A-Z]{1,5}$/.test(code) || !p || !t.name) continue;
    const row: StationRow = {
      osm_id: osmId(e),
      code,
      name: t["name:en"] ?? t.name,
      kind: t.railway === "halt" ? "halt" : "station",
      ...p,
    };
    // Prefer nodes (the station point) over station areas.
    const prev = byCode.get(code);
    if (!prev || (prev.osm_id[0] !== "n" && row.osm_id[0] === "n")) byCode.set(code, row);
  }
  const rows = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  manifest.datasets.stations = {
    rows: write("stations.json.gz", rows),
    built_at: now,
    source: OSM_SOURCE,
    licence: ODBL,
  };
  return rows;
}

async function buildBusStations(): Promise<void> {
  console.error("bus stations…");
  const rows: BusStationRow[] = [];
  for (const e of await overpass(`nwr["amenity"="bus_station"]`)) {
    const t = e.tags ?? {};
    const p = coords(e);
    const name = t["name:en"] ?? t.name;
    if (!p || !name) continue;
    rows.push({ osm_id: osmId(e), name, operator: t.operator ?? null, ...p });
  }
  manifest.datasets.bus_stations = {
    rows: write("bus_stations.json.gz", rows),
    built_at: now,
    source: OSM_SOURCE,
    licence: ODBL,
  };
}

const NOT_TRAVELLER_HOSTEL =
  /\b(boys|girls|ladies|gents|students?|college|university|iit|nit|aiims|medical|hostel no\.?|block|hall)\b/i;
const BRANDS: [RegExp, string][] = [
  [/\boyo\b|\btownhouse\b|\bcapital o\b/i, "OYO"],
  [/\btreebo\b/i, "Treebo"],
  [/\bfab ?hotels?\b/i, "FabHotels"],
  [/\bzostel\b/i, "Zostel"],
  [/\bgostops\b/i, "goSTOPS"],
  [/\bthe hosteller\b/i, "The Hosteller"],
  [/\bginger\b/i, "Ginger"],
  [/\blemon tree\b/i, "Lemon Tree"],
];

async function buildLodging(): Promise<void> {
  console.error("lodging…");
  const rows: LodgingRow[] = [];
  for (const e of await overpass(`nwr["tourism"~"^(hotel|guest_house|hostel|motel)$"]`)) {
    const t = e.tags ?? {};
    const p = coords(e);
    const name = t["name:en"] ?? t.name;
    if (!p || !name) continue;
    if (t.tourism === "hostel" && NOT_TRAVELLER_HOSTEL.test(name)) continue;
    const stars = Number.parseInt(t.stars ?? "", 10);
    rows.push({
      osm_id: osmId(e),
      name,
      type: t.tourism as LodgingRow["type"],
      stars: stars >= 1 && stars <= 5 ? stars : null,
      brand: t.brand ?? BRANDS.find(([re]) => re.test(name))?.[1] ?? null,
      has_phone: Boolean(t.phone ?? t["contact:phone"]),
      has_website: Boolean(t.website ?? t["contact:website"]),
      ...p,
    });
  }
  manifest.datasets.lodging = {
    rows: write("lodging.json.gz", rows),
    built_at: now,
    source: OSM_SOURCE,
    licence: ODBL,
  };
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, embedded commas/newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') ((field += '"'), i++);
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") (row.push(field), (field = ""));
    else if (c === "\n") (row.push(field), rows.push(row), (row = []), (field = ""));
    else if (c !== "\r") field += c;
  }
  if (field || row.length) (row.push(field), rows.push(row));
  return rows;
}

async function buildAirports(): Promise<void> {
  console.error("airports…");
  const res = await fetch("https://davidmegginson.github.io/ourairports-data/airports.csv", {
    headers: { "User-Agent": UA! },
  });
  if (!res.ok) throw new Error(`OurAirports HTTP ${res.status}`);
  const [header, ...data] = parseCsv(await res.text());
  const col = (name: string) => header!.indexOf(name);
  const [cType, cName, cLat, cLng, cCountry, cCity, cSched, cIcao, cIata] = [
    "type",
    "name",
    "latitude_deg",
    "longitude_deg",
    "iso_country",
    "municipality",
    "scheduled_service",
    "icao_code",
    "iata_code",
  ].map(col) as number[];
  const rows: AirportRow[] = [];
  for (const r of data) {
    if (r[cCountry!] !== "IN") continue;
    const type = r[cType!];
    const iata = r[cIata!]?.trim() || null;
    const scheduled = r[cSched!] === "yes";
    const keep =
      type === "large_airport" ||
      type === "medium_airport" ||
      (type === "small_airport" && iata && scheduled);
    if (!keep) continue;
    rows.push({
      iata,
      icao: r[cIcao!]?.trim() || null,
      name: r[cName!]!,
      city: r[cCity!] || null,
      type: type!.replace("_airport", "") as AirportRow["type"],
      scheduled,
      lat: round5(Number(r[cLat!])),
      lng: round5(Number(r[cLng!])),
    });
  }
  manifest.datasets.airports = {
    rows: write("airports.json.gz", rows),
    built_at: now,
    source: "OurAirports (ourairports.com)",
    licence: "Public domain",
  };
}

/**
 * rr.irctc.co.in still requires legacy TLS renegotiation, which Node's fetch refuses. Allow it for this
 * single manual request only (the rest of the script and the server keep the secure default).
 */
function legacyTlsGetJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(
      url,
      {
        headers: { "User-Agent": UA!, Accept: "application/json" },
        secureOptions: cryptoConstants.SSL_OP_LEGACY_SERVER_CONNECT,
        timeout: 30_000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`IRCTC HTTP ${res.statusCode}`));
          return;
        }
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(err as Error);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("IRCTC request timed out")));
    req.on("error", reject);
  });
}

async function buildRetiringRooms(stations: StationRow[]): Promise<void> {
  console.error("IRCTC retiring-room stations (manual refresh)…");
  const body = (await legacyTlsGetJson("https://www.rr.irctc.co.in/RetServcV2/rrservice/listOfStations")) as {
    data: { stationCode: string; stationName: string; managedBy: string }[];
  };
  const byCode = new Map(stations.map((s) => [s.code, s]));
  const rows: RetiringRoomRow[] = body.data.map((d) => {
    const code = d.stationCode.trim().toUpperCase();
    const st = byCode.get(code) ?? byCode.get(STATION_CODE_ALIASES[code] ?? "");
    return {
      station_code: code,
      station_name: d.stationName.trim(),
      managed_by: d.managedBy.trim(),
      lat: st?.lat ?? null,
      lng: st?.lng ?? null,
    };
  });
  const unmatched = rows.filter((r) => r.lat === null).map((r) => r.station_code);
  if (unmatched.length) console.error(`  no coordinates for: ${unmatched.join(", ")}`);
  manifest.datasets.retiring_rooms = {
    rows: write("retiring_rooms.json.gz", rows),
    built_at: now,
    source: "IRCTC retiring-room station list (rr.irctc.co.in), joined to OpenStreetMap stations",
    licence: "Station list: IRCTC public data; coordinates: ODbL — © OpenStreetMap contributors",
  };
}

const saveManifest = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

let stations: StationRow[] | null = null;
if (want("stations")) ((stations = await buildStations()), saveManifest());
if (want("bus_stations")) (await buildBusStations(), saveManifest());
if (want("lodging")) (await buildLodging(), saveManifest());
if (want("airports")) (await buildAirports(), saveManifest());
if (withIrctc) {
  stations ??= (await import("../src/data/datasets.js")).loadDataset<StationRow>("stations");
  await buildRetiringRooms(stations);
  saveManifest();
}
console.error("done.");
