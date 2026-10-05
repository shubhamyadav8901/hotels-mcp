# Test fixtures

All fixtures in this directory are **synthetic**. They were written by hand to
match the upstream formats that the adapters in `src/providers/` parse (field
names, nesting, MCP tool-result envelopes, error shapes), and contain only the
structure those parsers read.

They contain no copied third-party content. Every value (hotel names, ids and
location keys, prices, currencies, ratings, review counts, coordinates, seller
names, URL paths, image links, timestamps) is invented. Place names such as
"Testpur" are made up. Real hostnames appear only where the parser checks
them; other links use `example.invalid`.

## Adding a fixture

1. Read the adapter's parser and the upstream's public documentation to learn
   the shape it returns. Don't save a live response, even as a starting point.
2. Write the smallest JSON that exercises the parser, with invented values.
   Include the edge cases the test needs (missing price, unknown taxes, an
   error envelope) rather than a full realistic payload.
3. Name it `<source>-<what>.json` (for example `trivago-radius-search.json`,
   `hotelscasa-get-hotel-not-found.json`).
4. Load it in the test with
   `JSON.parse(readFileSync(new URL("./fixtures/<name>.json", import.meta.url), "utf8"))`
   (as `test/xotelo.test.ts` does), and stub `fetch` or the upstream-MCP call
   so the test never touches the network.
