# 03 — Geo providers, routing engines, datasets & existing geo MCPs (India focus)

Research date: 2026-10-05. Scope: geocoding / POI / distance-matrix / travel-time / isochrones for an India-focused
hotels + itinerary MCP, **free tiers only**, personal/team use, self-hosting OK.

Legend: **[V]** = verified today (live call, official page, or GitHub API). **[S]** = from secondary sources /
search snippets (believed current, not checked on the official page). **[U]** = unverified / from memory — re-check
before relying on it.

---

## 1. TL;DR recommendation

| Need | Primary (free) | Fallback / upgrade |
|---|---|---|
| Geocode / reverse geocode | **Photon** (komoot, typo-tolerant, no key) + **Nominatim** (1 req/s, cache) | Ola Maps (100k events/mo free), LocationIQ (5k/day) |
| Station / airport / bus-stand lookup | **Local datasets**: one-time OSM extract of `railway=station` (stations, ~9.4k) + **OurAirports CSV** (airports) + one-time **Overpass extract** of `amenity=bus_station` | Photon/Nominatim for anything not in the local tables |
| Hotel / lodging POI near a point | **Overpass** `tourism=hotel|guest_house|hostel|motel` (around:R) — or a local PostGIS/SQLite snapshot from Geofabrik India extract | Ola Maps Nearby Search / Google Places Nearby (5k/mo Pro cap) to fill gaps |
| Distance & travel time (point-to-point, matrix) | **OSRM** (FOSSGIS `routing.openstreetmap.de`, or self-host India extract) | OpenRouteService free key (2,000 dir/day, 500 matrix/day) |
| Isochrones ("within 20 min of station") | **Valhalla** (FOSSGIS public `valhalla1.openstreetmap.de` or self-host) | ORS isochrones (500/day) |
| Traffic-aware time (optional) | none free-and-unrestricted; Ola Maps / Mappls / Google Routes free caps | — |
| Public-transit routing | **Not viable nationally for free.** Self-hosted OpenTripPlanner with city GTFS (Delhi OTD etc.) only | Google Routes transit (city-limited, ToS-restricted) |

**Best existing MCP to reuse:** `ni-c/osm-mcp` (TypeScript, MIT, no key, 11 travel-planning tools, policy-compliant
rate limiting + caching + Overpass failover, correct foot/bike/car OSRM profiles, Valhalla isochrones, optional ORS).
It is new (2 stars) so treat it as a **reference implementation / dependency to vendor**, not a black box. Build our
own India-specific layer (station/airport/bus-terminal resolution, hotel ranking, next-day transfer, multi-city
itinerary) on top of the same backends.

---

## 2. Live evidence gathered today

### 2.1 OSM coverage in India (Overpass API, `overpass-api.de`, data timestamp 2026-10-04T21:35Z) [V]

Country-wide counts (`area["ISO3166-1"="IN"][admin_level=2]`, `nwr[...]; out count;`):

| Tag | Count |
|---|---|
| `tourism=hotel` | **16,211** (11,804 nodes, 4,361 ways, 46 rel.) |
| `tourism=guest_house|hostel|motel` | **12,500** |
| hotels with `stars` | **371** (2.3%) |
| hotels with phone/website (`phone`, `contact:phone`, `website`, `contact:website`) | **2,094** (13%) |
| `railway=station` | 9,404 |
| `amenity=bus_station` | 6,189 |
| `aeroway=aerodrome` with `iata` | 169 |

Lodging (`tourism=hotel|guest_house|hostel|motel`) within **2 km** of selected stations:

| Station (approx coords) | Count |
|---|---|
| New Delhi NDLS (28.6427, 77.2194) | 152 |
| Jaisalmer (26.9196, 70.9150) | 138 |
| KSR Bengaluru SBC (12.9781, 77.5697) | 101 |
| Mumbai CSMT (18.9398, 72.8355) | 62 |
| Puri (19.8019, 85.8312) | 40 |
| Varanasi Jn BSB (25.3268, 82.9872) | 33 |
| Ajmer AII (26.4565, 74.6378) | 8 |

**Assessment:** OSM hotel coverage in India is *usable for "what's near X" in tourist/metro hubs* but patchy: ~28.7k
lodging objects nationally vs. an estimated 100k+ actual hotels/guest houses in India **[U — no authoritative
count checked]**. Attribute richness is poor (2% stars, 13% contact). Pilgrimage/tier-2 towns (Ajmer: 8) are thin.
OSM gives **no prices, ratings or availability** — those must come from a hotel/booking source (see 02-hotel-apis.md).
Railway stations (9.4k) and bus stations (6.2k) are reasonably covered; airports are better taken from OurAirports.

Notes from running it: Overpass country-wide queries took ~60–120 s each; after ~5 heavy queries the public instance
began returning non-JSON (rate-limit) responses, and the `overpass.private.coffee` mirror also failed at that moment.
Batching several `out count;` statements into one request worked. ⇒ **Do not query country-wide Overpass at runtime;**
pre-extract once (Geofabrik `india-latest.osm.pbf` → osmium/ogr2ogr → SQLite/PostGIS) and use Overpass only for
small `around:` lookups with caching.

### 2.2 OSRM public demo [V]
`router.project-osrm.org/table/v1/driving/77.2194,28.6427;77.1000,28.5562?annotations=duration,distance` →
`"code":"Ok"`, NDLS→IGI-area distance 21,027 m. Works for India; demo server is for light/testing use only.
(osm-mcp README notes the project-osrm demo ignores the profile segment — always car — and recommends FOSSGIS
`routing.openstreetmap.de/routed-{car,foot,bike}`.) [V for README claim; profile bug itself not re-tested]

### 2.3 Photon [V]
`photon.komoot.io/api/?q=Howrah Junction` → first hit is `railway=station` "Howrah Junction", Howrah, West Bengal,
711101, coords 22.5829, 88.3428. Good station resolution with no key.

### 2.4 OurAirports [V]
`davidmegginson/ourairports-data` updated 2026-10-04 (nightly). `airports.csv` filtered to `iso_country=IN`,
`large_airport|medium_airport` with an IATA code: **140** rows. Public domain. Use as the airport table (lat/lon, IATA,
ICAO, municipality).

### 2.5 datameet/railways [V]
`github.com/datameet/railways` last pushed **2016-08-08**, no license file on GitHub (data released under ODbL per
datameet README [U]). Stale — a fresh OSM `railway=station` extract (~9.4k, with `ref` codes where tagged) is the better
source for station codes/coords; use datameet only as a coordinate cross-check.

---

## 3. Provider-by-provider

### 3.1 Open / self-hostable (OSM-based)

| Provider | What | Free limits (public instance) | India quality | Auth | Self-host | ToS notes |
|---|---|---|---|---|---|---|
| **Nominatim** (OSMF) | geocode / reverse | **Max 1 req/s**, no bulk (≤4 req/min for long jobs, single thread), **no client-side autocomplete**, must cache, identifying User-Agent, attribution (ODbL) [V] | Good for cities, stations, landmarks; weak on Indian house-level addresses (no systematic house numbers) [U] | none | Yes (Docker; India import ~ tens of GB RAM/disk [U]) | ODbL share-alike on derived DBs |
| **Photon** (komoot) | geocode, typo-tolerant, autocomplete-friendly | Public `photon.komoot.io` fair-use, no published hard limit [U]; designed for interactive use | Same OSM data; better fuzzy matching ("Howrah Junction" OK) [V] | none | Yes (Java + prebuilt country index) | ODbL attribution |
| **Pelias** | geocode (OSM + OpenAddresses + WOF + GeoNames) | No official public instance; ORS hosts one (1,000 geocode/day on ORS free key) [S] | Same OSM base | ORS key | Yes (heavy: Elasticsearch, several services) | — |
| **Overpass API** | POI queries by tag/radius | Public instances: ~2 concurrent slots/IP, timeouts; heavy use throttled (seen today) [V] | See §2.1 | none | Yes (India-only DB feasible) | ODbL; be polite |
| **OSRM** | route, table (matrix), trip, nearest | Demo `router.project-osrm.org` and FOSSGIS `routing.openstreetmap.de`: light use only, ~1 req/s [S] | Road graph good in India; **no traffic** ⇒ durations optimistic in metros (often 1.5–2× under real) [U] | none | **Yes — easiest.** India extract (~1.4 GB pbf [U]) needs ~8–16 GB RAM to preprocess (MLD) [U] | — |
| **Valhalla** | route, matrix, **isochrones**, multimodal (w/ GTFS) | FOSSGIS `valhalla1.openstreetmap.de` light use [S] | Same as OSRM; time-dependent speeds possible | none | Yes (Docker `gis-ops/valhalla`) | — |
| **GraphHopper** | route, matrix, isochrone, optimization | Hosted free: **500 credits/day, non-commercial only**, ≤5 points/route; matrix cost = origins×destinations/2 credits [S] | OSM | key | Yes (open-source core, Apache-2.0) | Free plan non-commercial |
| **OpenRouteService** (HeiGIT) | directions, matrix, isochrones, POIs, Pelias geocode | Free key: **directions 2,000/day (40/min), matrix 500/day (40/min), isochrones 500/day (20/min), geocode 1,000/day**, optimization 500/day [S — openrouteservice.org/plans] | OSM | free key | Yes (Docker `giscience/openrouteservice`) | Free for everyone incl. commercial per ORS "free and will stay free" page [S] |

### 3.2 Commercial APIs with free tiers

| Provider | Free tier (2026) | India accuracy | Auth | Key ToS restrictions |
|---|---|---|---|---|
| **Google Maps Platform** | Since 2025-03-01 no $200 credit; **per-SKU monthly free caps: Essentials 10,000 (Geocoding, Place Details Essentials, Compute Routes Essentials, Route Matrix Essentials), Pro 5,000 (Text Search, Nearby Search, Place Details Pro, Compute Routes Pro), Enterprise 1,000** [S]. India: up to 70% lower prices and "up to $6,800/month worth of free usage" across products [V — Google India blog]; exact India per-SKU caps **[U]**. Billing account (card) required [S]. | Best overall India POI/hotel coverage ("35 million businesses and places") [V-blog]; traffic-aware times | API key + billing | **No caching/storage** of content (exceptions: place_id indefinitely, lat/lng up to 30 days) [U]; **must not display Google content on a non-Google map**; attribution required. Cannot build a persistent hotel DB from Places. |
| **Google Maps Grounding Lite** (MCP) | Endpoint `https://mapstools.googleapis.com/mcp`; tools: search places, lookup weather, compute routes (drive/walk, distance+duration, no turn-by-turn); quota 300 req/min/project [V]. Pricing: official page now says pay-as-you-go / included in subscription packages [V]; earlier snippets said "no charge while Experimental" [S] — **conflict, treat as billable under SKU caps** | Google data | API key or OAuth | No caching, no model training, sources must be shown after generated content, only with "GMP-ToS-compliant LLMs" [V] |
| **Ola Maps** (Krutrim) | **Changed 2026-09-01:** first **100,000 events/month free** (all APIs), then **prepaid credits** (was 5M calls/mo free in 2024–Aug 2026) [V — maps.olakrutrim.com/pricing]. Paid e.g. Nearby/Text Search ₹0.638/req (tier 2), Distance Matrix ₹0.199/pair, Directions ₹0.199, Geocode ₹0.099 [V]. No isochrone listed [V]. | India-native; good addresses, Nearby Search on Indian POIs incl. hotels [U on quality] | API key (Krutrim cloud account) | Caching/derivative terms not checked **[U]**; vendor stability risk (pricing changed twice in 2 years) |
| **Mappls (MapmyIndia)** | Historically "free forever for developers to build and test", free tier exists per mappls-mcp README [S]; **current numeric free quota not published on about.mappls.com/api [V-absent]** — check console at auth.mappls.com/console | Strongest India-specific address/eLoc/pincode data; traffic-aware routing & distance matrix [S] | OAuth client creds / REST key | Historically restrictive on storage/redistribution [U]; commercial use needs contract |
| **Mapbox** | 100k temporary geocodes/mo, 100k directions/mo, 50k web map loads; Matrix element-based free tier [S]; card required [S] | India POI/hotel coverage weaker than Google [U]; traffic profile `driving-traffic` | token | "Temporary" geocoding results may not be stored; permanent geocoding is paid [S] |
| **HERE** | Base plan: freemium ~30k transactions/mo per service family (up to 250k platform total quoted) [S] | Good India road/traffic data, HERE has India presence [U] | API key | Card required [U]; caching limited |
| **TomTom** | **2,500 non-tile requests/day + 50k tiles/day free**, no card [S] | Decent India routing w/ traffic; POI weaker [U] | key | Storage restrictions [U] |
| **LocationIQ** | **5,000 req/day, 2 req/s, 60/min**, attribution, "limited commercial" [S] | Nominatim-based (OSM) + own data | key | Attribution |
| **Geoapify** | **3,000 credits/day** (Places = 1 credit/req), "limited commercial use" with attribution [S]. Has Places (incl. `accommodation.hotel`), routing, matrix, isochrones | OSM-based ⇒ same coverage as §2.1 | key | Attribution; free = limited commercial |
| **OpenCage** | 2,500 req/day, 1 req/s ("free trial") [S] | Aggregates OSM etc. | key | Free = testing |
| **Foursquare Places** | Pro endpoints first 500 calls free then $15 CPM; developer sandbox "10,000 free calls"; earlier $200/mo credit messaging [S — conflicting]. **FSQ OS Places** open dataset (Apache-2.0, 100M+ POIs) downloadable free [S] | India coverage moderate [U] | key | FSQ OS Places is a free alternative POI dump worth evaluating for hotels |

### 3.3 Public transit routing in India
- No free national multimodal router. Google Routes API supports `TRANSIT` in some Indian metros (Delhi, Mumbai,
  Bengaluru, Chennai, Kolkata, Hyderabad) **[U]** — subject to Google ToS and SKU caps.
- Open GTFS: Delhi Open Transit Data (DTC + cluster buses, DMRC) **[U]**; scattered metro GTFS (Kochi, Bengaluru BMRCL
  unofficial) **[U]**. Self-hosted **OpenTripPlanner 2** or **Valhalla multimodal** can use these per city.
- Pragmatic MCP approach: report **driving time (OSRM) + walking time + straight-line distance**, plus a
  configurable "metro buffer" multiplier, and flag "transit option may exist" rather than computing transit.

---

## 4. Reference datasets

| Dataset | Content | License | Freshness | Use |
|---|---|---|---|---|
| **OSM railway=station extract** | ~9.4k Indian stations w/ coords, `ref` codes where tagged | ODbL | weekly (Geofabrik) | **Primary station source** |
| **OurAirports** `airports.csv` | 140 IN medium/large airports w/ IATA [V] (+ small/heliports) | Public domain [S] | Nightly (2026-10-04) [V] | Airport table |
| **datameet/railways** | stations.json (GeoJSON) | ODbL [U] | 2016 [V] — stale | Cross-check only |
| **Geofabrik India extract** | full OSM `india-latest.osm.pbf` | ODbL | daily | One-time import of hotels, bus stations, attractions into SQLite/PostGIS |
| **OSM `amenity=bus_station`** | 6,189 objects [V] | ODbL | live | Bus terminal table (ISBTs, MSRTC/KSRTC depots) |
| **Wikidata** | tourist attractions (P31 tourist attraction / monument / temple), coords P625, Wikipedia sitelinks for popularity ranking | CC0 | live (SPARQL, 60 s timeout) | Landmark resolution + "top sights" for itineraries |
| **OSM `tourism=attraction|museum|viewpoint`, `historic=*`** | attractions | ODbL | live | Combine with Wikidata via `wikidata=` tag |
| **FSQ OS Places** | global POIs incl. hotels | Apache-2.0 [S] | periodic | Optional hotel-coverage booster vs OSM [U on India quality] |

---

## 5. Existing geo MCP servers (GitHub metadata pulled 2026-10-05 via `gh api`) [V unless noted]

| Server | Link | Tools (relevant) | Upstream | Auth | License | Maintenance |
|---|---|---|---|---|---|---|
| **ni-c/osm-mcp** | github.com/ni-c/osm-mcp (npm `osm-mcp`) | `geocode`, `reverse_geocode`, `route` (car/foot/bike), `route_matrix`, `optimize_route`, `isochrone`, `find_nearby_pois` (category or raw OSM tag, sorted by distance), `poi_details`, `suggest_meeting_point`, `straight_line_distance`, `map_link`; `OSM_ALLOW_TOOLS=essential` preset | Nominatim, Photon, OSRM (FOSSGIS), Valhalla, Overpass (+mirror failover), optional ORS | **none** (ORS key optional) | MIT | pushed 2026-09-29, 2 stars, CI + OpenSSF scorecard; TS, Node ≥22; per-service rate limiting, UA, in-memory cache. **Best fit.** |
| **jagan-shanmugam/open-streetmap-mcp** | github.com/jagan-shanmugam/open-streetmap-mcp (`uvx osm-mcp-server`) | `geocode_address`, `reverse_geocode`, `find_nearby_places`, `get_route_directions`, `search_category`, `suggest_meeting_point`, `explore_area`, `analyze_commute`, + schools/EV/parking/neighborhood | Nominatim/Overpass/OSRM (not documented explicitly) | none | MIT | 226 stars but **last push 2025-07-12** (stale); Python; no matrix/isochrone |
| **Google Maps Grounding Lite** (official, remote) | developers.google.com/maps/ai/grounding-lite; sample app googlemaps-samples/grounding-lite-mcp-sample-app (Apache-2.0, 67★, 2026-06) | search places, compute routes (drive/walk), weather | Google | API key / OAuth | Google ToS | Official; strict ToS (no caching) |
| **cablate/mcp-google-map** | github.com/cablate/mcp-google-map | `search_places`, `search_nearby`, `place_details`, `geocode`, `reverse_geocode`, `directions`, `distance_matrix`, `plan_route`, `batch_geocode`, `search_along_route`, `timezone`, `weather`, `static_map`… (18) | Google Places (New), Routes, Geocoding | Google key | MIT | 467★, pushed 2026-09-26 — best community Google MCP |
| modelcontextprotocol reference Google Maps server | moved to modelcontextprotocol/servers-archived | geocode, places search, distance matrix, directions… | Google (legacy APIs) | key | MIT | **Archived** (2025-05) — don't use |
| **mapbox/mcp-server** (official) | github.com/mapbox/mcp-server | ~28 tools incl. `category_search_tool` (hotels), `directions_tool`, `matrix_tool`, `isochrone_tool`, geocoding | Mapbox | token | MIT | 358★, pushed 2026-10-01; active |
| **AmanMakesStuff/mappls-mcp** | github.com/AmanMakesStuff/mappls-mcp | `geocode`, `reverse_geocode`, `autosuggest`, `text_search`, `nearby_search`, `place_details`, `validate_pincode`, `get_directions(_with_traffic)`, `distance_matrix(_with_traffic)`, `poi_along_route`, `snap_to_road`, `aerial_distance`… (18) | Mappls | Mappls key | README says MIT, **no LICENSE detected by GitHub** | 3★, pushed 2026-05-05 — early-stage; useful as Mappls reference |
| svsairevanth/Mappls-Mcp- | github | — | Mappls | key | — | 2025-11, minimal [U] |
| **pipeworx-io/mcp-openrouteservice** | github | routing, isochrones, matrix, snap, elevation, Pelias geocode | ORS | ORS key | MIT | 0★, 2026-09 (part of Pipeworx gateway) |
| pipeworx-io/mcp-osrm, mcp-overpass, mcp-geoapify | github | OSRM demo routing; Overpass QL; Geoapify | resp. | — / key | MIT [U] | 2026-09, generated-gateway style |
| burningion/geoapify-mcp, OriShmila/geoapify-mcp-server | github | Geoapify geocode/places/routing | Geoapify | key | [U] | 2025-08 / 2026-01, demo quality |
| Rusty0508/overpass-mcp, RigaOnTheRocks/overpass-mcp, alexinatra2/overpass-mcp | github | raw Overpass QL (+Nominatim) | Overpass | none | MIT | 0★, 2026 |
| Ola Maps MCP | — | **none found** (`gh search repos "ola maps mcp"` → no results) | — | — | — | — |
| Official ORS MCP | — | none found from HeiGIT (GIScience/openrouteservice-mcp → 404) | — | — | — | — |

---

## 6. Recommended architecture for the hotels MCP (geo layer)

1. **Anchor resolution (local, fast, no quota):** station → local OSM station table; airport → OurAirports
   (IATA/name); bus terminal → pre-extracted OSM `amenity=bus_station` table; landmark → Wikidata/OSM attractions table,
   fallback Photon → Nominatim (1 req/s, cached, real User-Agent). Raw lat/long passes through.
2. **Hotel candidates:** pre-extracted OSM lodging table (SQLite + R*Tree or PostGIS) queried by radius; enrich with a
   hotel/price source from 02-hotel-apis.md. Optional gap-fill via Ola Maps Nearby (100k events/mo) — note
   Google/Ola ToS may forbid storing their results.
3. **Travel time:** self-host **OSRM** (India car + foot profiles) for `route` / `table` — unlimited, fast; or start on
   FOSSGIS public instance with 1 req/s + cache. Apply a configurable urban-congestion multiplier since OSM has no
   traffic. "Within N minutes" ⇒ OSRM `table` from anchor to all radius candidates (cheaper than isochrones) or
   Valhalla isochrone for map output.
4. **Next-day transfer:** `table` hotel → tomorrow's station/airport; add buffers (airport 2 h domestic, station 30 min)
   as configurable constants.
5. **Multi-city itinerary:** chain user-supplied train/flight legs + per-city hotel choice minimising
   (arrival-station→hotel) + (hotel→departure-station) times; OSRM `trip` for in-city sightseeing order.
6. **Reuse:** vendor or depend on `ni-c/osm-mcp` client code (rate limiter, Overpass failover, FOSSGIS profile prefixes)
   rather than re-implementing; keep our MCP's tool surface India-specific and small.

Self-hosting footprint (all [U], rough): OSRM India car MLD ~8–16 GB RAM to build, ~4–6 GB to serve; Photon India
index few GB; Nominatim India 30–60 GB disk. OSRM alone + local SQLite is the minimum viable self-host.

---

## 7. Sources
- Overpass / OSRM / Photon live queries (this document §2) — run 2026-10-05.
- Nominatim usage policy: https://operations.osmfoundation.org/policies/nominatim/
- OpenRouteService plans: https://openrouteservice.org/plans/ , restrictions: https://openrouteservice.org/restrictions/
- Google pricing: https://developers.google.com/maps/billing/pricing ; https://www.woosmap.com/blog/google-maps-api-pricing-breakdown ;
  India: https://blog.google/intl/en-in/products/explore-communicate/helping-developers-in-india-build-more-with-google-maps-platform/
- Grounding Lite: https://developers.google.com/maps/ai/grounding-lite , https://developers.google.com/maps/ai/grounding-lite/reference/mcp
- Ola Maps: https://maps.olakrutrim.com/pricing , https://maps.olakrutrim.com/pricing/update-2026 , https://tech.olakrutrim.com/ola-maps-made-for-india-priced-for-india/
- Mappls: https://about.mappls.com/api/ (no quota published)
- Geoapify: https://geoapify.com/pricing ; GraphHopper: https://www.graphhopper.com/pricing/ ; LocationIQ: https://web.locationiq.com/pricing ;
  TomTom: https://developer.tomtom.com/pricing ; HERE: https://developers.here.com/plans ; Foursquare: https://foursquare.com/pricing/ ;
  Mapbox: https://www.woosmap.com/blog/mapbox-pricing
- MCPs: https://github.com/ni-c/osm-mcp , https://github.com/jagan-shanmugam/open-streetmap-mcp , https://github.com/cablate/mcp-google-map ,
  https://github.com/mapbox/mcp-server , https://github.com/AmanMakesStuff/mappls-mcp , https://github.com/pipeworx-io/mcp-openrouteservice
- Datasets: https://github.com/davidmegginson/ourairports-data , https://github.com/datameet/railways , https://download.geofabrik.de/asia/india.html
