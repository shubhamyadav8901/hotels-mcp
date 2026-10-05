# hotels-mcp: Build Plan

Research behind this plan: `research/00-summary.md` (and 01–04).

## 1. Brief

**Goal.** An MCP server that lets Claude find, compare and plan hotel stays across India around places that
matter to a trip: railway stations, airports, bus terminals, landmarks, localities and raw lat/lng. It shows live
prices and the distance and travel time to arrival and departure points.

**Constraints**

- Personal/team use. Runs locally over stdio; Docker over Streamable HTTP is optional.
- Free tiers only. Live prices are required.
- Standalone. No coupling to any other MCP server. Claude passes data between servers, so hotels-mcp only
  exchanges generic values:
  - `lat`/`lng` (WGS84)
  - Indian Railways station codes and IATA airport codes, as plain strings
  - ISO-8601 local datetimes (`+05:30`)
- Read-only. Never expose booking, payment or cancel tools, even when an upstream offers them.
- Never fabricate data. Every price, distance and time carries its source and `fetched_at`. An unknown value is
  `null` with a reason, never a guess.
- Tool descriptions describe what the tool does. They never tell Claude what to do and never name other servers.

**Non-goals (v1):** booking, user accounts, public transit routing, live IRCTC retiring-room availability,
Airbnb scraping, and a hosted public deployment.

## 2. Architecture

```
src/
  server.ts            stdio entry (+ --http for Streamable HTTP via express)
  mcp.ts               McpServer, tool registration
  config.ts            env parsing (zod)
  tools/               one file per tool: zod in/out schemas + handler; thin
  core/
    anchors.ts         resolve station/airport/bus/landmark/lat-lng → Anchor
    merge.ts           cross-source hotel dedupe (name similarity + ≤150 m) → HotelRecord
    pricing.ts         FX → INR, GST note, min/median per hotel
    proximity.ts       distance/time scoring against labelled points
    itinerary.ts       legs → nightly stay windows → per-stay candidates
    geo.ts             haversine, bbox, grid index
  providers/
    types.ts           HotelProvider / GeoProvider interfaces, ProviderResult<T> with provenance
    registry.ts        enable/disable via env, health status, graceful degradation
    trivago.ts         MCP *client* → mcp.trivago.com/mcp (radius-search); strips photos + system_message
    hotelscasa.ts      MCP *client* → mcp.hotelscasa.com/mcp (lat/lng/radius_km, availability); EUR
    xotelo.ts          HTTP → data.xotelo.com (/list, /rates per OTA); needs TripAdvisor location_key
    serpapi.ts         optional, needs SERPAPI_KEY; Google Hotels gl=in; 24 h cache; quota counter
    osm-lodging.ts     local snapshot of OSM hotels/guest houses/hostels (no prices; fills coverage)
    photon.ts, nominatim.ts   geocoding (Nominatim at 1 req/s, real User-Agent)
    osrm.ts            route + table (FOSSGIS public + cache by default; OSRM_URL for self-hosted)
    fx.ts              EUR/USD→INR via Frankfurter (ECB), cached 24 h
  lib/http.ts, lib/cache.ts   fetch with timeout/retry/UA; TTL LRU (+ optional file cache)
data/                  built snapshots (gzipped JSON, committed)
  stations.json.gz     OSM railway=station (~9.4k, name, ref code, lat/lng)
  airports.json.gz     OurAirports IN (IATA, name, lat/lng)
  bus_stations.json.gz OSM amenity=bus_station (~6.2k)
  lodging.json.gz      OSM tourism=hotel|guest_house|hostel|motel (~29k)
  retiring_rooms.json  IRCTC listOfStations (356) joined to station coords
  xotelo_cities.json   city → TripAdvisor location_key (see Spike S1)
scripts/
  build-data.ts        Overpass, batched per state with polite delays; OurAirports CSV; IRCTC list
  smoke.ts             live end-to-end against real upstreams (manual, not CI)
test/                  vitest; synthetic fixtures only, no network
```

The stack is TypeScript, `@modelcontextprotocol/sdk` ^1.32, zod, express (HTTP mode only), vitest, and prettier.
The spatial index is an in-memory grid over about 45k points; it needs no native dependencies.

**Upstream MCP servers used as clients.** trivago and HotelsCasa are reached with the SDK `Client` over
`StreamableHTTPClientTransport`. Only an allow-list of read-only tool names is called. Responses are parsed
into our own types, and no upstream text reaches Claude unless it sits in a labelled data field.

## 3. Tools (8)

All tools set `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: true` and a `title`.
Every tool has an `outputSchema`, plus a JSON text fallback, `isError` with a next-step hint, and pagination
("showing 10 of N").

| Tool                  | Input (key params)                                                                                                                                                                                 | Output                                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve_place`       | `query` or `lat`/`lng`; optional `kind` (station/airport/bus/landmark/locality)                                                                                                                    | Ranked anchors: kind, name, code, lat/lng, source                                                                                                                                         |
| `search_hotels`       | anchor = `lat`/`lng` \| `station_code` \| `iata` \| `query`; `check_in`, `check_out`, `adults`, `radius_km` (≤25), `max_drive_minutes?`, `max_price_inr?`, `sort` (distance/price/rating), `limit` | Merged hotels: `hotel_id`, name, lat/lng, straight-line km, drive min (if asked), min price INR + source, rating, which sources matched                                                   |
| `get_hotel_rates`     | `hotel_id`, dates, adults                                                                                                                                                                          | Per-source and per-OTA prices in INR (original currency kept), availability flag, deep links, GST note, `fetched_at`                                                                      |
| `travel_times`        | `origins[]`, `destinations[]` (lat/lng or codes), `mode` (drive/walk)                                                                                                                              | Matrix: km, minutes; drive minutes also shown with a traffic multiplier                                                                                                                   |
| `compare_hotels`      | `hotel_ids[]` (≤10), `points[]` with labels (e.g. `{label:"arrive", station_code:"NDLS"}`, `{label:"depart", iata:"DEL"}`)                                                                         | Per hotel: price, time and distance to each point, total transfer minutes, rank                                                                                                           |
| `plan_stays`          | `legs[]`: `{arrive_at, arrive_point, depart_at, depart_point}`, budget, preferences                                                                                                                | Per night: stay window, recommended area, top 3–5 hotels (balancing transfer time and price), warnings (late check-in, early departure buffer, a stay under 6 h suggests a retiring room) |
| `find_retiring_rooms` | `station_code` or `lat`/`lng` + radius                                                                                                                                                             | IRCTC retiring-room stations, operator, indicative tariff band, booking deep link; states that live availability needs a PNR on IRCTC                                                     |
| `get_data_sources`    | none                                                                                                                                                                                               | Provider status (enabled, last success, quota left), snapshot dates, known limitations                                                                                                    |

Interop with other servers comes from inputs and outputs only. Any tool takes a station code, IATA code or
lat/lng that Claude got anywhere, and every hotel output includes lat/lng.

## 4. Key logic

- **Dedupe:** a hotel appears once when normalised names have token-set similarity ≥ 0.8 and the points are ≤ 150 m
  apart, or ≤ 40 m with any name. Each source's price is kept on the merged record. Tests cover
  near-duplicates such as "Hotel X by OYO" vs "OYO 1234 Hotel X".
- **Price normalisation:** EUR/USD→INR at the day's ECB rate, with the rate shown. Prices are flagged
  "likely excl. GST" where the source is pre-tax.
- **Travel time:** OSRM drive minutes × a metro multiplier (env, default 1.5 for the 8 largest metros, 1.2
  elsewhere). Both raw and adjusted minutes are reported.
- **Itinerary:** each leg gives a stay window [arrival, departure]. The candidate area is the arrival point,
  the departure point, or between them. Score = w1·(arrival transfer + departure transfer) + w2·price, with
  buffers: train 30 min, flight 120 min (env). Overnight windows under 6 h suggest a retiring room or an
  airport hotel.
- **Degradation:** each provider has a per-search deadline (`PROVIDER_DEADLINE_MS`, default 20 s; trivago
  alone takes 7–10 s, per spike S2). Partial results still return, with `sources_failed[]`. When every
  live-price source fails, OSM lodging returns with `price: null`.
- **One room per search:** sources disagree on how multi-room prices are quoted, so every source is asked for
  one room and `adults` means guests in that room.

## 5. Spikes (before the build; 1–2 h total)

- **S1 Xotelo city keys.** Find a ToS-acceptable way to map a city or lat/lng to a TripAdvisor `location_key`.
  Option A: a curated table of about 300 Indian cities and tourist towns, with keys looked up once by hand or
  by script. Option B: match the hotels Xotelo `/list` returns per key against OSM lodging. If neither works,
  Xotelo is only used through `get_hotel_rates` after a name match.
- **S2 trivago/HotelsCasa tool schemas.** Run `tools/list` on both and record exact input schemas and payload
  shapes as synthetic fixtures. Measure response size after stripping.
- **S3 Overpass build.** Confirm a per-state batched extract finishes within public-instance limits. The
  fallback is Geofabrik pbf + osmium, which needs a local install.

## 6. Milestones

1. **M0 Scaffold:** package.json, tsconfig, server with stdio + `--http`, config, `get_data_sources`, MCP
   test that asserts the tool list and annotations.
2. **M1 Data:** `build-data.ts` and snapshots; `resolve_place` (local tables first, then Photon, then Nominatim).
3. **M2 Hotels:** trivago + HotelsCasa + OSM providers, merge/dedupe, FX; `search_hotels`, `get_hotel_rates`.
4. **M3 Geo:** OSRM provider; `travel_times`, `compare_hotels`, `max_drive_minutes` in search.
5. **M4 Prices+:** Xotelo (per S1) and SerpApi (optional key, quota guard).
6. **M5 Planning:** `plan_stays`, `find_retiring_rooms`.
7. **M6 Ship:** docker-compose `osrm` service + `scripts/osrm-setup.sh` (download India or a region pbf, MLD preprocess; needs ~25 GB disk and ~12 GB Docker RAM for all of India), README (setup, env, limitations, data licences, ODbL attribution), Dockerfile, smoke script, a
   fresh-context review.

## 7. Testing

- **Unit tests (vitest, no network):** each provider normaliser against synthetic fixtures, dedupe matcher,
  FX, haversine/grid index, metro multiplier, itinerary scoring and buffers, degradation (provider throws or
  times out).
- **MCP integration:** in-memory client↔server. Checks tool list, annotations, schemas, `structuredContent`
  validating against `outputSchema`, error shape, and that the size cap holds (< 20k tokens for `limit=25`).
- **Live smoke (`npm run smoke`, manual):** the acceptance scenarios below against real upstreams.
- **Gate before any commit:** `npm run typecheck && npm test && npm run format:check`.

## 8. Acceptance criteria (live smoke)

1. "Hotels within 2 km of NDLS for 10–11 Nov 2026, 2 adults": at least 10 results with lat/lng, at least 5 with
   INR prices, prices from at least 2 sources, every price carrying its source.
2. "Hotels within 30 min drive of DEL airport": every result has drive minutes ≤ 30 (adjusted).
3. `compare_hotels` for 3 hotels against an arrival point (station code) and a departure point (IATA) returns a
   full time/distance matrix.
4. `plan_stays` for a 3-city trip (Delhi → Agra → Jaipur, train times supplied as ISO datetimes) returns one
   stay per night with transfer times and at least 3 candidates each, and warns on an arrival after 22:00.
5. `find_retiring_rooms` for NDLS returns the IRCTC entry and a deep link without calling any live IRCTC endpoint.
6. With trivago blocked (env toggle), search still returns results and lists the failed source.
7. No tool response exceeds 25k tokens; no upstream `system_message` or image data appears in output.

## 9. Config (env)

`SERPAPI_KEY` (optional), `OSRM_URL`, `NOMINATIM_URL`, `PHOTON_URL`, `HTTP_USER_AGENT` (required for
Nominatim), `PROVIDERS_DISABLED` (comma list), `METRO_TRAFFIC_MULTIPLIER`, `OTHER_TRAFFIC_MULTIPLIER`,
`TRAIN_BUFFER_MIN`, `FLIGHT_BUFFER_MIN`, `CACHE_DIR` (optional file cache). Secrets live only in `.env`.

## 10. Risks

- Free live-price upstreams have no SLA, and Xotelo's ToS is a grey area. The provider registry and
  degradation tests cover this, and each upstream can be disabled with one env var.
- trivago could add auth or change its schema. A schema-parse failure is reported as a provider error,
  never as an empty result.
- OSM lodging is thin in tier-2 towns. `get_data_sources` and the per-search `coverage` note report this.
