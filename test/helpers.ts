import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createDeps, createServer, type Deps } from "../src/mcp.js";
import { HOTELSCASA_INFO } from "../src/providers/hotelscasa.js";
import { TRIVAGO_INFO } from "../src/providers/trivago.js";

/** Real deps, minus network: the trivago name lookup, HotelsCasa details and Google pages are stubbed (tests that need it override `trivago`). */
export function testDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    ...createDeps(loadConfig({})),
    trivago: { info: TRIVAGO_INFO, lookup: async () => null },
    hotelscasa: { info: HOTELSCASA_INFO, details: async () => ({ details: {} }) },
    serp: null,
    ...overrides,
  };
}

export async function connect(deps: Deps = testDeps()): Promise<Client> {
  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type OfferRow = { source: string; seller: string; per_night_inr: number | null; [k: string]: unknown };

/** Every offer in a get_hotel_details result, flattened across sources, cheapest first (seller falls back to the source). */
export function offers(structured: unknown): OfferRow[] {
  const sources = (structured as { sources: { source: string; offers: Record<string, unknown>[] }[] })
    .sources;
  return sources
    .flatMap((s) =>
      s.offers.map(
        (o) => ({ ...o, source: s.source, seller: (o.seller as string | null) ?? s.source }) as OfferRow,
      ),
    )
    .sort((a, b) => (a.per_night_inr ?? Infinity) - (b.per_night_inr ?? Infinity));
}
