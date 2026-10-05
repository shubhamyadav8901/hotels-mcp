# 02 — Hotel / Stay Data APIs with India Coverage

Researched 2026-10-05. Constraints: self-hosted, personal/team use, **free tiers only**, **live availability/pricing required**, India focus.

Legend: **[V]** = verified this session (official page fetched or live API call run). **[R]** = reported by secondary sources (blogs, aggregators), not confirmed on an official page. **[U]** = unverified / inferred.

---

## TL;DR — what actually gives LIVE India prices for free to an individual

| Rank | Source | Live price? | Free tier | Individual OK? | Geo (lat/long) | Verdict |
|---|---|---|---|---|---|---|
| 1 | **Xotelo** (TripAdvisor meta rates) | Yes, per-OTA rates (Booking, Agoda, Trip.com, Vio, official site) in INR [V] | Free, no key [V] | Yes, no signup [V] | Returns lat/long per hotel; no radius search (city via TripAdvisor `location_key`) [V] | Best free live-price source. Unofficial, no SLA, ToS grey. |
| 2 | **SerpApi – Google Hotels** | Yes, Google Hotels prices from multiple OTAs [V] | 250 searches/mo, 50/hr [V] | Yes, self-serve [V] | Returns `gps_coordinates`; search by text query (`q`), not radius [V] | Best quality & richest data; quota tight → cache aggressively. |
| 3 | **LiteAPI (Nuitee)** | Yes, bookable net rates (real supplier inventory) [V docs] | Core Rates/Prebook/Book endpoints free subject to "reasonable" look-to-book (5000:1 cited) [V/R]; sandbox free, no card [V] | Signup is self-serve; production key needs a credit card + payout method [V] | Yes: city/country/lat-long search [V docs] | Only real *booking-grade* API with no business contract. Sandbox data is test data [U]; production needs card. |
| 4 | **SearchApi.io – Google Hotels** | Yes (Google Hotels) [R] | 100 free requests total (trial, not monthly) [R] | Yes | gps in results [R] | Backup to SerpApi; one-off trial only. |
| 5 | **Hotelbeds APItude (eval key)** | Test-environment rates, not production [V-ish, R] | 50 req/day eval [R] | Self-serve registration for eval [R] | Yes (geolocation search in Booking API) [U] | Eval env only; live production requires a B2B contract. Not a real live source. |
| 6 | **DataForSEO – Google Hotels** | Yes | No ongoing free tier; free account + playground; pay-per-entity ($0.00075–$0.004) [R] | Yes | gps [U] | Cheap but not free. |
| — | **RapidAPI "booking-com15"** etc. | Yes (scraped Booking.com) [U] | Free "Basic" plans typically ~tens–hundreds req/mo — could not confirm current numbers [U] | Yes | Booking-com15 supports coordinates search [U] | Unofficial scrapers; fragile; ToS risk. |

Everything else (Booking.com Demand, Agoda, Expedia Rapid, TBO, RateHawk, WebBeds, MMT/Goibibo, Cleartrip, Yatra, EaseMyTrip, OYO) requires a business/partner contract for live rates, or has no public API.

---

## Full comparison table

| Provider | Official link | Data offered | Auth / approval | Free tier & pricing | India coverage | Geo search | ToS / caching / display | Status 2026 |
|---|---|---|---|---|---|---|---|---|
| **Booking.com Demand API** | https://developers.booking.com/demand/docs/getting-started/prerequisites | Static content, live availability & rates, Orders (booking) | Managed Affiliate Partner + signed contract + Account Manager; booking ("Search, Look & Book") needs separate approval & business case [R, prereq page referenced] | No self-serve tier [R] | Excellent (largest India inventory incl. homestays) | Yes (coordinates/radius in accommodations search) [U] | General Partner Terms v5 reportedly prohibit using an AI system in performing the agreement without written approval and prohibit AI training on materials [R] — **directly relevant to an MCP/LLM use case** | Active, closed to individuals |
| **Booking.com Affiliate Partner (links/widgets)** | https://www.booking.com/affiliate-program | Deeplinks, search box, banners — no data API | Self-serve signup (site required) [R] | Free (commission) | Excellent | No | Link-out only | Active; also what Hotellook links now redirect to |
| **Agoda Affiliate / Partner API ("Long Tail"/Lite search API)** | https://developer.pps.agoda.com/docs ; https://partners.agoda.com | Search API (cheapest rates for up to 100 property IDs per request), content feed; Book API for fulfilment partners [V FAQ] | Credentials only after "commercial procedures are completed" (welcome package) [V]. Affiliate programme signup is self-serve, but API access is granted case-by-case [R] | No published free tier; rate limits given at onboarding, 429 + 15s blocks [V] | Very strong in India (incl. budget/homestays) | **No lat/long** in Search API — by property IDs (city via content feed) [V] | Display rules in partner agreement [U] | Active; possible for an affiliate with a site, unlikely for pure personal use |
| **Expedia Rapid API (EPS)** | https://developers.expediagroup.com/rapid | Content, live shopping, booking, manage | Partner-only: application, approval, certification; corporate entity & track record; launch requirements incl. PCI evidence [R] | None | Good | Yes (region/geo) [U] | Strict display requirements (taxes/fees, TripAdvisor content) [R] | Active, closed to individuals |
| **Expedia/Hotels.com affiliate (Creator/Affiliate)** | https://affiliates.expediagroup.com | Links only | Self-serve [U] | Commission | Good | No | — | Active |
| **Airbnb** | — | **No public API** (partner API only for hosts/PMS) | Closed | — | Good (urban + hill stations) | — | Scraping violates ToS | Alternatives: Apify actors ($0.75–$4 per 1,000 listings, pay-per-event; Apify gives small monthly free credit) [R]; open-source scrapers (e.g. `pyairbnb`) [U]; Google Hotels "vacation_rentals=true" via SerpApi returns some rentals [V param exists] |
| **OYO** | https://www.oyorooms.com ; Travelpayouts OYO offer | OYO Open API exists for **supply/channel partners** (hotel owners, OTAs) [R]; affiliate via Travelpayouts (links, widgets) [R] | Partner contract | Commission only | Very strong budget India | Unknown | — | No public data API for individuals [U] |
| **MakeMyTrip / Goibibo** | https://www.makemytrip.com ; via Cuelinks / vCommission | Affiliate links (flat payout ~₹120–144 domestic hotel) [R]; no public rates API. "MMT Hotel API" sold via aggregators like Vervotech is B2B [R] | Affiliate networks (Cuelinks, vCommission) — self-serve with a site [R] | Commission only | Best domestic inventory | No | — | No public data API |
| **Cleartrip** | https://www.cleartrip.com | Historic "Cleartrip API" for affiliates (2010s) [U]; current claims of a hotel API come from SEO pages (adivaha) — **treat as unverified** | Unknown | — | Good | — | — | No verifiable public API in 2026 [U] |
| **Yatra / EaseMyTrip / ixigo** | — | B2B agent portals / affiliate links; EaseMyTrip "partner API" referenced only by reseller SEO pages [U] | B2B agent registration (GST, IATA/agency docs typical) [U] | — | Good | — | — | No public free API [U]. ixigo has no hotel API (hotels via partners) [U] |
| **Treebo / FabHotels / Zostel** | — | No public API; distributed via OTAs/channel managers | — | — | Chain-specific | — | — | None [U] |
| **Hostelworld** | https://partners.hostelworld.com | Affiliate via Partnerize: links, feeds, "APIs and search widgets" for approved affiliates [R] | Partnerize signup; API case-by-case [R] | Commission | Moderate (Zostel, goSTOPS, The Hosteller listed) [U] | Unknown | — | Active; API not self-serve [R] |
| **Amadeus Self-Service (Hotel List/Search/Offers/Ratings)** | https://developers.amadeus.com | Was: hotel list by geocode, Hotel Search (live offers), booking | — | — | Was decent | Was yes (geocode + radius) | — | **Decommissioned**: new registrations paused; all self-service keys disabled **17 Jul 2026** [R, multiple sources incl. PhocusWire]. Enterprise only now. |
| **LiteAPI (Nuitee)** | https://docs.liteapi.travel ; https://dashboard.liteapi.travel | Static content (2M+ hotels), live rates, prebook, book, cancel; reviews; price index; places | Self-serve account; sandbox key free, no card [V]. Production key: attach credit card + payout method [V]. No explicit KYC stated [V FAQ] | Rates/Prebook/Book & content free with "reasonable look-to-book" (5000:1 quoted) [V/R]; price index $0.05/req; places $0.01/req; extra seats $1.99–$4.99/mo [V] | Global; India covered (exact count unverified) [U] | **Yes — city, country or lat/long** [V FAQ] | Sandbox 5 rps [V]; production limits in dashboard. LiteAPI is merchant of record; you set `margin`. Card on file is a gate even if you never book [V] | Active, best "official" option |
| **Hotelbeds (APItude)** | https://developer.hotelbeds.com | Content API, Booking API (availability, checkrate, booking) | Self-serve eval registration; production requires contract & certification [R] | Eval: 50 requests/day, test environment [R] | Good India (bedbank) | Yes (geolocation lat/long + radius) [U] | B2B confidentiality on net rates [U] | Active; eval only for individuals |
| **TBO Holidays (TBO.com)** | https://www.tboholidays.com/xml_api.htm | Static content, live rates & availability, booking; 700k–1M+ hotels [R] | Registered travel agency (contact partners@tboholidays.com) [R]; typically GST/business docs [U] | No free tier (net-rate B2B) | **Excellent** — India's largest B2B portal | Unknown | Net rates confidential [U] | Active, business-only |
| **RateHawk / Emerging Travel Group (ETG API)** | https://docs.emergingtravel.com | Content, search (incl. geo), prebook, book | Active B2B partner account + contract; sandbox (Q4 2025+) for new partners only, simulated data [R] | None for individuals | Good | Yes (geo search endpoint) [U] | Certification before live [R] | Active, business-only |
| **WebBeds** | https://www.webbeds.com/buyers | Search, rates, booking | Approved travel businesses via form [R] | None | Moderate | Unknown | — | Active, business-only |
| **Travelpayouts / Hotellook API** | https://support.travelpayouts.com (Hotellook closure FAQ) | Was: hotel lookup + cached prices | Was free token | — | — | — | — | **Hotellook closed 20 Oct 2025**; API stopped. `engine.hotellook.com/api/v2/lookup.json` returns **404** (tested 2026-10-05) [V]. Travelpayouts still offers affiliate links for Booking/Agoda/OYO/Hostelworld etc., but no free hotel price API [R] |
| **Makcorps** | https://www.makcorps.com | Hotel price comparison across 200+ OTAs (city search, hotel rates, historical) | Account signup | Historically ~30 free calls / 30-day trial, then paid plans (pricing page 404 today) [U] | Covers India via TripAdvisor-like IDs [U] | No radius [U] | — | Active (pricing unverified); trial only |
| **Xotelo** | https://xotelo.com | `/list` (hotels by TripAdvisor location key, with rating, price range, geo, image), `/rates` (live per-OTA rates for dates, any currency), `/heatmap` (cheap/avg/high days), `/search` (RapidAPI only) [V] | **No key, no signup** [V] | Free; rate limits undocumented [V] | **Deep** — Mumbai 4,486 properties; Rishikesh 1,925 [V live test] | lat/long returned per hotel; search by TripAdvisor geo `location_key`, not radius [V] | `cache-control: no-cache`; no ToS on caching published. Data derived from TripAdvisor meta-search — unofficial, may break [V/U] | Active (tested 2026-10-05) |
| **SerpApi – Google Hotels** | https://serpapi.com/google-hotels-api | Property list + prices per OTA, `rate_per_night`, `total_rate`, ratings, amenities, nearby places, `property_token` details, vacation rentals [V] | Self-serve email signup [V] | Free 250 searches/mo, 50/hr; Starter $25/mo for 1,000 [V] | Excellent (Google Hotels has deep India coverage incl. MMT/Goibibo/Agoda/Booking prices) [U for which OTAs appear] | `gps_coordinates` returned; query is free text (e.g. "hotels near Hawa Mahal") — no lat/long+radius param [V] | SerpApi assumes legal liability on paid plans ("Legal US Shield") [U]; cache freely on your side | Active |
| **SearchApi.io – Google Hotels** | https://www.searchapi.io | Google Hotels search + property details + autocomplete [R] | Self-serve | 100 free requests (one-time trial), no PAYG [R] | Same as Google | gps [U] | — | Active |
| **DataForSEO – Google Hotels** | https://dataforseo.com/apis/business-data-api/google-hotels-api | Hotel searches, hotel info with prices by date | Self-serve | Pay-as-you-go: $0.00075 (standard queue) – $0.004 (live) per hotel entity; free account/playground; min. deposit (historically $50) [R/U] | Same as Google | Location by coordinates supported [U] | — | Active, not free |
| **RapidAPI hotel endpoints** (e.g. DataCrawler `booking-com15`, Tipsters `booking-com`, `hotels-com-provider`, Apidojo `travel-advisor`) | https://rapidapi.com/DataCrawler/api/booking-com15 | Scraped Booking/Hotels.com/TripAdvisor search, rates, details | RapidAPI account | Free "Basic" plans exist, limits vary per provider and change often — could not confirm current numbers [U] | Inherits source (Booking.com = strong) | booking-com15 has search-by-coordinates [U] | Unofficial; provider can vanish; Booking ToS risk | Variable |
| **Google Places API (New)** | https://developers.google.com/maps/documentation/places/web-service | Hotel/lodging listings, ratings, photos, `priceLevel`/`priceRange` (no live rates) | Google Cloud billing account (card) required | Since Mar 2025: free monthly per-SKU thresholds — 10,000 Essentials, 5,000 Pro, 1,000 Enterprise calls [R, Google page] | Excellent | **Yes**: Nearby Search with `locationRestriction` circle + `includedTypes: ["lodging","hotel"]` [U from docs knowledge] | Caching limited (place_id indefinitely; other content ≤30 days) [U] | Active; no prices |
| **TripAdvisor Content API → Terra API** | https://tripadvisor-content-api.readme.io ; tripadvisor.com/developers | Location search (incl. lat/long nearby search), details, photos, reviews; **no prices** | Self-serve key; card on file historically required [U] | Content API sunset **31 Aug 2026**; Partner API/feeds **30 Oct 2026**; Terra API: first 1,000 calls free then PAYG; also reported "Discover tier" 10 QPS / 10k/day [R — conflicting, unverified] | Good | Yes (nearby search by lat/long) [U] | Attribution required [R] | In transition |
| **Foursquare Places API** | https://foursquare.com/products/pricing | POIs incl. hotels; no prices | Self-serve | Pro endpoints 10,000 free calls/mo (also cited: first 500 at $0, then $15 CPM — conflicting) + $200 credit for new users [R]; FSQ OS Places open dataset free [R] | Good in metros, thinner in small towns [U] | Yes (ll + radius) | Attribution | Active; no prices |

---

## Notes

### Live-test evidence (2026-10-05)
```
curl "https://data.xotelo.com/api/list?location_key=g304554&limit=3"          # Mumbai
-> {"error":null,"result":{"total_count":4486, ... "geo":{"latitude":19.095755,"longitude":72.854034} ...}

curl "https://data.xotelo.com/api/rates?hotel_key=g304554-d307109&chk_in=2026-11-10&chk_out=2026-11-11&currency=INR"
-> {"rates":[{"name":"Booking.com","rate":11613},{"name":"Trip.com","rate":8938},
             {"name":"Vio.com","rate":6962},{"name":"Agoda.com","rate":8143},
             {"name":"Official Site","rate":10291}]}

curl "https://data.xotelo.com/api/list?location_key=g580106&limit=2"          # Rishikesh
-> total_count 1925

curl "https://engine.hotellook.com/api/v2/lookup.json?query=goa..."           # Hotellook
-> HTTP 404 (dead)
```
Xotelo rate `tax` was `null` — rates appear pre-tax; Indian GST (12%/18%) not included [U].

### Key 2026 changes
- **Amadeus Self-Service is gone** (keys disabled 17 Jul 2026). Many older tutorials for "free hotel API with geocode search" point here — do not build on it.
- **Hotellook / Travelpayouts hotel data API is gone** (closed 20 Oct 2025).
- **TripAdvisor Content API sunset 31 Aug 2026**, replacement Terra API — free allowance terms are inconsistent across sources; verify at signup.
- **SerpApi free tier raised** 100 → 250/mo (July 2025).
- **Booking.com Demand API** is partner-only and its terms reportedly restrict AI-system use without written approval — even if approved, an LLM/MCP front-end needs explicit permission.

### Who gets approved
- **Individuals, no business:** Xotelo, SerpApi, SearchApi, DataForSEO, RapidAPI scrapers, Google Places, Foursquare, TripAdvisor, Hotelbeds eval, LiteAPI (sandbox free; production needs only card + payout per docs).
- **Need a website/app + affiliate approval:** Booking.com Affiliate (links), Agoda Partners, Hostelworld (Partnerize), MMT/Goibibo via Cuelinks/vCommission, OYO via Travelpayouts — links/widgets only, not data APIs.
- **Need a registered travel business / contract:** Booking Demand API, Agoda API, Expedia Rapid, TBO, RateHawk, WebBeds, Hotelbeds production, Amadeus Enterprise.

### Data freshness
- Xotelo/SerpApi/SearchApi/DataForSEO: real-time scrape of meta-search at request time (Google Hotels/TripAdvisor themselves cache OTA rates — prices are indicative, can differ at checkout) [U].
- LiteAPI: live supplier rates; must re-check with `prebook` before booking (bookable accuracy).
- Places/Foursquare/TripAdvisor content: static; no rates.

### Gaps
1. **No free, official, live-rate API with lat/long+radius search** exists for India. LiteAPI comes closest but production needs a card and has a look-to-book policy; sandbox is not real pricing [U].
2. **Indian OTAs (MMT, Goibibo, Cleartrip, Yatra, EaseMyTrip, ixigo, OYO) expose no public data API** — only affiliate links or B2B. Their prices are only reachable indirectly via Google Hotels (SerpApi) meta results.
3. **Homestays / Airbnb / Zostel-type stays** have no free official source; Google Hotels `vacation_rentals` and Apify scrapers (paid) are the only routes.
4. **Taxes:** most meta sources return base rates; GST handling must be added client-side [U].
5. **Quota:** SerpApi 250/mo ≈ 8/day — needs caching (e.g. 6–24h TTL per city+dates) and Xotelo as primary.
6. Unverified: current RapidAPI free-plan limits, Makcorps pricing, Terra API free allowance, Hotelbeds eval quota (secondary sources only).

### Suggested architecture implication
- **Discovery/geo:** Google Places (New) or Foursquare (lat/long radius, 10k free/mo) → hotel names + coordinates.
- **Live prices:** Xotelo (`/list` by city key, `/rates` per hotel, free) as primary; SerpApi Google Hotels (250/mo) for richer results / cross-check / Indian OTA prices.
- **Optional booking-grade rates:** LiteAPI (lat/long search, free core endpoints) if adding a card is acceptable.
- Matching Places/Foursquare hotels to Xotelo keys requires name+coordinate fuzzy matching.

### Sources
- Amadeus shutdown: https://www.phocuswire.com/amadeus-shut-down-self-service-apis-portal-developers ; https://airlabs.co/amadeus-self-service-api-shutdown ; https://ignav.com/docs/amadeus-self-service-shutdown
- LiteAPI: https://docs.liteapi.travel/docs/faq ; https://docs.liteapi.travel/reference/api-pricing-usage-costs ; https://docs.liteapi.travel/docs/getting-a-sandbox-key
- Hotellook closure: https://support.travelpayouts.com/hc/en-us/articles/29534131568530-FAQ-on-the-closure-of-Hotellook
- SerpApi: https://serpapi.com/pricing ; https://serpapi.com/google-hotels-api ; https://serpapi.com/blog/whats-new-at-serpapi-july-2025-changelog/
- Xotelo: https://xotelo.com (+ live calls above)
- Booking Demand: https://developers.booking.com/demand/docs/getting-started/prerequisites ; https://vorplabs.com/agent-tools/booking-demand-api
- Agoda: https://developer.pps.agoda.com/docs/faq
- Expedia: https://www.altexsoft.com/blog/expedia-taap-rapid-api-partner-solutions ; https://dev.to/kouta222/complete-guide-for-individual-developers-recommended-hotel-affiliate-apis-by-region-4c1e
- TripAdvisor: https://www.socialcrawl.dev/blog/best-tripadvisor-data-apis-2026 ; https://tripadvisor-content-api.readme.io
- Hotelbeds: https://developer.hotelbeds.com/documentation/
- TBO: https://www.tboholidays.com/xml_api.htm ; https://www.vervotech.com/hub/regional/hotel-api-india/
- RateHawk: https://docs.emergingtravel.com ; https://blog.ratehawk.com/introducing-the-ratehawk-api-sandbox/
- WebBeds: https://www.webbeds.com/buyers
- DataForSEO: https://dataforseo.com/pricing/business-data/google-hotels-api
- Google Maps pricing: https://developers.google.com/maps/billing-and-pricing/march-2025
- Foursquare: https://foursquare.com/products/pricing/
- Hostelworld: https://partners.hostelworld.com/faqs
- MMT/Goibibo affiliate: https://www.cuelinks.com/blog/best-hotel-stay-affiliate-programs/ ; https://www.vervotech.com/hub/integrations/makemytrip-api/
- Airbnb alternatives: https://apify.com/crawlio/airbnb-listings-scraper
