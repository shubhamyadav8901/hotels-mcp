# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-05

The first public release.

### Added

- **Server:** an MCP server over stdio or stateless Streamable HTTP (`/mcp`, health at `/healthz`) with 8 read-only tools:
  - `resolve_place`: names or codes (stations, airports, bus stations, landmarks, localities) to coordinates, and coordinates to the nearest stations, airports and bus stations
  - `search_hotels`: hotels around a place for given dates, merged across sources, for one room (1–8 adults), with the cheapest live price in INR and an optional drive-time limit
  - `get_hotel_rates`: one hotel's current prices per booking site, cheapest first, in INR, with tax status and links
  - `compare_hotels`: up to 10 hotels against up to 6 labelled places, with drive or walk times, totals and a ranking
  - `travel_times`: an origin × destination matrix of road distance, free-flow and traffic-adjusted minutes
  - `plan_stays`: per-stop stay planning from arrival and departure times, with dates, candidates ranked by price and transfer time, leave-by times, warnings and retiring rooms
  - `find_retiring_rooms`: IRCTC railway retiring rooms at or near a station, with booking rules and the portal link
  - `get_data_sources`: status, limitations and quotas of every source, and bundled dataset dates and licences
- **HTTP hardening:** HTTP mode binds `127.0.0.1` by default (`HOST`) and rejects unexpected `Host` headers (`ALLOWED_HOSTS`, DNS-rebinding protection). Each source has a per-search time limit (`PROVIDER_DEADLINE_MS`, default 20 s).
- **Live prices:** trivago's official MCP server and HotelsCasa's MCP endpoint (both free, no key), called only through an allow-list of read-only tools. HotelsCasa's EUR prices are converted to INR with ECB reference rates from Frankfurter. Optional Google Hotels via SerpApi (`SERPAPI_KEY`).
- **Unofficial source (opt-in):** Xotelo, off by default and enabled only with `ENABLE_UNOFFICIAL_SOURCES=true`, with a bundled table of 1,387 TripAdvisor location keys (`scripts/build-xotelo-keys.ts`).
- **Deployment:** Docker-first, like other local MCP servers: `docker compose up -d` serves `http://localhost:3001/mcp` on loopback only (port 3001, so it can sit next to servers on 3000), `/healthz` reports datasets and sources, and a release workflow publishes amd64/arm64 images to `ghcr.io/shubhamyadav8901/hotels-mcp`.
- **Provenance and failure handling:** every price carries `source`, `seller` and `fetched_at`; unknown values (such as whether taxes are included) are `null`. A failing source never fails a search: results come from the others with `sources_failed` filled in. Any source can be turned off with `PROVIDERS_DISABLED`.
- **Geocoding and routing:** Photon and Nominatim (public instances, cached, Nominatim at 1 req/s) and OSRM (FOSSGIS public instance or self-hosted, with `scripts/osrm-setup.sh` and a docker compose profile). Drive times are multiplied by configurable traffic factors for metros and other areas; raw and adjusted minutes are both returned.
- **Bundled data:** OpenStreetMap snapshots of ~9.2k railway stations with codes, ~5.3k bus stations and ~24k lodging places (ODbL), 151 Indian airports from OurAirports (public domain), and IRCTC's public retiring-room station list (356 stations). Rebuilt with `npm run build:data`; the IRCTC list only with the manual `--with-irctc` flag.
- **Packaging and checks:** Dockerfile and docker compose for local use, unit and MCP protocol tests on synthetic fixtures, and a live acceptance smoke test (`npm run smoke`).

[Unreleased]: https://github.com/shubhamyadav8901/hotels-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/shubhamyadav8901/hotels-mcp/releases/tag/v0.1.0
