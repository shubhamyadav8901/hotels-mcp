# Disclaimer

**Not affiliated.** This project is an independent, non-commercial personal project. It is not affiliated with, endorsed by, or connected to trivago, HotelsCasa, TripAdvisor, Xotelo, Booking.com, Agoda, MakeMyTrip, Goibibo, IRCTC, Indian Railways, Google, SerpApi, OpenStreetMap, OurAirports, Komoot (Photon), the Nominatim or OSRM projects, FOSSGIS, Frankfurter or the European Central Bank, or any hotel, seller or website it can query. All names are used only to identify data sources.

**No warranty; not for booking decisions.** Prices are meta-search prices collected from third parties. They change constantly, can differ at checkout, and may exclude GST and other taxes or fees (`includes_taxes: null` means unknown). Availability, hotel locations, distances and drive times can be wrong or out of date; road routing has no live traffic data, so drive times are estimates multiplied by a fixed traffic factor. Always check the price, taxes, cancellation terms and location with the seller (or the hotel) before you book or travel. The software is provided "as is", without warranty of any kind.

**Nothing is booked.** All tools are read-only. The server has no booking, payment or cancellation functionality, and upstream MCP servers are called only through an allow-list of read-only tools, so side-effecting tools they may offer are never reachable.

**Unofficial sources are off by default, and using them is your responsibility.** The Xotelo adapter uses an unofficial API derived from TripAdvisor meta-search, whose terms of use may restrict this kind of access. It is disabled unless you set `ENABLE_UNOFFICIAL_SOURCES=true`. Before enabling it, check the terms that apply and make sure your use is permitted. The other live sources are first-party endpoints (trivago's official MCP server, HotelsCasa's own MCP endpoint), public services used within their published usage policies (Photon, Nominatim at no more than 1 request per second with an identifying `HTTP_USER_AGENT`, the FOSSGIS OSRM instance, Frankfurter), or an optional paid API you configure yourself (SerpApi Google Hotels, `SERPAPI_KEY`, 250 free searches per month). Keep request volumes low; the built-in rate limits and caches exist for that reason, and heavy routing use should go to a self-hosted OSRM.

**Bundled data.**

- `data/stations.json.gz`, `data/bus_stations.json.gz` and `data/lodging.json.gz` are derived from OpenStreetMap, © OpenStreetMap contributors, and are available under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/) (see `data/LICENSE`).
- `data/airports.json.gz` is derived from [OurAirports](https://ourairports.com/data/), released into the public domain.
- `data/retiring_rooms.json.gz` is derived from IRCTC's public retiring-room station list. Only the station code, name and operator are kept (contact details are dropped), and coordinates are joined from the OpenStreetMap stations. The list is refreshed manually only (`npm run build:data -- --with-irctc`); IRCTC's terms forbid automated access, so it is never fetched on a schedule.
- `data/xotelo_keys.json.gz` holds location keys and centres derived from Xotelo API responses. It is used only when unofficial sources are enabled.

If you represent any of these organisations and want something changed or removed, please open an issue.

**Test fixtures are synthetic.** The files in `test/fixtures/` were written by hand to match the formats the adapters parse. They contain no copied third-party content.
