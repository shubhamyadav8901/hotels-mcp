import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ProviderRegistry } from "../providers/registry.js";
import type { SnapshotInfo } from "../providers/types.js";
import { handle, readOnly } from "./common.js";

const ProviderStatusSchema = z.object({
  id: z.string().describe("Source id, as used in source fields elsewhere."),
  name: z.string().describe("Human-readable source name."),
  kind: z
    .string()
    .describe("What the source provides: hotel-prices, hotel-locations, geocoding, routing, fx or dataset."),
  official: z
    .boolean()
    .describe("true for an official API, false for an unofficial third-party endpoint with no SLA."),
  needsKey: z.boolean().describe("Whether the source needs an API key."),
  limitations: z.array(z.string()).describe("Known limitations of the source."),
  enabled: z.boolean().describe("Whether the source is in use."),
  disabled_reason: z.string().nullable().describe("Why the source is disabled (null when enabled)."),
  last_success_at: z
    .string()
    .nullable()
    .describe("ISO time of the last successful call since the server started (null if none)."),
  last_error: z
    .object({
      at: z.string().describe("ISO time of the error."),
      code: z.string().describe("Error code, e.g. UPSTREAM_UNAVAILABLE."),
      message: z.string().describe("What went wrong."),
    })
    .nullable()
    .describe("The most recent failed call since the server started (null if none)."),
  quota_remaining: z
    .number()
    .nullable()
    .describe("Calls left in the source's current quota window (null when the source has no tracked quota)."),
});

const SnapshotSchema = z.object({
  id: z.string().describe("Dataset id."),
  description: z.string().describe("What the dataset contains."),
  rows: z.number().describe("Number of records in the dataset."),
  built_at: z.string().nullable().describe("When the dataset was built (null if unknown)."),
  source: z.string().describe("Where the data comes from."),
  licence: z.string().describe("Licence of the data."),
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
        providers: z.array(ProviderStatusSchema).describe("Every data source and its current status."),
        snapshots: z.array(SnapshotSchema).describe("Bundled datasets, with build date and licence."),
      },
      annotations: readOnly("Data sources and status"),
    },
    handle(async () => ({
      providers: deps.registry.status(),
      snapshots: deps.snapshots(),
    })),
  );
}
