import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const ConfigSchema = z.object({
  /** Sent to every upstream; Nominatim's policy asks for an identifying app name. Add your contact for heavy use. */
  HTTP_USER_AGENT: z
    .string()
    .default("india-hotels-mcp/0.1 (+https://github.com/shubhamyadav8901/hotels-mcp)"),
  SERPAPI_KEY: optionalString,
  /** Google Hotels pages per area search (1–5, ~20 hotels each); every page costs one SerpApi search. */
  SERPAPI_MAX_PAGES: z.coerce.number().int().min(1).max(5).default(1),
  /** Writable directory for small state files (the SerpApi monthly search count); the Docker image uses /data/state. */
  STATE_DIR: z
    .string()
    .trim()
    .min(1)
    .default(join(homedir(), ".cache", "india-hotels-mcp")),
  PROVIDERS_DISABLED: csv,
  /** Unofficial sources (Xotelo, and SerpApi's Google Hotels scraper) run only when this is true. */
  ENABLE_UNOFFICIAL_SOURCES: z
    .enum(["true", "false", "1", "0", ""])
    .optional()
    .transform((v) => v === "true" || v === "1"),
  OSRM_URL: z.url().default("https://routing.openstreetmap.de/routed-car"),
  OSRM_FOOT_URL: z.url().default("https://routing.openstreetmap.de/routed-foot"),
  NOMINATIM_URL: z.url().default("https://nominatim.openstreetmap.org"),
  PHOTON_URL: z.url().default("https://photon.komoot.io"),
  METRO_TRAFFIC_MULTIPLIER: z.coerce.number().min(1).max(4).default(1.5),
  OTHER_TRAFFIC_MULTIPLIER: z.coerce.number().min(1).max(4).default(1.2),
  TRAIN_BUFFER_MIN: z.coerce.number().int().min(0).max(240).default(30),
  FLIGHT_BUFFER_MIN: z.coerce.number().int().min(0).max(480).default(120),
  /** Default minimum guest rating (percent) for search_hotels and plan_stays; 0 = no filter. */
  DEFAULT_MIN_RATING_PCT: z.coerce.number().min(0).max(100).default(0),
  PROVIDER_DEADLINE_MS: z.coerce.number().int().min(2000).max(120_000).default(20_000),
  /** Interface the HTTP mode listens on; the Docker image sets 0.0.0.0. */
  HOST: z.string().default("127.0.0.1"),
  /** Extra hostnames accepted in the Host header in HTTP mode, besides localhost/127.0.0.1/[::1] (DNS-rebinding protection). */
  ALLOWED_HOSTS: csv,
  /** 3001 by default, so it can run next to other local MCP servers that use 3000. */
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
