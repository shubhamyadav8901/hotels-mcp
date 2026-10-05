# Spike S3: building the data/ snapshots

Run on 2026-10-05 (OSM data as of 2026-10-04T22:29Z) from a macOS laptop with Node 22.
Nothing larger than the 12.7 MB OurAirports CSV was downloaded.
Scratch outputs were not kept in the repo. The samples are in `research/spikes/samples/`.

## TL;DR

- **Overpass works, and a single query for all of India per category is enough.** Each category finishes in 30–45 s on overpass-api.de.
  The 3 OSM categories together take about 2.5 min with polite gaps between queries.
  This replaces the per-state batching in PLAN §2. Per-state batching is kept only as a fallback, and it has been checked:
  the 36 per-state lodging queries took 8 min and returned exactly the same 30,602 elements as the single national query.
- **Station codes are in `ref`.** Mainline coverage is 97.0% of `railway=station` and 97.8% of `railway=halt`.
  `railway:ref` adds only about 0.3 pp, and `ref:IR` does not exist (0 uses).
- **The snapshots are small.** All 5 together come to about 0.95 MB gzipped. Lodging is the largest at about 650 KB.
- **Geofabrik + osmium is not needed.** If it ever is, the zone extracts are 104–532 MB each and full India is 1.6 GB.
- **ODbL applies to the three OSM files.** Committing them means publicly distributing a Derivative Database.
  Ship `data/` under ODbL with attribution. The code can stay under its own licence.

## Endpoints and politeness

| Endpoint | Result (2026-10-05) |
|---|---|
| `https://overpass-api.de/api/interpreter` | Works. Status shows `Rate limit: 2` slots per IP. **Returns 406 if no `User-Agent` is sent.** It sometimes returns HTTP 504 with `Dispatcher_Client::request_read_and_idx::timeout` (busy) or 429 `rate_limited`, which a retry after 15 s fixes. |
| `https://maps.mail.ru/osm/tools/overpass/api/interpreter` | Works. Slower: the Delhi bus query took 25 s, against 1.5 s on the main instance. Its data was fresh (osm_base 22:36Z). Use it as the fallback mirror. |
| `overpass.kumi.systems`, `overpass.private.coffee` | Timed out after 90 s / no response. |
| `overpass.osm.jp` | Connection failed. |

**Build rules:**
- Send a real UA.
- Run one query at a time, with a sleep of at least 5 s between queries.
- On 429/504, retry with backoff (15 s × attempt, up to 5 attempts). Fall back to the mail.ru mirror after that.
- Validate that the body starts with `{` and that `remark` is absent. Overpass returns runtime errors as HTML or a `remark` even with HTTP 200 in some cases.

The build is about 3 requests per run, far under the Overpass usage policy (about 10k queries or 1 GB per day).

## Working Overpass QL

Use these queries with the national area. For the per-state fallback, swap the area for `area["ISO3166-2"="IN-XX"]`.

```overpassql
/* stations */
[out:json][timeout:600][maxsize:536870912];
area["ISO3166-1"="IN"][admin_level=2]->.a;
nwr["railway"~"^(station|halt)$"](area.a);
out center tags;

/* bus stations */
[out:json][timeout:600][maxsize:536870912];
area["ISO3166-1"="IN"][admin_level=2]->.a;
nwr["amenity"="bus_station"](area.a);
out center tags;

/* lodging */
[out:json][timeout:600][maxsize:536870912];
area["ISO3166-1"="IN"][admin_level=2]->.a;
nwr["tourism"~"^(hotel|guest_house|hostel|motel|apartment)$"](area.a);
out center tags;
```

`out center tags;` gives `lat`/`lon` for nodes and `center.lat`/`center.lon` for ways and relations, so no geometry is downloaded.

**State ISO codes as tagged in OSM (36).** Several differ from older ISO lists:
IN-CG (not CT), IN-OD (not OR), IN-TS (not TG), IN-UK (not UT), and IN-DH (DN and DD merged).
Using the old codes silently returns 0 elements. The list can be regenerated with this query:

```overpassql
[out:csv("ISO3166-2",name;true;"|")][timeout:120];
area["ISO3166-1"="IN"][admin_level=2]->.a;
rel(area.a)["boundary"="administrative"]["admin_level"="4"]["ISO3166-2"~"^IN-"];
out tags;
```

The codes are: AN AP AR AS BR CG CH DH DL GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD PB PY RJ SK TN TR TS UK UP WB.

## Timings (overpass-api.de, sequential)

| Query | Elements | Raw JSON | Time |
|---|---|---|---|
| IN-DL lodging | 836 | 206 KB | 2.6 s |
| IN-UP lodging | 1,095 | 250 KB | 7.8 s |
| IN-DL bus | 64 | 16 KB | 1.5 s |
| IN-DL stations | — | 180 KB | 7.9 s (after one 504 busy) |
| **India stations** | 10,653 | 3.8 MB | 44 s (+ one 429 retry) |
| **India bus** | 6,189 | 1.5 MB | 30 s |
| **India lodging** | 30,602 | 6.8 MB | 45 s |
| 36 states lodging, 3 s gaps | 30,602 total | — | 8 min 04 s; 5 states needed a 2nd attempt; largest state was KL with 7,128 elements |

Per-state queries took 2–12 s each. Small-state cost is dominated by area lookup and queueing, so per-state batching is slower overall and adds about 108 requests per build.
Keep it only as the fallback for when the national query times out.

## Counts, field coverage and gzipped sizes

Sizes were measured with `JSON.stringify` of compact rows (coordinates rounded to 5 decimals) and gzip level 9.

### Stations

The raw query returns 10,653 elements: 9,027 station nodes, 1,242 halt nodes, 380 ways and 4 relations.
- 1,100 of these are metro stations (`station=subway`). Another 23 are monorail or light rail.
  **These must be excluded or flagged.** Metro `ref`s such as `PTN`, `RI` and `KG` collide with Indian Railways codes.
- That leaves 9,530 mainline stations; 9,279 of them (97.4%) have a code.
  99.8% of codes match `^[A-Z]{1,5}$`. A few are junk, such as `1`, `2`, `3;4`, `A01` and `BYC2`.
  Validate codes against `^[A-Z]{2,5}$`.
- The data has 9,208 distinct codes. 65 codes are duplicated, mostly where both a node and a way are mapped (for example SDAH, HJL, BBK).
  Dedupe by code, preferring the node.
- Known OSM-vs-IR code drift: Banaras is tagged `BSBS` in OSM, but IR and IRCTC use `BNRS`. Mumbai Central is `MMCT`, and there is no `BCT`.
  Keep a small alias table (`BNRS→BSBS`, `BCT→MMCT`).
- **Snapshot:** 9,474 named mainline rows (`{code,name,kind,lat,lng}`), 757 KB JSON, **185 KB gz**.

| Tag | Uses (all 10,653) | Mainline station (8,281) | Halt (1,249) |
|---|---|---|---|
| `ref` | 9,670 | **97.0%** | **97.8%** |
| `ref` or `railway:ref` | — | 97.3% | 98.0% |
| `railway:ref` | 110 | — | — |
| `ref:IR` | **0** | — | — |
| `code` | 84 | — | — |

Use `ref`, with `railway:ref` as the fallback. Include halts: they are about 12% of rows and cost little.

### Bus stations

- 6,189 elements: 3,830 nodes, 2,342 ways and 17 relations. 84.0% are named.
- **Snapshot:** all rows give **99 KB gz**; named-only rows (5,306) give **90 KB gz**. Keep named rows only.
- The Delhi sample includes ISBT Kashmere Gate, ISBT Sarai Kale Khan and Anand Vihar.

### Lodging

- 30,602 elements: hotel 16,211, hostel 6,106, guest_house 5,709, apartment 1,891 and motel 685. By element type: 21,540 nodes, 8,812 ways and 250 relations.
- **Field coverage:**

  | Field | Coverage |
  |---|---|
  | name | 86.2% |
  | stars | 1.3% |
  | phone / contact:phone | 9.6% |
  | website / contact:website | 7.0% |
  | brand | 2.9% |
  | brand:wikidata | 1.5% |
  | addr:city | 11.2% |
  | rooms | 3.2% |

- **Brands** are sparse. The most common `brand` is OYO, on only 76 elements. "OYO" appears in 168 names, so brand detection should also match on the name.
  Other common brands are Residence Inn (43), Taj (41), Courtyard (30), Radisson Blu (21), Ibis (17) and Novotel (16).
- **Hostel noise:** 2,490 of the 6,106 hostels (41%) have student or college names, such as "Boys Hostel", "Hostel No. 5", "SREC Ladies Hostel" or "MNNIT Hostel Area".
  Recommendation: exclude hostels whose names match `/\b(boys|girls|ladies|gents|students?|college|university|iit|nit|aiims|medical|hostel no\.?|block|hall)\b/i`, and drop unnamed hostels.
  This is cheap and removes most false positives.
- **Apartments:** `tourism=apartment` adds about 1,300 named rows (34 KB gz). Include it, with `type` kept so the ranking can down-weight it.
- **Snapshot:** 26,391 named rows (`{id,name,type,stars,brand,phone:bool,website:bool,lat,lng}`), 3.9 MB JSON, **649 KB gz**.
  Without apartments: 25,081 rows, 615 KB gz. After the hostel filter (measured): 24,403 rows, 601 KB gz.
  If the tools need phone and website values for deep links, store the values instead of booleans; that adds roughly 100 KB gz.

### Airports (OurAirports)

- Source: `https://davidmegginson.github.io/ourairports-data/airports.csv` (12.7 MB, public domain). There are 651 IN rows:

  | Type | Rows |
  |---|---|
  | heliport | 300 |
  | small | 178 |
  | medium | 98 |
  | large | 43 |
  | closed | 31 |
  | seaplane | 1 |

- Recommended filter: `large`, plus `medium`, plus `small` with `iata_code` and `scheduled_service=yes`.
  That gives **151 rows, 21 KB JSON, 5 KB gz**.
  The small-with-IATA filter adds 10 UDAN-type fields such as Hindon (HDO). Small airports with IATA but no scheduled service (34 in total) are mostly unused strips, so skip them.
- 11 medium airports have no IATA code (for example Safdarjung VIDD). Keep them with `iata:null` or drop them; they are not useful as anchors.

### Retiring rooms (IRCTC)

- `GET https://www.rr.irctc.co.in/RetServcV2/rrservice/listOfStations` returns HTTP 200 (`application/json`, 53.9 KB) with no auth and no special headers. Plain curl works.
- Shape: `{status:"SUCCESS", message:"Station List Available", data:[{stationCode, stationName, email, contact, managedBy}]}`.
  `email` is obfuscated with `[at]` and `[dot]`. `managedBy` is one of `IRCTC` (68), `Railway` (287) or `Railway/IRCTC` (1). There are **356 rows**.
- **Join to OSM `ref`:** 354 of 356 rows match (99.4%). The misses are KPD (Katpadi Jn, absent from OSM by name or code) and BNRS (OSM `BSBS`). The alias table fixes BNRS.
  KPD needs a manual coordinate, or it ships with `lat:null`.
- Snapshot size is about 15 KB gz. Ship code, name, managedBy and lat/lng. Contact and email are public, but leave them out unless a tool shows them.
- Fetch the list **once by hand per refresh**. Do not poll it: IRCTC's ToS bans automated access.

### Totals

| Snapshot | Rows | gz |
|---|---|---|
| stations.json.gz | ~9.5k | ~185 KB |
| bus_stations.json.gz | ~5.3k | ~90 KB |
| lodging.json.gz | ~24.4k (filtered) | ~600 KB |
| airports.json.gz | 151 | ~5 KB |
| retiring_rooms.json | 356 | ~15 KB (or ~50 KB plain) |
| **Total** | | **≈ 0.9 MB** |

PLAN's estimates hold: stations 9.4k ✓, bus 6.2k ✓, lodging about 29k (actual 30.6k raw, about 26k named).

## Geofabrik alternative (sizes only; nothing downloaded)

Geofabrik `asia/india/*-latest.osm.pbf` (data as of 2026-10-03):

| Extract | Size |
|---|---|
| india (full) | 1.71 GB (1,709,133,866 B) |
| southern-zone | 558 MB |
| central-zone | 352 MB |
| eastern-zone | 247 MB |
| northern-zone | 224 MB |
| western-zone | 221 MB |
| north-eastern-zone | 110 MB |

A fallback would download one zone at a time and run `osmium tags-filter` in a Docker osmium container (no brew install), deleting each file after use.
The peak disk use would be about 0.6 GB. It is viable but not needed: Overpass did the whole country in under 3 minutes.
Note that the zones overlap at their borders, so this route needs dedupe by OSM id.

## ODbL attribution requirements for committed gzipped JSON

The OSM-derived files are stations, bus_stations, lodging, and the coordinates in retiring_rooms.
1. **Committing them to a public repo means publicly using a Derivative Database.** Under ODbL §4.4, that database must be offered under ODbL (or a compatible licence).
   Share-alike applies to the data files only. The TypeScript code can stay MIT or Apache.
   Put `data/LICENSE` (the ODbL 1.0 text, or a link to it) and `data/NOTICE` in the repo. The notice should say:
   "Contains information from OpenStreetMap, © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0 — https://www.openstreetmap.org/copyright".
2. **Keep the build reproducible.** `scripts/build-data.ts` plus the queries above satisfy the requirement to offer the derivative database or a means to recreate it (§4.6). Record the `osm_base` timestamp in each snapshot's header.
3. **Tool outputs are Produced Works**, so they need attribution.
   - `get_data_sources` should carry the OSM attribution line.
   - Any hotel or anchor record with an OSM source should include `source: "OpenStreetMap contributors (ODbL)"`.
4. **OurAirports** is public domain. Credit it anyway in NOTICE.
5. **IRCTC `listOfStations`** has no licence and consists of facts (codes, names, operator). Record it as "from IRCTC rr.irctc.co.in, fetched YYYY-MM-DD", and do not automate the refresh.

## Recommended build approach (`scripts/build-data.ts`)

1. **OSM categories.** Run the 3 national Overpass queries above, sequentially, with:
   - a UA header;
   - 5–10 s gaps between queries;
   - retry with backoff on 429/504 or an HTML body;
   - a mirror fallback.
2. **Per-state fallback.** If a national query fails 3 times, switch to the 36 OSM ISO codes with 3–5 s gaps (verified to give identical results). Don't hard-code an old ISO list; regenerate it with the CSV query above.
3. **Normalise and filter.**
   - Coordinates: use the center for ways and relations; round to 5 decimals.
   - Stations: drop metro, monorail and light rail; validate codes against `^[A-Z]{2,5}$`; dedupe by code, preferring the node; apply the alias table.
   - Lodging: drop unnamed rows; apply the student-hostel filter; set brand from `brand` or from a name regex (OYO, Treebo, FabHotel, Zostel, ...).
4. **Airports.** Download the OurAirports CSV and apply the filter above.
5. **Retiring rooms.** Fetch the IRCTC list once per manual refresh (`npm run build:data -- --with-irctc`) and join on station code. (As built, only the joined `data/retiring_rooms.json.gz` is committed; no raw copy.)
6. **Write output.** Write gz files with a header `{source, license, osm_base, built_at, count}`. Add `data/LICENSE` and `data/NOTICE`.

The expected wall time is under 5 minutes, with about 3 Overpass requests per build.

## Samples (real, Delhi)

The files are in `research/spikes/samples/`:
- `stations.json`: 20 rows, including NDLS, DLI, NZM, ANVT, DEE, DSA and DEC.
- `lodging.json`: 20 rows, with a mix of brands (OYO), guest houses and hostels.
- `bus_stations.json`: 20 rows.
- `airports.json`: 3 rows from the NCR bbox: DEL, HDO and VIDD.
- `retiring_rooms.json`: 6 rows. These are 4 Delhi stations, plus KPD and BNRS to show the 2 join misses. The file also records the raw response shape.
