# India Hotels + Geo MCP: Research Summary (2026-10-05)

Constraints: personal/team use, free tiers only, live prices required.
Details: 01-existing-mcps.md, 02-hotel-apis.md, 03-geo-providers.md, 04-india-platforms.md.

## Verdict
No single existing MCP or free API meets the requirements. Together, existing *data sources* cover about 80%.
Build a **thin custom MCP** (TypeScript, @modelcontextprotocol/sdk) that brings these sources together and adds the
geo and itinerary logic that no existing server has.

## Reuse (upstream sources)
| Need | Source | Why | Caveat |
|---|---|---|---|
| Live prices, INR, lat/lng search | trivago official MCP (mcp.trivago.com/mcp) | Free, no auth; advertisers include MakeMyTrip, Goibibo, Agoda, Booking | ~700 KB responses (over Claude Code's 25k-token limit), `system_message` instructions, premium bias, cheapest advertiser only |
| Radius search plus availability check | HotelsCasa MCP | Real lat/lng/radius_km search | EUR only, small vendor |
| Per-OTA rate comparison | Xotelo (TripAdvisor meta) | Free, no key, covers OYO/Treebo/FabHotels/Zostel/hostels | Unofficial, ToS grey, no SLA, no geo search |
| MakeMyTrip and direct hotel rates | SerpApi Google Hotels | Richest data; reaches Indian channel managers | 250 searches/month, so cache heavily |
| Hotel locations (no prices) | OSM extract (Geofabrik) → local SQLite | 16k hotels + 12.5k guest houses; good in metros and tourist towns | Thin in tier-2 towns, no prices or ratings |
| Geocoding | Photon + Nominatim (cached) | Free, India OK | Nominatim limit is 1 req/s |
| Distance / drive time / matrix | OSRM (public with cache, or self-hosted) | Unlimited if self-hosted | No traffic data, so apply a metro multiplier |
| Anchors | OSM extract (stations, `railway=station` + `ref` codes), OurAirports (airports), OSM (bus stations), Wikidata/Photon (landmarks) | Local tables | datameet stations are stale (2016) |
| Geo client code | ni-c/osm-mcp (MIT) | Rate limiting, caching, Overpass fallback | 2 stars, so vendor the code |

## Gaps that must be built
1. Normalising and deduplicating hotels across sources (name + coordinate matching), plus FX conversion to INR.
2. Proximity scoring for arrival and departure points, including "within N minutes" (OSRM table).
3. Itinerary planning: chain train/flight arrivals → stay → next departure, multi-city.
4. IRCTC retiring rooms: cached list of 356 stations joined to OSM station coordinates + stay-fit check + deep link (live booking needs PNR/login).
5. Cleaning upstream output: strip photos and `system_message`, expose read-only tools only.

## Unreachable for free
IRCTC live retiring-room availability, most state tourism corporation properties, temple trusts/dharamshalas (indicative prices only),
Hostelworld-only hostels, B2B net rates, Airbnb-only villas (scraping only).

## Risks
All free live-price sources are third-party endpoints with no SLA. Xotelo/HotelsCasa could disappear, so
the provider layer must be pluggable and degrade gracefully. Meta-search prices may exclude GST.

## Open checks
SerpApi `gl=in` advertiser list; Cleartrip MCP tools after personal OAuth; RollingGo key test for India.
