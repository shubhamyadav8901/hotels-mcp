import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createDeps, createServer, type Deps } from "../src/mcp.js";

export function testDeps(overrides: Partial<Deps> = {}): Deps {
  return { ...createDeps(loadConfig({})), ...overrides };
}

export async function connect(deps: Deps = testDeps()): Promise<Client> {
  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}
