# S2: upstream MCP servers (trivago, HotelsCasa)

I captured this on 2026-10-05 (IST) with `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport` from a throwaway script. Neither server needed auth. I called no booking, payment or cancel tool.
The test query: New Delhi Railway Station 28.6430,77.2194, check-in 2026-11-10, check-out 2026-11-11, 2 adults.
Synthetic fixtures: `test/fixtures/trivago-radius-search.json`, `trivago-validation-error.json`, `hotelscasa-search.json`, `hotelscasa-get-hotel.json`, `hotelscasa-get-hotel-not-found.json`. Their field names and nesting match the live responses; a script checked the key sets against the real payloads.

## 1. Servers and tools

### trivago: `https://mcp.trivago.com/mcp`
The server identifies as `trivago Accommodation Search` v0.5.0. Capabilities: `logging`, `resources`, `tools.listChanged`. It sends no `instructions`.

| Tool | Annotations | Allow-list? |
|---|---|---|
| `trivago-accommodation-radius-search` | readOnly, !destructive, !idempotent, openWorld:false | **Yes** (primary) |
| `trivago-accommodation-search` | same | **Yes** (fallback: `query` = name or place) |
| `trivago-destination-price-trends` | same | Optional (monthly forecasts by star rating, 3–5★ only). Not needed for v1 |

**Radius-search input** (required: `latitude`, `longitude`, `arrival`, `departure`):
- `adults` (number ≥1), `children` (number), `children_ages` ("10-12-14", dash-separated), `rooms` (≥1, ≤ adults).
- `country` enum (includes `IN`, default `US`), `currency` enum (includes `INR`, default `USD`), `language` enum (includes `EN_IN`, default `EN_US`).
- `filters` {airConditioning, breakfastIncluded, freeCancellation, freeWiFi, gym, kitchen, parking, petFriendly, pool, spa: bool}.
- `hotel_rating` {"1star".."5star": bool}.
- `review_rating` {rating70, rating75, rating80, rating85: bool}.
- **The tool has no radius, sort, price filter, limit or page parameter.**

`trivago-accommodation-search` takes the same input, with `query` (string) in place of lat/lng.
`price-trends` takes `query` (a name or `"lat:<lat>,long:<lng>"`), plus `start_month`/`end_month` (YYYY-MM), `hotel_rating` {3star,4star,5star}, country, currency and language.

All three tools declare an `outputSchema`. Its property descriptions contain prompt text, for example "Display each one as a separate visual card…" and "MANDATORY formatting instructions".

### HotelsCasa: `https://mcp.hotelscasa.com/mcp`
The server identifies as `hotelscasa-mcp` v2.0.0 (title "HotelsCasa"). It exposes 13 tools. **Every tool is annotated readOnlyHint:true, including the commerce ones,** so the annotations cannot be trusted for allow-listing. Its `instructions` field also contains marketing and "show url verbatim" prompting.

| Tool | Allow-list? |
|---|---|
| `search_hotels` | **Yes** |
| `get_hotel` | **Yes** (detail + live availability for the dates) |
| `search_activities`, `get_activity`, `find_flights`, `book_ground_transport`, `partner_with_hotelscasa`, `search_properties`, `get_property`, `check_availability`, `search_vehicles`, `get_vehicle`, `check_vehicle_availability` | No (out of scope or commerce lead-gen; `book_*` never) |

**`search_hotels` input** (`additionalProperties:false`, nothing required):
- Location: `lat`, `lng`, `radius_km` (default 10, max 50); or `city`/`country`/`query`.
- Stay: `check_in`, `check_out` (YYYY-MM-DD), `adults` (int 1–8), `children` (0–4), `children_ages` ("4,9"), `rooms` (1–4).
- Filters: `stars_min` (1–5), `type` enum (apartamentos…), `price_min`/`price_max` (EUR per night), `nationality` (ISO-2).
- Paging and output: `sort` (recommended|price|rating), `page` (1–5), `limit` (1–10, default 10), `lang` (es|en|de|fr|it|pt|tr|ru, **default es**).

**`get_hotel` input**: `hotel_key` (required), plus `check_in`, `check_out`, `adults`, `children`, `children_ages`, `nationality` and `lang`.

## 2. Response shapes

### trivago `trivago-accommodation-radius-search`
`CallToolResult` = `{ content[], structuredContent }`. The response has **no `isError`**, even when validation fails.
- `content[0]` is text: a preamble ("IMPORTANT: Read the "system_message"…"), then a pretty-printed JSON `{ output: "<JSON-string of the accommodations array>", system_message: "<…>" }`. The data is double-encoded. **Ignore this block.**
- `content[1]` is text: "The accommodation photos follow as image content…".
- Then a pair per photo: `{type:"text", text:"Photo of <name> (accommodation_id: <id>)"}`, then `{type:"image", mimeType:"image/webp", data:<base64 30–163 KB>}`. The live call returned **7 images for 25 hotels**.
- `structuredContent` = `{ system_message: string, accommodations: Accommodation[] }`. On error it is `{ validation_errors: [{message, argument, value}] }` or `{ error }`.

Field paths, all under `structuredContent.accommodations[i]`. Every field is required and present.

| Need | Path | Notes |
|---|---|---|
| id | `accommodation_id` | 12-hex string, e.g. `22315d0fbce7` |
| name | `accommodation_name` | |
| lat/lng | `latitude`, `longitude` | float32 noise (28.633899688720703) |
| price | `price_per_night`, `price_per_stay` | **Formatted strings** (`"₹21,689"`). Parse by stripping non-digits; INR has no decimals |
| currency | `currency` | `"INR"` |
| advertiser | `advertisers` | A single string despite the plural name (`Booking.com`, `Agoda`, `MakeMyTrip`, `Trip.com`, `Hotel Site`, chain names) |
| deep link | `accommodation_url` | trivago.in `/lm/` URL with `search=…;dr-YYYYMMDD-YYYYMMDD;…&dealId=` |
| rating | `hotel_rating` (int stars), `review_rating` (string "8.7", /10), `review_count` (string "29,077") | |
| distance | `distance` | **"Delhi, 2.3 km to City centre": the distance to the CITY CENTRE, not to the search point.** We must compute haversine ourselves |
| other | `arrival`, `departure`, `country_city`, `top_amenities` (CSV string), `main_image` (URL) | |

`system_message` sits at `structuredContent.system_message`, with a copy inside `content[0].text`. It is about 2 KB of formatting orders ("You MUST…", "Do NOT use a comparison table").

**Results:** 25 hotels were **not sorted by distance**. Their true distances from the search point ran 0.20–2.40 km. Prices ran ₹2,017–₹21,689, with advertisers Booking.com ×13, Agoda ×4 and MakeMyTrip ×3.

**Size:** the raw result is **705,561 chars (~176k tokens)**, of which images are 646,252.
- All non-image content: 34.8 KB.
- `structuredContent`: 24,150.
- `structuredContent` without `system_message`: **22,150 (~5.5k tokens)**.
- Also without `main_image`: **17,641 (~4.4k tokens)**, about 700 chars per hotel.

**We should read only `structuredContent.accommodations`.** The content blocks should be dropped entirely.

### HotelsCasa `search_hotels` (with dates)
`{ content[2], structuredContent, isError:false }`. It has no images and no system_message.
- `content[0]` is text: a human summary, one line per hotel.
- `content[1]` is text and is **exactly `JSON.stringify(structuredContent)`**.
- `structuredContent` = `{ adults, availability_checked, check_in, check_out, children, count, items[], locale, next_page, nights, page }`.

Field paths, under `structuredContent.items[i]`:

| Need | Path | Notes |
|---|---|---|
| id | `hotel_key` | slug, e.g. `hotel-pink-city-new-delhi`. Can be long (~80 chars) |
| name | `name` | |
| lat/lng | `lat`, `lng` | 4 decimals |
| price | `price_eur_per_night`, `price_total_eur` (with dates); `price_from_eur_per_night` (always) | numbers, EUR. With dates, price_from equals the live price |
| currency | `currency` | `"EUR"` (only present with dates) |
| availability | `available` (true), `board`, `room_name`, `refundable`, `nights`, `price_note` | top-level `availability_checked:true` means the price is live |
| advertiser | — | always HotelsCasa itself |
| deep link | `url` | hotelscasa.com, carries `adults/checkin/checkout&src=mcp` |
| rating | `stars` (int), `rating_10` (number), `reviews_count` (int) | **`rating_10` and `reviews_count` are absent (not null) when a hotel has no reviews** (3 of 10) |
| distance | `distance_km` | from the search point, 0.1 km resolution. Items arrive sorted by distance |
| other | `type`, `city`, `country` (ISO-2), `photo_url` (URL) | |

Without dates, the items have only `price_from_eur_per_night` plus `price_note` ("Indicative nightly rate…"). `available`, `currency`, `board` and the other availability fields are absent, as is the top-level `availability_checked`.

**Size:** the raw result is 20,904 chars. `structuredContent` is 7,959 (~2k tokens); without `photo_url`/`price_note` it is **5,975 (~1.5k tokens)** for 10 hotels.

**Results:** 10 hotels at 0.1–0.3 km, €21.27–€95.39 per night, all available and refundable, Room Only. `next_page:2`; page 2 was still at 0.3 km.

### HotelsCasa `get_hotel` (with dates)
`content[0]` is a one-line summary and `content[1]` is the JSON of `structuredContent`.
`structuredContent` = `{ address, amenities[], availability{available, check_in, check_out, checked, nights}, check_in_from, check_out_until, city_url, description, description_lang, guest_summary, hotel{…same as a search item minus distance_km}, important_info, nearby[], photos[] }`.

The live price is at `hotel.price_eur_per_night` / `hotel.price_total_eur`, and the availability flag at `availability.available` / `availability.checked`.

Gotchas:
- `amenities`, `description` and `important_info` come back **in Spanish even with `lang:"en"`**.
- `guest_summary` is a **truncated JSON string ending in "…"**, so it cannot be parsed.
- `nearby` was empty.

Size: raw 8.4 KB; SC 3.9 KB; SC without photos/description/guest_summary 1.6 KB.
For an unknown key: `isError:true`, `structuredContent:{error:"not_found", message}`.

trivago has **no per-hotel detail or rates tool**. The only "detail" is the `accommodation_url` deep link.

## 3. Sessions, latency, limits, errors

| | trivago | HotelsCasa |
|---|---|---|
| Session | **Stateful.** `initialize` returns `mcp-session-id: mcp-session-<uuid>`. A request without it gets **HTTP 404 "Invalid session ID"** (text/plain) | **Stateless.** No session id is issued. A bare `tools/list` POST with no `initialize` returns 200 |
| Transport | POST → `application/json` (no SSE); gzip | POST → `application/json`; br; Cloudflare. GET → 405 (the SDK tolerates this) |
| Latency | connect ~1.7–2.3 s (initialize ~1.6 s + initialized notification ~1.5 s); tools/list ~1.8 s; **radius search 7–10 s** (origin ~6.5 s) | connect ~0.8 s; tools/list ~0.5 s; search_hotels with dates **2.8 s cold, ~0.65 s repeat** (cached); get_hotel 0.5–0.8 s |
| Rate-limit headers | none (Akamai `server-timing` only) | none seen (prior research: per-IP limit, undocumented) |

**Error behaviour:**
- trivago, past arrival date: `content[0].text` = "Validation errors: […]", `structuredContent.validation_errors[]`, and **no isError**. trivago's "today" follows its server clock (it said 2026-10-04 while it was already 10-05 in IST), so check-ins dated "today" in IST may be rejected late in the evening.
- trivago, invalid `country:"XX"`: **silently ignored** (the call fell back to the US/USD defaults).
- HotelsCasa, `radius_km:80`: **silently clamped** (no error).
- HotelsCasa, unknown hotel_key: `isError:true` + `{error:"not_found"}`.

## 4. Recommendations for `providers/trivago.ts` / `hotelscasa.ts`
1. **Allow-list by name**: `trivago-accommodation-radius-search`, `trivago-accommodation-search`, `search_hotels`, `get_hotel`. Annotations can't be used for this (HotelsCasa marks everything read-only).
2. **Parse `structuredContent` only.** Validate it with zod and never forward `content[]`. That drops the images, `system_message` and HotelsCasa's prompting. Treat a missing `accommodations` or the presence of `validation_errors`/`error` as an error, even though `isError` is absent.
3. **trivago:**
   - Always send `country:"IN", currency:"INR", language:"EN_IN", rooms:1`.
   - Parse the price strings to integers.
   - Compute the distance ourselves and filter by `radius_km` client-side, because the tool has no radius parameter and `distance` is to the city centre.
   - Round lat/lng to 6 dp.
   - Use an 8 s timeout. Calls take 7–10 s, so **raise the trivago timeout to about 15 s** or accept frequent timeouts. **PLAN §4 says 8 s, so this needs updating.**
   - Keep one long-lived session. On a 404 "Invalid session ID", reconnect and retry once.
   - Hold a single client per process, with concurrency ≤2.
4. **HotelsCasa:**
   - Always send `lang:"en"`, `limit:10`, `check_in`/`check_out`/`adults`.
   - Prices are EUR → convert to INR via fx.ts.
   - Use `availability_checked` to label prices as live or indicative.
   - Treat `rating_10`/`reviews_count` as optional.
   - Clamp `radius_km` ≤50 ourselves.
   - `get_hotel` can back `get_hotel_rates` for HotelsCasa ids.
5. **Size budget** after stripping: trivago ~4.4–5.5k tokens for 25 hotels; HotelsCasa ~1.5–2k tokens for 10. Both are fine to merge server-side. Our output should still be trimmed to `limit`.
