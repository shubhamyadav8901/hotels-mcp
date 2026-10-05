import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createDeps, createServer, type Deps } from "../src/mcp.js";
import { TRIVAGO_INFO } from "../src/providers/trivago.js";

/** Real deps, minus network: the trivago name lookup is stubbed (tests that need it override `trivago`). */
export function testDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    ...createDeps(loadConfig({})),
    trivago: { info: TRIVAGO_INFO, lookup: async () => null },
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
