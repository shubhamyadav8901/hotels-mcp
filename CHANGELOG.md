# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

Planned as 0.2.0.

### Added

- **Families in one room.** `search_hotels`, `get_hotel_rates` and `plan_stays` take `children_ages` (up to 4 children, ages 0–17) besides `adults`, at most 8 guests. Every source is asked for one room for that party, so results are rooms that fit everyone. Xotelo returns no prices when children are sent, so it counts them as adults (its prices err high, never low); the response says so.
- **Guest-rating floor:** `min_rating_pct` on `search_hotels` and `plan_stays` (e.g. 60 = 6.0/10), with a server default from `DEFAULT_MIN_RATING_PCT` (0 = off) that the agent can override per request. It applies to the merged guest rating after all sources answer (not at source, where a source would judge by its own rating and could drop its price for a hotel that passes); unrated hotels are left out while it is on, and counted in the notes.
- **One-room confidence for every price.** Prices carry `occupancy` (`confirmed`, `likely` or `unverified`, with a note), and hotels carry `cheapest_single_room` when their cheapest price is unverified. Live checks found trivago and Xotelo sometimes price 3+ guests as two rooms under a one-room request, so those are `unverified` for larger parties. `get_hotel_rates` with `check_single_room: true` re-prices them for 2 adults and gives each a verdict (`plausible_single_room`, `looks_like_2_rooms`, `implausible`, `unknown`). `plan_stays` candidates and `compare_hotels` show the same labels.
- **Room names:** prices carry the room as the source names it (`room`, from HotelsCasa), since no source can filter by bed type and "fits four adults" can mean a family room or a double with extra beds.
- **Cheapest first at the source.** With `sort=price` (or `rating`), Google Hotels and HotelsCasa are asked for their cheapest (or best-rated) results, and minimum stars (and, for Google, the price cap) are applied server-side, so their single page of results is the right page. trivago gets the star filter.

### Changed

- **"Hotels in X" searches the town.** A place query that names a town or city exactly (e.g. `Jaipur`) resolves to the town rather than to its main station, and Google Hotels is asked for "hotels in Jaipur, Rajasthan".
- **Faster Xotelo.** Its area lists are fetched concurrently (still rate-limited), roughly halving its time on a first search.

## [0.1.1] - 2026-10-05

### Changed

- **SerpApi is now an unofficial, opt-in source.** SerpApi is not a Google API: it scrapes Google Hotels pages, which Google's terms forbid and which Google has challenged in court. It now needs `ENABLE_UNOFFICIAL_SOURCES=true` as well as `SERPAPI_KEY`, and `get_data_sources`, the README and DISCLAIMER.md say how it gets its data.

### Fixed

- **Google Hotels searches near the right place.** Google ignores coordinates in a text query (a live test near New Delhi station returned hotels over 1,000 km away), so SerpApi now searches by place name: a station's or airport's name, a landmark with its city, or for coordinates the nearest railway station within 3 km. A search with no usable name skips SerpApi (`NOT_APPLICABLE` in `sources_failed`) instead of returning hotels from another city. `get_hotel_rates` looks the hotel up by its own name. Live, near New Delhi station: 20 of 20 results within 2 km.
- Google's headline rate is labelled "Google Hotels (lowest listed)" rather than with no seller.

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

[Unreleased]: https://github.com/shubhamyadav8901/hotels-mcp/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/shubhamyadav8901/hotels-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/shubhamyadav8901/hotels-mcp/releases/tag/v0.1.0
