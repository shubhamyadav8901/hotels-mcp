# 04 — India hotel/stay platform census (who can be reached for free, live)

Researched 2026-10-05. Extends 01 (existing MCPs) and 02 (hotel APIs). Facts already in those reports are not re-checked here; they are referenced as "(01)" or "(02)".
Constraints: free tiers only, live availability/price, India focus, personal/team use.

**Tags.** **[V]** = verified this session on an official site or doc, or by a live call. **[V-live]** = live API/MCP call made this session. **[R]** = reported by a secondary source. **[U]** = unverified or inferred.

**Free live-price "meta paths"** used in the tables below:
- **TV** = trivago official MCP (free, no key). Returns only the cheapest advertiser per hotel.
- **XO** = Xotelo / TripAdvisor meta (free, no key). Returns per-OTA rates.
- **GH** = Google Hotels via SerpApi (250 searches/month free).

No platform in this census offers a free *official* live-rate API to an individual.

---

## 0. Live meta-coverage evidence (this session)

### Xotelo `/rates` (TripAdvisor meta)
Query: Delhi, 2026-11-10→11, INR. TripAdvisor lists 10,000+ properties for Delhi (`total_count` capped) [V-live].

| Property (segment) | Advertisers and INR rate |
|---|---|
| Zostel Delhi (hostel) | Booking 822, Agoda 787, Vio 938, Trip.com 2,490 |
| goSTOPS Delhi (hostel) | Booking 890, Agoda 799, Vio 966, Trip 1,587 |
| The Hosteller Delhi | Booking 909, Agoda 811, Trip 922, Vio 930 |
| Moustache Delhi | Booking 809, Agoda 758, Vio 813, Trip 1,220 |
| Treebo Trend Paras | Booking 2,386, Agoda 2,445, Vio 3,175 |
| FabHotel Aashraye | Booking 3,641, Agoda 3,305, Vio 5,397 |
| Super OYO Chand Palace | Booking 1,266, Agoda 1,538 |
| OYO 572 Amrit Villa | Vio 2,700 only |
| Itsy Connaught Mews | Booking 2,733, Agoda 2,800 |
| Bloomrooms @ NDLS | Trip 4,239, Booking 5,100, Agoda 3,931, Vio 4,800 |
| The Ashok (ITDC) | Booking, Trip, Vio, Agoda all 15,000 |
| Ginger East Delhi (IHCL) | Booking 4,299, Agoda 3,935, Trip 4,999, Vio 4,999 |
| Lemon Tree Delhi Airport | Booking 8,301, Trip 7,736, Agoda 7,321 |

- **No Indian OTA appears in TripAdvisor meta.** None of MMT, Goibibo, Cleartrip, Yatra or EaseMyTrip showed up. The OTA subagent's 40-hotel sample across Delhi, Kolkata, Bengaluru and Hyderabad matched: Booking 33, Agoda 33, Trip 27, Vio 22 [V-live].
- Hostel prices around ₹800 are very likely dorm-bed rates [U].

### trivago MCP (`country=IN, currency=INR`)
- **Rishikesh (25 results):** advertisers seen were Booking.com 19, Agoda 4, MakeMyTrip 1, Trip.com 1. Results included goSTOPS, Itsy by Treebo, Lemon Tree, Clarks Inn Express, Pride and hostels [V-live].
- **Goibibo.com** was the advertiser on a Paharganj (Delhi) hotel [V-live].
- **OTA subagent's 100-hotel sample** (Jaipur, Goa, Rishikesh, Mumbai), counting the cheapest advertiser: Booking 74, Agoda 13, MakeMyTrip 7, Trip 2, plus chain sites [V-live].
- trivago shows only the cheapest advertiser, so Cleartrip, Yatra and EaseMyTrip may be present but never cheapest [U].
- Text queries for a POI ("Varanasi Junction railway station", "Paharganj") returned **only 1 hotel**. For station-centric search, use `trivago-accommodation-radius-search` with coordinates [V-live].

### Google Hotels
- Skift's scrape of about 600 Indian listings: MMT appeared in 52% and Booking.com in about 60%; Agoda, Expedia and Trip.com were also present [R].
- **Google Hotels is the only free meta path where MMT shows up consistently.**
- Not verified: whether Goibibo, Cleartrip, Yatra and EaseMyTrip appear. One SerpApi call with `gl=in` would settle it.

---

## 1. OTAs and meta-search

| Platform | Category | India coverage | Public API | Affiliate / partner (individuals?) | MCP | Free live-price path | Geo | ToS / notes |
|---|---|---|---|---|---|---|---|---|
| MakeMyTrip | OTA, #1 in India (~60% share [R]) | Deepest domestic; 100k+ properties [R] | No [U] | Cuelinks/vCommission/INRDeals links; individuals accepted, a site is usually needed [R]. INRDeals "Super Affiliate" API access is claimed [R] | ChatGPT app [R]; no public MCP endpoint (guessed `mcp.` hosts fail) [V] | **TV** (as advertiser) [V-live]; **GH** (52% of listings) [R]. Not in XO [V-live] | Via meta | Akamai bot protection; do not scrape |
| Goibibo | OTA (MMT group) | Same supply as MMT [R] | No | Same networks as MMT [R] | No | **TV** (seen once) [V-live]; GH [U]. Not in XO [V-live] | Via meta | Powers PhonePe hotels [R] |
| Cleartrip (Flipkart) | OTA | Good [R] | No public data API | Historic affiliate [U] | **`https://mcp.cleartrip.com/mcp` is live.** OAuth 2.1 with dynamic client registration + PKCE; returns 401 without a token [V-live]. Tools not inspected; no announcement found | **NEW:** may work as a Claude custom connector after a free Cleartrip login [U]. Not in TV/XO samples | Unknown | Read Cleartrip's ToS before automating. Bright Data's paid "Cleartrip MCP" is a scraper [R] |
| Yatra (+ Travelguru) | OTA | Good | No | B2B / affiliate [U] | No | GH [U]; not in TV/XO samples [V-live] | — | travelguru.com 301-redirects to yatra.com [V] |
| EaseMyTrip | OTA | Mid | No (only reseller SEO pages) [U] | Affiliate networks [U] | ChatGPT app (NSE press release, 2 Apr 2026) [R] | GH [U] | — | |
| ixigo | OTA / meta | Hotels via partners [R] | No | No | ChatGPT apps (ixigo, AbhiBus, ConfirmTkt), 29 Apr 2026 [R]; mcp.ixigo.com → 404 [V] | None of its own | — | |
| Paytm Travel | Super-app | Hotels white-labelled from **Agoda** since Feb 2025 [R] | No | No | No | Same as Agoda (TV/XO) | — | paytm.com/hotels redirects to home [V] |
| Amazon Pay / Flipkart / PhonePe | Super-apps | Hotels from MMT / Cleartrip / Goibibo respectively [R] | No | — | No | Same as the underlying OTA | — | No independent inventory |
| Tata Neu / Swiggy / Zomato / Ola / Rapido | Super-apps | Tata Neu sells IHCL hotels [U]; the others have no hotel vertical [U] | No | — | No | None (IHCL via meta) | — | |
| Booking.com | Global OTA | Very large in India, incl. homes | Demand API partner-only (02) | Affiliate needs a site; no API | **Official remote MCP (`demandapi-mcp.booking.com`), partners only** [V docs]; ChatGPT app [R] | **TV** (dominant), **XO**, **GH** [V-live] | Via meta | Partner terms restrict AI use (02) |
| Agoda | Global OTA | Very strong in India, incl. budget and homestays | API case-by-case (02) | Self-serve affiliate [R] | Generic open-source `api-agent`, not hotel data [R]; agoda-review-mcp (reviews only) [R] | **TV, XO, GH** [V-live] | Via meta | |
| Expedia / Hotels.com / Vrbo | Global OTA | Moderate in India | Rapid partner-only (02) | Expedia affiliate needs a site [U] | ChatGPT app; expedia.com/mcp returns 403 (01) | GH [R]; not in TV/XO samples [V-live] | — | Vrbo is weak in India and has left Google Vacation Rentals [R] |
| Trip.com | Global OTA | Good | Affiliate data feed for approved affiliates [R] | Self-serve affiliate [R] | `/.well-known/ai-plugin.json` exists but its OpenAPI spec returns 404 (dead) [V] | **XO, TV** [V-live] | Via meta | Has llms.txt [V] |
| trivago | Meta | Strong | Official MCP | — | **Yes, free** [V-live] | Primary path | lat/lng in and out [V-live] | Strip the injected `system_message` (01) |
| Google Hotels | Meta | Strongest in India | Travel Partner API is supply-side only [R] | — | No | **GH** via SerpApi, 250/month (02) | `gps_coordinates` | |
| Tripadvisor | Meta / reviews | Deep | Content API 5k free calls/month, no prices [V]; sunset 31 Aug 2026, replaced by **Terra API** (~1k free calls) [R; docs live V] | CJ affiliate | Community MCPs (01) | **XO** (unofficial) | Yes | Plan the migration from the Content API to Terra |
| Kayak / HotelsCombined / Momondo | Meta | Weak in India [U] | Affiliate APIs by application [R] | Business application | mcp.kayak.com → homepage [V] | None free | — | |
| Skyscanner (hotels) | Meta | Weak in India | Gated to large partners [R] | CJ/Impact [R] | ChatGPT app [R] | None free | — | |
| Wego | Meta (APAC) | wego.co.in is live [V] | API by email request [R] | Admitad (link-only) [R] | ChatGPT app [R] | None free | — | |
| Vio.com | Meta | Moderate | No | Affiliate [U] | No | Appears **in XO** [V-live] | — | |
| bluepillow | Meta | Some | MCP (01) | — | Yes | Prices weak in India (01) | lat/lon/radius | |
| Via.com | OTA (Ebix) | Small | No | No | No | None | — | Site live [V]; Ebix in Ch.11, India unit for sale [R] |
| HappyEasyGo | OTA | Mostly flights | No | Admitad program closed [R] | No | None | — | Treat as defunct for hotels |
| Akbar Travels | OTA / B2B | Small hotel share | B2B only [U] | Agents only | No | None | — | |
| FareEagle | Indian OTA | — | — | — | MCP, free, INR (01) | Its own MCP (01) | No | Covered in 01 |

---

## 2. Budget / branded chains and aggregators

| Platform | Category | India coverage | Public API | Affiliate (individuals?) | MCP | Free live-price path | Geo | ToS / notes |
|---|---|---|---|---|---|---|---|---|
| OYO (incl. Townhouse, Collection O, Super OYO, Capital O) | Budget aggregator | ~14.9k India storefronts (DRHP, Dec 2025) [R] | Supply-partner API only (02) | Travelpayouts / Cuelinks, links only [R] | No | **XO** via Booking/Agoda/Vio [V-live]. robots.txt allows `Google-HotelAdsVerifier`, so own-site rates very likely reach **GH** [V robots] | Via meta | robots.txt allows `/api/search/hotels` (internal JSON; not probed) [V]. Many OYO listings have thin meta coverage (e.g. one advertiser) [V-live] |
| Treebo / Itsy | Budget/mid chain | ~800 hotels [R]; now majority Accor + InterGlobe [R] | No | Cuelinks/Indoleads CPS [R] | No | **XO** (Booking/Agoda/Vio) [V-live]; robots allows the hotel-ads verifier, so likely **GH** [V]; `/tripadvisor/*` landing path also suggests TripAdvisor meta [V] | Via meta | robots blocks `/api/` [V]. itsyhotels.com has llms.txt [V] |
| FabHotels | Budget franchise | ~1.3–1.5k properties [R] | No | Cuelinks (CPS paused) [R] | No | **XO** (Booking/Agoda/Vio) [V-live] | Via meta | robots blocks `/mapi/` [V] |
| IHCL (Taj, Vivanta, Gateway, SeleQtions, Ginger, Tree of Life, Brij; majority of Clarks) | Luxury → economy | 645 signed / 382 operating; Ginger 166 [R, IHCL IR] | No | Taj via AffiliRed [R] | No | **XO/TV** (Ginger and Clarks seen) [V-live]; own-site rate in GH [U] | Via meta | tajhotels.com returns Akamai "Access Denied" even for robots.txt [V] |
| ITC Hotels (incl. Fortune, WelcomHeritage, Storii, Mementos) | Luxury → mid | 140+ hotels [V, llms.txt] | No | — | No | Meta [U] | **schema.org `GeoCoordinates` on hotel pages** [V] | llms.txt invites AI use; robots allows GPTBot [V] |
| Lemon Tree (Red Fox, Keys) | Mid / economy | 131 operating, 269 total [R] | No | FlexOffers [R] | No | **XO/TV** [V-live] | Via meta | |
| Oberoi / Trident | Luxury | ~30 [U] | No | No | No | Meta [U] | — | robots explicitly allows LLM crawlers [V] |
| Sterling Holidays | Leisure resorts | 78 resorts [R] | No | — | No | Via OTAs → meta [R] | — | |
| Club Mahindra | Timeshare | 100+ [U] | No | CPL leads [R] | No | **None** (members only) | — | Out of scope |
| Royal Orchid / Regenta, Sarovar (Louvre), Pride, Sayaji, Mango, Bloom (Bloomrooms), Neemrana, Keys, Clarks, Hotel Brij | Mid / upscale / heritage | 10–250 each [R/U] | No | Mostly none | No | Via OTAs → **TV/XO** (Pride, Clarks, Bloom seen) [V-live] | Via meta | Bloomrooms @ NDLS is a station-adjacent budget option [V-live] |
| Marriott, Hilton, IHG, Accor, Radisson, Wyndham, Hyatt (India) | International chains | ~50–200 each in India [R] | Accor's developer.accor.com has Rates/Inventory/Properties (GPS) APIs, **partner + certification only** [V/R]. The others have none | Network affiliates (links) | **ChatGPT apps** from Accor, IHG, Radisson, Wyndham and Hyatt; Marriott "Ask Bonvoy"; **Hilton Claude connector announced 28 Aug 2026** [R]. No public MCP endpoints | Official-site rates in **GH**, and chain sites appear in TV/XO [V-live] | Via meta | Watch for the Hilton Claude connector. `markswendsen-code/mcp-hilton` uses browser automation (ToS risk) [R] |
| Lighthouse / The Hotels Network "Connect AI" | Direct-rate MCP layer | Opt-in hotels worldwide [R] | No | — | MCP-based ChatGPT app [R] | ChatGPT only [U] | — | |

---

## 3. Homestays / villas / hostels / alternative stays

| Platform | Category | India coverage | Public API | Affiliate | MCP | Free live-price path | Geo | ToS / notes |
|---|---|---|---|---|---|---|---|---|
| Airbnb | P2P homes | ~165k active India listings (PriceLabs, all platforms) [R] | No (02) | Closed | openbnb-org scraper (01) | Self-hosted openbnb (ToS risk). **Not on Google Vacation Rentals** [R] | Approximate | |
| StayVista (formerly Vista Rooms) | Managed villas | 1,000+ villas [R] | No | Coupon networks [R] | No | Listed on **Airbnb, Booking, MMT, Goibibo** [R], so **TV/XO/GH** plus openbnb | Via OTA | |
| SaffronStays | Managed villas | 450+ homes [V] | No [V] | No [V] | No | **Airbnb Luxe** and Marriott Homes & Villas [V] → openbnb | Via Airbnb | Mostly direct sales [V] |
| Isprava / Lohono | Luxury villas | 100+ in India [R] | No | No | No | Airbnb Luxe [R] → openbnb | Via Airbnb | |
| Elivaas (+ Alaya) | Managed villas/apartments | 660+ [R] | No | No | No | MMT partner [R] → GH/TV | Via OTA | |
| Zostel / Zostel Plus / Zostel Homes (Zo World) | Hostels / homestays | ~95–100 properties [R] | No; site behind AWS WAF CAPTCHA [V] | INRDeals CPS; "Super Affiliate" API claimed [R] | No | **XO** (Booking/Agoda/Trip/Vio) [V-live] | Via meta | Automated access to its site is hostile [V] |
| goSTOPS | Hostels | 30+ [R] | No | No | No | **XO + TV** [V-live] | Via meta | |
| The Hosteller | Hostels | 25+ [V] | Own booking engine only [V] | No [V] | No | **XO** [V-live] | Via meta | |
| Moustache | Hostels | ~20 [R] | No | No | No | **XO** [V-live]; also on Hostelworld [R] | Via meta | |
| Madpackers, Backpacker Panda | Hostels | Small [R] | No | No | No | Booking/Hostelworld listings → TV/XO [R/U] | Via meta | |
| Hostelworld | Hostel OTA | Strong for hostels [R] | Partner API case-by-case (02) | Partnerize | None found [R] | **None free** (not seen as a TV/XO advertiser) | — | |
| Hostelz.com | Hostel directory + price comparison | Chain pages for Zostel, Moustache [R] | No | — | No | None (returns 403) [V] | — | NEW, not usable |
| Vrbo | VR | Weak in India [U] | Rapid (partners) | Networks | No | None | — | |
| Government homestay registries: NIDHI+ (Incredible India B&B / rural), Kerala approved list, Himachal (homestay.hp.gov.in), Uttarakhand "Uttarastays" | Registries | Thousands (UP 955, WB 570 on NIDHI+ …) [R] | No; data.gov.in has state counts only [R/V] | n/a | No | **None** (no prices or availability) | Some per-property pages [U] | Static POI layer at best; the Uttarastays domain is unconfirmed [V] |
| Fusionstays (WB/Sikkim) | Private homestay aggregator | Regional [R] | No | — | No | None known | — | NEW |
| Unhotel, WanderOn (trips, not stays), StayZilla (defunct 2017), LoharTravel, Hopping, Tripoto stays, Stayfinder, Homestays of India | — | Niche, defunct or not lodging [R/U] | — | — | — | None | — | Skip |

**Takeaway.** No Indian villa or hostel brand offers an API. Branded hostels are well covered by XO and TV through Booking and Agoda. Luxury villas sit mostly on Airbnb (Luxe), so the only path is a scrape via openbnb. Independent homestays not listed on Booking, Agoda or Airbnb cannot be reached.

---

## 4. Government / rail / pilgrim / eco stays

| Platform | Category | Coverage | Public API | Partner | MCP | Free live path | Geo | ToS / notes |
|---|---|---|---|---|---|---|---|---|
| **IRCTC Retiring Rooms** (`www.rr.irctc.co.in`) | Rooms / dorms / pods at stations | **356 stations** (managedBy: Railway 287, IRCTC 68, both 1) [V] | **Station list only:** unauthenticated JSON at `RetServcV2/rrservice/listOfStations` [V] | No | No | **None.** Availability needs login + confirmed/RAC PNR + AES-encrypted payload [V JS bundle] | None in the data; join on station code with OSM `railway=station` `ref` tags | IRCTC bans automated access [R]. See §4.1 |
| retiringroom.com | Unofficial retiring-room directory | ~160 station pages [V] | No | — | No | Static price bands only | No | robots `Allow: /` [V]. NEW |
| IRCTC Hotels (`hotels.irctc.co.in`) | Generic hotel aggregator | — | No | — | No | Login to book [V]; adds nothing over TV/GH | — | |
| IRCTC Executive Lounges; FreshUp hourly rooms; pods (Mumbai Central 48 pods ₹999/12h; Bhopal) | Station amenities | ~49 lounges planned [R] | No (FreshUp centre list returns 403) [V] | — | No | None | — | Pods are booked on the same rr portal [V] |
| Rail Yatri Niwas, New Delhi | Former IRCTC hotel | — | — | — | — | Now Ginger under PPP [R] → TV/XO | Via meta | |
| HPTDC | State TDC | 56 hotels [R] | No; publishes llms.txt [V] | Listed on MMT [R] | No | **GH/TV via MMT** [R] | Via OTA | Best-covered TDC |
| KTDC | State TDC | ~30 [V] | No | — | No | Some on Expedia → GH [R]; booking.ktdcbooking.com | Address | |
| MP Tourism (MPT) | State TDC | ~70 [R] | No | — | No | Some on Trip.com/Cleartrip → XO [R] | Via OTA | robots allows [V] |
| Telangana TGTDC | State TDC | ~30 [U] | No, but a **public search URL with dates** exists [V] | — | No | Deep link | — | NEW deep-link template |
| KMVN (Uttarakhand) | State TDC | ~50 rest houses [V] | No | — | No | Public "from ₹X" pages per district [V]; login to book | — | |
| GMVN (Uttarakhand) | State TDC | 90+ rest houses (incl. Char Dham) [R] | No | — | No | Deep link only; Cloudflare challenge [V] | — | Also listed on YatraDham [V] |
| RTDC | State TDC | ~40 [U] | No | **States it has no OTA tie-ups** [V] | No | Portal only | — | |
| MTDC, KSTDC, TTDC, APTDC, WBTDCL, UPSTDC, JKTDC, OTDC (bookodisha), TCGL, GTDC, Sikkim, Punjab, Assam | State TDCs | ~10–50 each [U] | No | No | No | Portal only (some need login) | Address | GTDC returns 400 [V]; assamtourismonline.com is now spam, the real site is assamtourism.gov.in [V] |
| ITDC / Ashok Group | Central PSU | ~7 hotels [R] | No | — | No | **XO** (The Ashok: Booking/Agoda/Trip/Vio) [V-live] | Via meta | theashokgroup.com → itdc.co.in [V] |
| Jungle Lodges & Resorts (Karnataka) | Eco lodges | ~30 [U] | Booking engine is RMS Cloud with a **public availability page** [V]; RMS API is paid [U] | Agent signup | No | Public RMS page (no API); Kabini on Trip.com → XO [R] | — | WAF in front |
| HP PWD rest houses (himatithi.nic.in), forest rest houses (MP / Maharashtra / Kerala / HP eco-tourism) | Govt rest houses | Dozens each [R/U] | No | — | No | Portal + Aadhaar; several timed out [V] | — | Unreachable |
| YatraDham.org | Dharamshala / pilgrim aggregator | ~4,450 property pages [V] | No public API; internal AJAX needs a session [V] | Claims ties to state tourism departments [V] | No | **Public pages with schema.org JSON-LD "from" price** (not date-specific) [V] | Address only (geocode it) | robots allows property pages, blocks search/reservation [V]. NEW, most useful pilgrim source |
| TTD Tirupati, Shirdi SSST, Vaishno Devi SB, Kashi, BKTC, Puri, SGPC, ISKCON | Temple trusts | Thousands of rooms (TTD) [R] | No | Shirdi authorises no agents [V] | No | **None.** Login + OTP/Aadhaar; SGPC online booking suspended [V]; Kashi site erroring [V]. Somnath has a public search without login [V] | No | Many fraudulent clone sites |
| NIDHI+ (Ministry of Tourism), data.gov.in OGD | Registries | National | Undocumented `/api/KeyValues/states_cities` endpoint; OGD has aggregate statistics only [V] | — | No | None | — | No property-level geo found |

### 4.1 IRCTC Retiring Rooms — design notes (high relevance: train-arrival planning)

**Portal:** `https://www.rr.irctc.co.in`. The old `rr.irctctourism.com` returns NXDOMAIN [V].

**Booking flow** [V, portal FAQ and T&C]:
1. Log in, or use guest login with OTP.
2. Enter a 10-digit PNR. It must be **Confirmed or RAC**; waitlisted tickets are refused. A UTS (unreserved) path exists at a few stations.
3. Choose a station: boarding, destination or nearby.
4. Choose a room type: Single, Double or Dorm, each AC or non-AC.
5. Choose a slot: **3 h minimum, 48 h maximum**; hourly slots only at a few stations.
6. Check availability, then pay.

**Rules** [V]:
- Late check-in is allowed up to 1 h after the train arrives.
- If the ticket is cancelled, the room is cancelled automatically.
- **IRCTC service charge:** ₹20 per room / ₹10 per bed up to 24 h; ₹40 / ₹20 for 24–48 h.
- **Cancellation charges** (portal text): 20% at 2 or more days ahead, 50% at 1 day ahead, 100% on the same day.
- **Advance booking window:** the FAQ says 120 days. The rail advance-reservation period changed to 60 days in Nov 2024, so 120 is likely stale [R].

**Prices** [R]:
- Dorm about ₹150–400; AC double about ₹1,200–2,500 per 24 h.
- Sealdah tariff (Aug 2025): dorm ₹572 (12 h) / ₹908 (24 h); suites ₹1,704–3,384 including GST.

**Programmatic access:**
- Only `listOfStations` is public: 356 stations with code, name, email, contact and operator [V].
- `checkAvailability` and `pnrSearchV2` sit behind a login token, need a real PNR, and use payloads AES-encrypted on the client [V].
- **Do not automate.** IRCTC ToS bans bots, and IRCTC purged about 3 crore suspect IDs in 2025 [R].
- No GitHub or MCP project for this was found, and no OTA or Google Hotels listing of retiring rooms [R].
- 14 PPP-operated retiring-room sites are still booked via the same portal [R].

**MCP design (registry plus deep links, no live check):**
- `retiring_rooms_at(station_code)`: reads a cached copy of `listOfStations`, refreshed weekly, and joins station coordinates from the local OSM station table.
- `plan_station_stay(...)`: checks eligibility (confirmed/RAC ticket, stay of 3–48 h). It uses the user-supplied arrival time and returns:
  - indicative tariff bands (zonal PDFs / retiringroom.com);
  - the deep link to rr.irctc.co.in;
  - alternatives from TV/XO radius search near the station (e.g. Bloomrooms @ NDLS).

---

## 5. B2B / channel managers / bed banks (as data sources)

| Vendor | Category | India coverage | Public API | Partner (individuals?) | MCP | Free live-price path | Geo | ToS / notes |
|---|---|---|---|---|---|---|---|---|
| TBO | Bed bank | Very large in India | XML API, contact form [V] | Agents/OTAs only | None found | None | [U] | Not a Google connectivity partner (GCP) [V] |
| GRNconnect (Delhi) | Bed bank | 500k hotels worldwide [R] | REST/JSON after agent registration [R] | Business only | No | None | — | NEW |
| Tripjack, TravClan, Riya, Musafir, Via B2B, Akbar B2B, Cleartrip B2B, RezLive, Stuba, Jumbo | B2B wholesalers | Strong for domestic India [R] | Onboarding + certification [R] | Registered agents only | No | None | — | |
| SiteMinder (Channels Plus) | Channel manager / distribution | India presence [U] | **REST: lat/long property search, live rates and availability** [V] | **Active partnership agreement required** [V]. Shared preprod credentials return **test data only** [V] | **Official MCP (beta, Apr 2026)**; credentials issued at partner onboarding [V] | None (prod is partner-only) | Yes [V] | NEW; worth watching. On GCP [V] |
| RateGain (UNO/RezGain) | CRS / booking engine | Large in India [U] | Partner-only | No | **Per-hotel booking-engine MCP** (Sep 2025) [R] | Only if a specific hotel exposes it [U] | — | NEW |
| eZee / Yanolja Cloud | PMS / channel manager / booking engine | Very large Indian SMB base [R] | Booking-engine JSON API, **per-hotel HotelCode + AuthCode** [R] | Hotel-provisioned | No | None without a hotel key | — | eZee Absolute on GCP [V] |
| Djubo | PMS / channel manager | India [V] | Partner-only REST, says so explicitly [V] | No | No | Via GH | — | On GCP [V] |
| AxisRooms | Channel manager | 4k+ hotels, mostly India [R] | Inbound rate-push API docs only [R] | No | No | Via GH | — | On GCP [V] |
| STAAH, Bookingjini, ResAvenue, Simplotel, Hotelzify, MaxiMojo, aiosell, Asiatech, eGlobe, HotelRunner, Cloudbeds, Sabre SynXis, Amadeus iHotelier | Channel managers / booking engines / CRS | Indian SMB → chains | Partner-only, or per-property keys (Cloudbeds) | No | Cloudbeds has third-party per-account MCPs only (Truto, MCPBundles) [R] | **Via GH** (all on GCP) [V] | — | |
| Hotelogix, IDS Next, Mews | PMS | India (Hotelogix, IDS) | Partner; Mews demo environment only [V] | No | `code-rabi/mews-mcp` (unofficial, demo data) [V] | None (not on GCP) [V] | — | |

**Key point** [V]: most Indian channel managers are **Google Hotels connectivity partners**. Small independent hotels using STAAH, eZee, AxisRooms, Djubo and similar tools can therefore push direct rates as Google free booking links. **GH (SerpApi) is the only free path to that direct-rate inventory.** Being on the list does not mean every hotel using the vendor is connected. Source: https://developers.google.com/hotels/connectivity-partners

---

## 6. Synthesis

### Reachable live prices for free

| Free path | What it reaches |
|---|---|
| **XO** (Xotelo / TripAdvisor meta) | Booking.com, Agoda, Trip.com and Vio rates for almost every OTA-listed property: budget chains (Treebo, FabHotels, Itsy, OYO with thin coverage), branded hostels (Zostel, goSTOPS, Hosteller, Moustache), mid/upscale chains, ITDC. **No Indian OTAs.** |
| **TV** (trivago MCP) | The same OTA-listed universe, plus **MakeMyTrip and Goibibo** as advertisers (cheapest advertiser only). Radius search by coordinates. |
| **GH** (SerpApi, 250/month) | Best for MMT (52% of listings) and for direct / official-site rates, including independents connected via Indian channel managers and OYO/Treebo own-site rates (inferred from robots.txt). |
| **openbnb** (self-hosted scraper; ToS risk) | Airbnb, including StayVista, SaffronStays (Luxe) and Lohono. |
| **Cleartrip MCP** (NEW, OAuth) | Possibly Cleartrip's own inventory, if a personal Cleartrip login is accepted. **Untested.** |
| **FareEagle MCP** (01) | Indian-OTA INR prices by city. |

### Unreachable segments (no free live path)
- IRCTC retiring rooms, pods and lounges.
- Most state TDC properties (RTDC, GMVN, MTDC, TTDC …). The exceptions are HPTDC, some KTDC and MPT, and Jungle Lodges' Kabini, which appear via OTAs.
- Temple-trust and dharamshala rooms. YatraDham gives static "from" prices only.
- PWD, forest and circuit rest houses.
- Club Mahindra and other timeshares.
- Independents sold only on MMT/Goibibo, unless they surface in GH or TV.
- Hostelworld-only hostels.
- Unlisted homestays (government registries list them but carry no prices).
- B2B net rates (TBO, GRN, Tripjack …).
- Direct-only luxury villas.

### New sources not in 01 or 02
- **IRCTC retiring rooms:**
  - portal `rr.irctc.co.in` with a public `listOfStations` JSON (356 stations);
  - retiringroom.com price bands;
  - zonal tariff PDFs.
- **Cleartrip's official MCP**, `mcp.cleartrip.com/mcp` (OAuth with dynamic client registration).
- **SiteMinder Channels Plus API + official MCP** (partner-only; lat/long + live rates).
- **RateGain per-hotel booking-engine MCP.**
- **Hilton Claude connector** (announced).
- **Chain ChatGPT apps** (Accor, IHG, Radisson, Wyndham, Hyatt) and MMT / EaseMyTrip / ixigo ChatGPT apps; none has a public endpoint.
- **Accor developer portal** (partner-only).
- **Google Hotels connectivity-partner list**, which shows Indian channel managers feed GH.
- **YatraDham.org** dharamshala pages with JSON-LD prices.
- **Telangana TDC** dated deep-link URL template.
- **Jungle Lodges RMS** public availability page.
- **ITC Hotels** schema.org GeoCoordinates and llms.txt; HPTDC llms.txt.
- **robots.txt evidence:** OYO and Treebo allow the Google hotel-ads verifier crawler.
- **Tripadvisor Terra API** (Content API successor).
- **INRDeals "Super Affiliate"** API claims for MMT and Zostel.
- **Hostelz.com**, Fusionstays, NIDHI+.

### Open checks (cheap to settle later)
1. One SerpApi `google_hotels` call with `gl=in`, to see which Indian OTAs and direct links appear.
2. Inspect the Cleartrip MCP tools after a personal OAuth login.
3. Confirm the retiring-room advance window (120 vs 60 days).

## Sources (selected; full lists in the subagent notes)
- **Google Hotels connectivity partners:** https://developers.google.com/hotels/connectivity-partners
- **IRCTC retiring rooms:**
  - https://www.rr.irctc.co.in/ (station list at /stationList)
  - Sealdah tariff PDF: https://er.indianrailways.gov.in/cris//uploads/files/1756190135170-Retiring%20Room%20&%20Dormitories.pdf%2026.08.pdf
  - https://retiringroom.com/
- **YatraDham:** https://yatradham.org/
- **RTDC** (no OTA tie-ups): https://rtdc.tourism.rajasthan.gov.in/Client/HotelList.aspx
- **Telangana TDC:** https://tourism.telangana.gov.in/hotel-list
- **HPTDC llms.txt:** https://hptdc.hp.gov.in/llms.txt
- **Jungle Lodges RMS page:** https://betabookings8.rmscloud.com/Search/Index/15342/71/?Y=1
- **SiteMinder Channels Plus:**
  - https://developer.siteminder.com/channels-plus-api/guides/quick-start
  - https://developer.siteminder.com/channels-plus-api/mcp-server/overview
- **Booking.com MCP:** https://developers.booking.com/mcp-server/docs/about
- **Cleartrip MCP OAuth metadata:** https://mcp.cleartrip.com/.well-known/oauth-protected-resource/mcp
- **Skift on MMT in Google Hotels:** https://skift.com/2025/01/09/makemytrip-dominates-travel-search-in-india-can-it-hold-on-to-its-lead/
- **Tripadvisor:**
  - Content API FAQ: https://tripadvisor-content-api.readme.io/reference/faq
  - Terra docs: https://docs.terra.tripadvisor.com/docs/overview
- **Chains:**
  - OYO robots.txt: https://www.oyorooms.com/robots.txt
  - Treebo robots.txt: https://www.treebo.com/robots.txt
  - ITC llms.txt: https://www.itchotels.com/llms.txt
  - Accor Hotel Rates API: https://developer.accor.com/api-portfolio/hotel-rates/hotel-rates
  - Hilton Claude connector: https://www.hospitalitynet.org/news/4134143
- **Booking engines / PMS:**
  - RateGain MCP: https://www.hospitalitynet.org/news/4128741
  - Djubo: https://djubo.com/api-docs
  - Mews: https://docs.mews.com/booking-engine-guide/booking-engine-api/guidelines/authentication.md
- **Affiliates and homestays:**
  - INRDeals Zostel: https://inrdeals.com/campaigns/zostel-affiliate-program
  - SaffronStays: https://www.saffronstays.com/
  - PriceLabs India market data: https://hello.pricelabs.co/market-data/india
- **Paytm × Agoda:** https://www.angelone.in/news/paytm-partners-with-agoda-to-launch-hotel-booking-services
- **Indian OTA ChatGPT apps:**
  - EaseMyTrip: https://nsearchives.nseindia.com/corporate/EASEMYTRIP_02042026204305_pr_signed.pdf
  - ixigo: https://nsearchives.nseindia.com/corporate/IXIGO_29042026113329_Announcement_Press_Release_ixigo_ChatGPT_29042026.pdf
