# Contributing

Thanks for helping make hotel search and stay planning across India more accessible to AI assistants. Contributions of every size are welcome: bug reports, data corrections, docs, new data sources and features.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules

These keep the project trustworthy. Pull requests that break them can't be merged.

1. **Never fabricate data.** A provider returns real source data or throws a typed `AppError`. A failure must never become an empty result or a default value presented as data. Unknown values are `null`, with the reason stated (for example `includes_taxes: null` when a source doesn't say).
2. **Provenance on every answer.** Every price, distance and time carries where it came from: `source`, `seller` (for prices) and `fetched_at`. New tools and providers must keep that.
3. **Unofficial sources are opt-in.** Adapters for unofficial endpoints stay disabled unless the operator sets `ENABLE_UNOFFICIAL_SOURCES=true`. They need no hardcoded credentials or keys (use configuration), they rate-limit and cache, and they never persist data a source's terms forbid storing.
4. **Upstream MCP servers only through an allow-list.** A third-party MCP server is called only through `src/providers/upstream-mcp.ts` with an explicit allow-list of read-only tools. Booking, payment or other side-effecting tools must never be reachable, whatever their annotations say.
5. **No copied third-party content in the repo.** Test fixtures are written by hand to match upstream formats (see [test/fixtures/README.md](test/fixtures/README.md)). Don't commit recorded responses, scraped pages, hotel descriptions, photos or bulk data from sources whose terms don't allow redistribution.
6. **Tool descriptions describe; they don't instruct.** Tool descriptions and error text state facts about behaviour, must not tell the model how to behave, and never name other MCP servers (a [Claude connector review](https://claude.com/docs/connectors/building/review-criteria) rule).
7. **Upstream text stays data.** Text from upstream sources (hotel names, seller names, addresses) appears only in labelled data fields. Strip instructions, markup and images from it before it reaches a response.

## Development setup

Requirements: Node.js 22+.

```bash
git clone https://github.com/shubhamyadav8901/hotels-mcp.git
cd hotels-mcp
npm ci
npm test            # vitest: unit, provider (synthetic fixtures), MCP protocol tests
npm run typecheck
npm run docs:check  # docs/tools.md matches the tool schemas (npm run docs:tools to regenerate)
npm run format      # Prettier (CI runs format:check)
npm run dev         # watch mode, stdio
```

`docker compose up -d --build` runs the HTTP server as users do (`http://localhost:3001/mcp`, health at `/healthz`). See the [README](README.md) for configuration and connecting Claude.

## Making a change

1. **Open an issue first** for anything beyond a small fix, so the approach can be agreed before you invest time. Use the templates (bug, data error, new data source).
2. **Branch** from `main`, keep pull requests focused, and write clear commit messages.
3. **Tests:** add or update tests. Bug fixes should come with a test that fails without the fix. Unit tests never touch the network.
4. **Run the checks** before pushing: `npm run typecheck && npm test && npm run format:check`. CI runs the same, plus a build, a Docker build and a health check. `npm run smoke` runs live acceptance checks against the real sources; it needs the network and takes a few minutes, so it isn't part of CI.
5. **Docs:** update the [README](README.md) when behaviour, configuration or sources change, and add an entry under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).

## Common contributions

### Reporting wrong data

Use the **Data error** issue template for a wrong price, hotel location, distance or drive time. Include the tool and arguments, the dates, what the server returned (paste the tool output, including `source`, `seller` and `fetched_at`), and what the seller's page or a map shows. Prices change quickly, so say when you checked. Don't paste copyrighted pages; a short description or a link is enough.

### Adding a data source

Open a **New data source** issue covering the source's terms of use, what it provides, and how it would be accessed. In short:

- implement the provider interfaces in `src/providers/types.ts` and set `ProviderInfo.kind` honestly;
- use the shared HTTP client (`src/lib/http.ts`) and `TtlCache` (`src/lib/cache.ts`), rate-limit requests, and map failures to `AppError` codes;
- for a hosted MCP server, go through `src/providers/upstream-mcp.ts` and allow-list only read-only tools;
- write synthetic fixtures and tests;
- wire it up in `src/mcp.ts` and register it in `src/providers/registry.ts`, behind `ENABLE_UNOFFICIAL_SOURCES` if it's unofficial, and make sure `get_data_sources` reports its status, limits and quotas;
- add a check to `scripts/smoke.ts`.

### Rebuilding the bundled data

`npm run build:data` refreshes the OpenStreetMap and OurAirports snapshots (about once a month; set `HTTP_USER_AGENT`). `npm run build:data -- --with-irctc` also refreshes the IRCTC retiring-room list; it's a single manual request and must never be scheduled, because IRCTC's terms forbid automated access. The Xotelo location-key table is built with `scripts/build-xotelo-keys.ts`. Put the row counts from `data/manifest.json` before and after in the PR description.

## Licence

This project is licensed under the [Apache License 2.0](LICENSE). Under section 5 of that licence, any contribution you intentionally submit is licensed under the same terms, with no additional conditions. Changes to the bundled OpenStreetMap-derived data are made available under the [ODbL 1.0](data/LICENSE).
