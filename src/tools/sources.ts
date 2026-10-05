import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ProviderRegistry } from "../providers/registry.js";
import type { SnapshotInfo } from "../providers/types.js";
import { handle, readOnly } from "./common.js";

const ProviderStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  official: z.boolean(),
  needsKey: z.boolean(),
  limitations: z.array(z.string()),
  enabled: z.boolean(),
  disabled_reason: z.string().nullable(),
  last_success_at: z.string().nullable(),
  last_error: z.object({ at: z.string(), code: z.string(), message: z.string() }).nullable(),
  quota_remaining: z.number().nullable(),
});

const SnapshotSchema = z.object({
  id: z.string(),
  description: z.string(),
  rows: z.number(),
  built_at: z.string().nullable(),
  source: z.string(),
  licence: z.string(),
});

export function registerSourcesTool(
  server: McpServer,
  deps: { registry: ProviderRegistry; snapshots: () => SnapshotInfo[] },
): void {
  server.registerTool(
    "get_data_sources",
    {
      title: "Data sources and status",
      description:
        "Lists every data source this server uses: hotel price sources, hotel location data, geocoding, routing " +
        "and bundled datasets. For each it gives whether it is enabled, whether it is official or an unofficial " +
        "third-party endpoint, recent success/failure, remaining quota and known limitations. Bundled datasets " +
        "include their build date and licence. Does not fetch any hotel data.",
      inputSchema: {},
      outputSchema: {
        providers: z.array(ProviderStatusSchema),
        snapshots: z.array(SnapshotSchema),
      },
      annotations: readOnly("Data sources and status"),
    },
    handle(async () => ({
      providers: deps.registry.status(),
      snapshots: deps.snapshots(),
    })),
  );
}
