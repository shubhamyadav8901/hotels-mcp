# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

Planned as 0.2.0.

### Added

- **Families in one room.** `search_hotels`, `get_hotel_rates` and `plan_stays` take `children_ages` (up to 4 children, ages 0–17) besides `adults`, at most 8 guests. Every source is asked for one room for that party, so results are rooms that fit everyone. Xotelo returns no prices when children are sent, so it counts them as adults (its prices err high, never low); the response says so.
- **Guest-rating floor:** `min_rating_pct` on `search_hotels` and `plan_stays` (e.g. 60 = 6.0/10), with a server default from `DEFAULT_MIN_RATING_PCT` (0 = off) that the agent can override per request. It applies to the merged guest rating after all sources answer (not at source, where a source would judge by its own rating and could drop its price for a hotel that passes); unrated hotels are left out while it is on, and counted in the notes.
- **One room for the party, on evidence.** Each price carries `fit` (`one_room`, `two_rooms` or `unknown`) with `fit_basis` and `fit_note`, and each hotel `room_status` (`one_room`, `unverified`, `two_rooms_only`) and `rank_price` (the price it is ranked and filtered by). Sources mostly show only their cheapest offer per booking site, which for 3+ guests is often two rooms (trivago's one-room price for 4 adults matched its two-room price at every hotel checked; Agoda calls it "Cheapest combo rooms"), while a pricier room for the party may exist. A price is called one room only from a room name that sleeps the party or a site's rate stated for that many guests, and two rooms from a combo or multi-bedroom name or about exactly double (1.9–2.15×) the same booking site's 2-adult price; anything else is `unknown`. For 3–4 guests the search asks trivago (same points, plus its 15 cheapest misses by name) and Xotelo for 2 adults to spot doubled prices. No hotel is hidden for having only two-room prices; sorted by price they come last. `get_hotel_rates` with `verify_room: true` fetches Google's room list for the hotel (1 SerpApi search: Booking.com and Agoda state each rate's guests) and the same sites' 2-adult prices, and re-labels every price; failed lookups are reported. `resolve_place` says when a named railway station doesn't exist and lists the nearest ones. `plan_stays` candidates and `compare_hotels` show the same labels.
- **Room names:** prices carry the room as the source names it (`room`, from HotelsCasa), since no source can filter by bed type and "fits four adults" can mean a family room or a double with extra beds.
- **Cheapest first at the source.** With `sort=price` (or `rating`), Google Hotels and HotelsCasa are asked for their cheapest (or best-rated) results, and minimum stars (and, for Google, the price cap) are applied server-side, so their single page of results is the right page. trivago gets the star filter.

### Changed

- **"Hotels in X" searches the town.** A place query that names a town or city exactly (e.g. `Jaipur`) resolves to the town rather than to its main station, and Google Hotels is asked for "hotels in Jaipur, Rajasthan".
- **Wider coverage, reported.** trivago (≈25 hotels around one point, no radius control) is queried at up to 13 points across searches wider than 3 km; HotelsCasa fetches up to 5 pages for them; Google Hotels can fetch more pages (`SERPAPI_MAX_PAGES`, one SerpApi search each). `search_hotels` reports per-source `coverage`. Live, 10 km around Ernakulam Junction: 172 priced hotels instead of 46, with trivago reaching 9.7 km instead of 2.5 km.
- **Room names:** whole multi-bedroom units ("2-Bedroom Apartment", "Two-Bedroom Villa") are flagged as not a single room; "Family Quadruple Room, 1 Bedroom" and "Family room for 4 adults" are read correctly.
- **Xotelo under load.** Requests are still spaced 1.2 s apart for everyone sharing the server, but one whose turn is too far away is skipped at once (`RATE_LIMITED`, "Xotelo is busy") instead of queueing until the caller's deadline, and a search returns the hotels Xotelo priced in time. Concurrent identical requests share one call. With five agents at once this removed Xotelo timeouts; Xotelo simply contributes fewer prices when many cold searches run together.
- **Slow networks.** Node gives each of a host's addresses only 250 ms to connect and drops the attempt when it moves on, so on a slow or NAT64 network (0.5–5 s connects seen from Docker) every source failed with ETIMEDOUT although reachable. Each attempt now gets 2.5 s.
- **Google Hotels shape tolerance.** A price, site or room Google lists without a name is skipped instead of failing the whole response (seen live as SCHEMA_CHANGED for one hotel).
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
