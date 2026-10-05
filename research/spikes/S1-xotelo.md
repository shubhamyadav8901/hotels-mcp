# Spike S1: Xotelo city keys

Date: 2026-10-05. About 37 Xotelo calls in total, each at least 1.2 s apart, plus 4 Wikidata SPARQL queries.
Raw responses were kept in the session scratchpad only. The repo holds synthetic fixtures only.

## Verdict

- **Wikidata (P3134) does not work for 300 cities.** It has only about 8 usable Indian city or state keys.
- **The key table can be built from Xotelo itself.** Every `/list` item has a TripAdvisor `url`, and that URL
  contains the hotel's most specific geo id: `Hotel_Review-g<geo>-d<id>-Reviews-<Hotel>-<Place_Path>.html`.
  Paging Xotelo's own India-level list (`g293860`) and state-level lists lets a build script collect geo id,
  place name and hotel centroid without fetching any tripadvisor.com page.
  - 4 pages of the India list (400 hotels) gave **211 distinct geos**, from metros down to neighbourhoods
    (Edappally) and villages (Kanoi).
- Sub-city keys work in `/list`. For example, `g16932834` (Edappally, Kochi) returns 57 hotels.
- Option B from PLAN §5 (matching against OSM) is not needed for discovering keys. It is still useful for dedupe.

## 1. Xotelo API facts (docs at xotelo.com plus live tests)

| Item | Finding |
|---|---|
| Endpoints (free) | `/list`, `/rates`, `/heatmap`. **`/search` is RapidAPI-only.** The free call returns `{"error":{"status_code":401,"message":"This endpoint is available only for RapidAPI ..."}}`. There is no free autocomplete or geo search. |
| `/list` params | `location_key` (required), `limit` (default 30, **max 100**), `offset` (min 0), `sort` = `best_value` (default) \| `popularity` \| `distance`. `currency` is **rejected** with `400 currency is invalid`. |
| `/list` prices | `price_ranges.{minimum,maximum}` are **USD** and nightly (for example, Taj Mahal Hotel 265–1558). They are `null` for many unrated or OYO-type listings: 28–43% of the first 100 with `sort=distance`, and 35 of 50 in the Delhi tail. |
| `/list` geo | `geo.latitude/longitude` was present on 100% of the items checked (more than 700). |
| `/list` cap | `total_count` is capped: **10000** for Delhi (offset 10000 returns an empty list) and **3000** for India `g293860`. `total_count` changes with sort (Delhi: 10000 with `best_value`, 9970 with `distance`). |
| `sort=distance` | Distance from TripAdvisor's city centre (Delhi: India Gate / Sunder Nagar first). It is **not** distance from our anchor, because there is no lat/lng param. |
| `key` prefix | `/list` rewrites the `g` part of `key` to the **queried** location (Kerala list gives `g297631-d7339831`). Use the `url` to get the real geo. `/rates` ignores the g part: `g293860-d495582` and `g304551-d495582` give identical rates. Store the `d` id. |
| `/rates` params | `hotel_key`, `chk_in`, `chk_out` (required), `currency` (INR works), `rooms` ≤8, `adults` ≤32, `age_of_children` (CSV). |
| `/rates` shape | `{error:null, result:{chk_in, chk_out, currency, rates:[{code,name,rate,tax}]}, timestamp(ms)}`. `tax` is always `null`, so rates are likely pre-GST. An empty `rates: []` means no offers. |
| Errors | **HTTP 200 every time.** Check the `error` field: `{"status_code":400,"message":"..."}` with `result:null`. Examples: `Invalid location_key`, `limit must be less than or equal to 100`, `chk_out (...) must be greater than chk_in (...)`. An unknown numeric key gives `error:null, total_count:0`. |
| Rate limits | None documented. No rate-limit headers (`cache-control: no-cache`, `x-robots-tag: noindex`). I saw no throttling at about 1 req/s. |
| Latency | `/list`: 0.35–2.0 s (about 1.7–1.9 s per 100-item page). `/rates`: **3.0–7.2 s cold**, 0.35–0.67 s on a repeat key (server-side cache). |

## 2. Wikidata

P3134 values are numeric with no `g`/`d` prefix (Mumbai = `"304554"`). Hotels, attractions and geos share
the same number space, so the original `STRSTARTS(?ta,"g")` filter returns 0 rows. The query below filters by
the India bounding box instead:

```sparql
SELECT ?item ?itemLabel ?ta ?coord ?pop ?typeLabel WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(68.0 6.5)"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(97.5 35.7)"^^geo:wktLiteral .
  }
  ?item wdt:P3134 ?ta .
  OPTIONAL { ?item wdt:P1082 ?pop . }
  OPTIONAL { ?item wdt:P31 ?type . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
```

Results:
- The bounding box holds 404 items with P3134. A variant using `wdt:P17 wd:Q668` gave 373 items, 195 of them
  hotels and most of the rest museums, malls and temples.
- Only **8 usable Indian geo keys** remain: Mumbai 304554, New Delhi 304551, Jaipur 304555, Agra 297683,
  Bengaluru 297628, Chennai 304556, Hyderabad 297586, and Kerala 297631 (a state).
  - Kolkata is missing.
  - 4 further rows (Khotachiwadi, Johari Bazar, Parvati Hill, Agastya lake) carry attraction ids, not geo ids.
- All 7 keys tested work in `/list`:
  - Mumbai: 4393 hotels
  - Jaipur: 4550
  - Agra: 1796
  - Bengaluru: 6914
  - Hyderabad: 4355
  - Chennai: 3678
  - Kerala: 3084

Wikidata can only serve as a cross-check. The sample is in `xotelo_cities_sample.json`, which holds the
12 Wikidata rows and 38 harvested rows (50 rows in total).

## 3. Measurements (Delhi, 2026-11-10 → 11, INR)

**`/list g304551`:**
- 100 items per page.
- `total_count` 10000 (capped), so the full city takes 100 pages.
- lat/lng complete. Every Delhi hotel's URL geo is 304551: TripAdvisor does not split Delhi into neighbourhoods.
- Gurugram (297615) and Noida are separate keys.

**`/rates`:**

| Hotel (d id) | Type | List USD | OTAs (INR) | Latency |
|---|---|---|---|---|
| Smyle Inn (d495582) | budget | 12–30 | Booking 897, Trip.com 1027, Agoda 858, Vio 1808 | 3.0 s |
| Ginger East Delhi (d2178190) | mid | 39–135 | Booking 4299, Trip.com 4999, Agoda 3935, Vio 4999 | 0.35 s |
| OYO Amazing House (d27705237) | OYO | 14–20 | Vio 1800 only | 3.1 s |
| FabHotel CG International (d34039038) | Fab | 15–34 | `rates: []` | 7.2 s |

The OTAs seen are Booking.com (`BookingCom`), Trip.com (`CtripTA`), Agoda and Vio. No Indian OTAs appeared,
and coverage of OYO and Fab properties is thin.

## 4. Recommended strategy

**Build time (`scripts/build-xotelo-cities.ts`, later):**
1. Page `/list?location_key=g293860` with each of the 3 sorts, 30 pages per sort (about 90 calls).
2. Do the same for about 36 state keys. Seed these by hand once from the Xotelo how-to page, which is a manual
   one-off and not runtime scraping. Use up to 30 pages per state (about 1000 calls, roughly 20 min at 1 req/s).
3. Parse the `url` geo id and the place path. The place path is the last `-` segment, for example
   `Kochi_Cochin_Ernakulam_District_Kerala`.
4. For each distinct geo, make one call to `/list?limit=100&sort=distance` to get `total_count` and an approximate
   centre from the median of the first 10 hotels (about 600–900 calls).
5. Write `xotelo_cities.json` with `{key, name, state, lat, lng, hotel_count, parent?}`. Expect 600 to more than
   1000 geos.
6. Refresh the table monthly.

**Runtime:**
1. From the anchor's lat/lng, pick every key whose centre is within `radius_km + 10 km`, at most 3 keys
   (city plus neighbourhood or suburb keys).
2. Page each key's `/list` and filter by haversine distance. Page cost depends on the size of the key:
   - Small towns (under 500 hotels): 1–5 pages, enough to fetch all of them.
   - Metros (Delhi at 10k, Bengaluru at 6.9k): fetching everything needs 50–100 pages, which is too many per
     request. Use one of these instead:
     - (a) A metro index warmed in the background, cached for 7 days and refilled at 1 req/s.
     - (b) Per request, take the first 5 pages with `sort=best_value` (about 10 s) and mark the result partial.
       Prefer neighbourhood keys where TripAdvisor has them (Kochi does, Delhi does not).
3. Call `/rates` only for the top N (≤10) after filtering and dedupe. Each call takes 3–7 s cold, so run them
   with a concurrency of 2–3.

**Cache TTLs:**
- City table: 30 days.
- `/list` pages: 7 days. Hotel set and geo are stable. `price_ranges` is only indicative and is in USD.
- `/rates`: 2–6 h per (d id, dates, adults).
- Empty `rates` results: 1 h.

**Cost per search:**
- Typical town: 1–3 `/list` + ≤10 `/rates`, about 13 calls.
- Metro with a warm cache: 0 `/list` + ≤10 `/rates`.

**Error handling:**
- Always check `error` even when the response is HTTP 200.
- Treat `price_ranges` `null` and `rates: []` as "no price".
- Convert `/list` USD to INR with FX.

## Files

- `research/spikes/xotelo_cities_sample.json`: 12 Wikidata rows and 38 harvested rows.
- `test/fixtures/xotelo-list.json`, `test/fixtures/xotelo-rates.json`: synthetic data in the exact live shapes.
  They include a null `price_ranges`, and a `url` geo that differs from the `key` prefix.
