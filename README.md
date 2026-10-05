# India Hotels MCP

[![CI](https://github.com/shubhamyadav8901/hotels-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/shubhamyadav8901/hotels-mcp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Data: ODbL](https://img.shields.io/badge/data-ODbL%201.0-green.svg)](data/LICENSE)

[Contributing](CONTRIBUTING.md) · [Disclaimer](DISCLAIMER.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

An MCP server for finding, comparing and planning hotel stays across India around the places a trip
actually revolves around: railway stations, airports, bus terminals, landmarks, localities and raw
coordinates. It merges live prices from free meta-search sources, and adds road distance and drive time
to arrival and departure points plus multi-stop stay planning.

It is standalone. Other servers (for example a train-timetable server) work with it through plain values
Claude passes between them: `lat`/`lng`, Indian Railways station codes, IATA airport codes and ISO-8601
datetimes.

## Tools

| Tool                  | What it does                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve_place`       | Name or code → coordinates (stations, airports, bus stations, landmarks, localities); or coordinates → nearest stations, airports and bus stations |
| `search_hotels`       | Hotels around a place for given dates, merged across sources, cheapest live price in INR for one room (`adults` 1–8); optional drive-time limit    |
| `get_hotel_rates`     | One hotel's current prices per booking site (Booking.com, Agoda, Trip.com, MakeMyTrip, …), cheapest first, in INR, with tax status and links       |
| `compare_hotels`      | Up to 10 hotels × up to 6 labelled places: drive or walk times, totals, ranking                                                                    |
| `travel_times`        | Origin × destination matrix of road km, free-flow and traffic-adjusted minutes                                                                     |
| `plan_stays`          | Per-stop stay planning from arrival/departure times: dates, candidates ranked by price + transfer time, leave-by times, warnings, retiring rooms   |
| `find_retiring_rooms` | IRCTC railway retiring rooms at or near a station, with booking rules and portal link                                                              |
| `get_data_sources`    | Status, limitations and quotas of every source; bundled dataset dates and licences                                                                 |

All tools are read-only; nothing books, pays or cancels.

## Data sources

| Need                       | Source                                                                                            | Notes                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Live prices                | [trivago official MCP](https://mcp.trivago.com/docs)                                              | Free, no key. Cheapest advertiser per hotel (Booking.com, Agoda, MakeMyTrip, …) in INR                |
| Live prices + availability | [HotelsCasa MCP](https://github.com/hotelscasa/hotelscasa-mcp)                                    | Free, no key, true radius search. EUR, converted to INR                                               |
| Live prices (unofficial)   | [SerpApi Google Hotels](https://serpapi.com/google-hotels-api) (scrapes Google; not a Google API) | **Off by default**; needs `SERPAPI_KEY` and `ENABLE_UNOFFICIAL_SOURCES=true`; 250 free searches/month |
| Live prices (unofficial)   | [Xotelo](https://xotelo.com) (derived from TripAdvisor meta-search)                               | **Off by default**; enabled only with `ENABLE_UNOFFICIAL_SOURCES=true`. Adds ~8 s per uncached search |
| FX                         | [Frankfurter](https://frankfurter.dev) (ECB rates)                                                | Daily reference rates                                                                                 |
| Hotel locations            | OpenStreetMap snapshot (bundled)                                                                  | ~24k hotels/guest houses/hostels; no prices (`include_unpriced`)                                      |
| Stations, bus stations     | OpenStreetMap snapshot (bundled)                                                                  | ~9.2k stations with codes, ~5.3k bus stations                                                         |
| Airports                   | [OurAirports](https://ourairports.com) (bundled)                                                  | 151 Indian airports                                                                                   |
| Retiring rooms             | IRCTC public station list (bundled, refreshed by hand)                                            | 356 stations; live availability needs a PNR on the IRCTC portal                                       |
| Geocoding                  | [Photon](https://photon.komoot.io), [Nominatim](https://nominatim.org)                            | Public instances, cached; Nominatim limited to 1 req/s                                                |
| Routing                    | [OSRM](https://project-osrm.org)                                                                  | FOSSGIS public instance by default, ~1 req/s, cached; self-hostable                                   |

Third-party prices are meta-search prices: they can differ at checkout and may exclude GST
(`includes_taxes: null` means unknown). Every price carries its `source`, `seller` and `fetched_at`.
OSM routing has no traffic data, so drive times are multiplied by `METRO_TRAFFIC_MULTIPLIER` (default 1.5)
in the 8 largest metros and `OTHER_TRAFFIC_MULTIPLIER` (1.2) elsewhere; both raw and adjusted minutes are returned.

None of the free live-price sources has an SLA. Any source can be switched off with `PROVIDERS_DISABLED`,
and a failing source never fails a search: results come back from the others with `sources_failed` filled in.
Unofficial sources (Xotelo, and SerpApi's Google Hotels scraper) run only when `ENABLE_UNOFFICIAL_SOURCES=true`; check the terms that apply
to you first (see [DISCLAIMER.md](DISCLAIMER.md)).

## Run locally with Docker (recommended)

```bash
git clone https://github.com/shubhamyadav8901/hotels-mcp.git && cd hotels-mcp
cp .env.example .env                # optional settings; see Configuration
docker compose up -d --build        # http://localhost:3001/mcp
curl -s localhost:3001/healthz      # {"status":"ok",...}
```

Or run the prebuilt image (amd64 and arm64, published for each release) without cloning:

```bash
docker run -d --name india-hotels-mcp --restart unless-stopped \
  -p 127.0.0.1:3001:3001 -e HTTP_USER_AGENT="india-hotels-mcp (+https://github.com/you)" \
  ghcr.io/shubhamyadav8901/hotels-mcp:latest
```

Add `--env-file .env` to pass optional settings. The bundled datasets (`data/*.json.gz`) are in the repository
and the image; rebuilding them is optional (see "Rebuilding the bundled data"). Run `docker compose up -d`
after changing `.env`. The server listens on port 3001 (so it can run next to other local MCP servers on
3000), bound to `127.0.0.1` only.

Connect Claude Code:

```bash
claude mcp add --transport http india-hotels http://localhost:3001/mcp
```

Claude Desktop and claude.ai connect to remote URLs only (Settings → Connectors); expose the server through a
tunnel and add its hostname to `ALLOWED_HOSTS`. The HTTP server has no authentication, so put your own access
control in front of any tunnel.

Inspect or test:

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3001/mcp --transport http --method tools/list
```

### Without Docker

Requires Node 22+.

```bash
npm ci
npm run build
npm start -- --http                 # HTTP on http://localhost:3001/mcp
```

Or let Claude Code start it over stdio:

```bash
claude mcp add --transport stdio --env HTTP_USER_AGENT="india-hotels-mcp (+https://github.com/you)" \
  india-hotels -- node /path/to/hotels-mcp/dist/src/server.js
```

### Self-hosted routing (optional)

The public OSRM instance is for light use. To self-host:

```sh
scripts/osrm-setup.sh northern-zone   # or "india": ~1.7 GB download, ~25 GB disk, 12+ GB Docker RAM
docker compose --profile osrm up -d
# then in .env: OSRM_URL=http://localhost:5001  OSRM_FOOT_URL=http://localhost:5002
```

## Configuration

See `.env.example`. Main settings: `HTTP_USER_AGENT`, `SERPAPI_KEY` (optional), `ENABLE_UNOFFICIAL_SOURCES`
(default `false`; `true` enables Xotelo), `PROVIDERS_DISABLED`, `OSRM_URL`, `OSRM_FOOT_URL`,
`NOMINATIM_URL`, `PHOTON_URL`, `METRO_TRAFFIC_MULTIPLIER`, `OTHER_TRAFFIC_MULTIPLIER`, `TRAIN_BUFFER_MIN`
(default 30), `FLIGHT_BUFFER_MIN` (default 120), `PROVIDER_DEADLINE_MS` (default 20000; each source's time
limit per search).

HTTP mode only: `PORT` (default 3001), `HOST` (bind address, default `127.0.0.1`; `0.0.0.0` in the Docker
image) and `ALLOWED_HOSTS` (comma-separated extra hostnames accepted in the `Host` header, any port;
`localhost`, `127.0.0.1` and `[::1]` are always accepted). Under docker compose, `PORT` and `HOST` are fixed by
`docker-compose.yml`.

Searches are for one room; `adults` is the number of guests in that room (1–8).

## Development

```sh
npm run typecheck && npm test && npm run format:check   # gate before committing
npm run smoke                                          # live acceptance checks (network, a few minutes)
npm run dev                                            # watch mode, stdio
```

Unit tests use synthetic fixtures only and never touch the network.

### Rebuilding the bundled data

Run about once a month:

```sh
HTTP_USER_AGENT="india-hotels-mcp/0.1 (you@example.com)" npm run build:data
# add -- --with-irctc to refresh the IRCTC retiring-room list (a single manual request;
# IRCTC's terms forbid automated access, so never schedule it)
# the Xotelo location-key table is rebuilt separately with: npx tsx scripts/build-xotelo-keys.ts
```

## Limitations

- Coverage of live prices is strong in metros and tourist towns and thin in small towns; use
  `include_unpriced` to see OpenStreetMap-only listings there.
- Indian OTAs (MakeMyTrip, Goibibo) appear only when trivago lists them as the cheapest advertiser.
- No public-transport routing; no live traffic.
- IRCTC retiring-room availability and exact prices are not available without a PNR.
- The SerpApi monthly quota counter is kept in memory and resets when the server restarts, and SerpApi's
  50 searches/hour limit is not enforced locally.

## Contributing

Bug reports, data corrections and new sources are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the
ground rules and checks, and the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as
described in [SECURITY.md](SECURITY.md).

## Disclaimer

This is an independent project, not affiliated with trivago, HotelsCasa, TripAdvisor, Xotelo, Booking.com,
Agoda, MakeMyTrip, IRCTC, Indian Railways, Google, SerpApi, OpenStreetMap or any other source. Prices are
meta-search prices that may exclude GST; check with the seller before booking. Nothing is booked. See
[DISCLAIMER.md](DISCLAIMER.md).

## Licences

Code: Apache-2.0 (`LICENSE`). Bundled OpenStreetMap-derived data: ODbL 1.0, © OpenStreetMap contributors
(`data/LICENSE`, `data/NOTICE`). Tool responses that use OSM data carry the attribution. Other bundled and
run-time data sources are listed in [NOTICE](NOTICE).
