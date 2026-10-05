/**
 * Live end-to-end check of the acceptance criteria in PLAN.md §8 against the real upstream sources.
 * Not part of CI (it needs the network and takes a few minutes):
 *
 *   HTTP_USER_AGENT="india-hotels-mcp/0.1 (you@example.com)" npm run smoke
 */
import "../src/net-setup.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createDeps, createServer } from "../src/mcp.js";

type Json = Record<string, any>;

async function client(env: Record<string, string | undefined>) {
  const deps = createDeps(loadConfig(env));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "smoke", version: "0" });
  await Promise.all([createServer(deps).connect(b), c.connect(a)]);
  return c;
}

async function call(
  c: Client,
  name: string,
  args: Json,
): Promise<{ data: Json; text: string; isError: boolean }> {
  const r = (await c.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as Json;
  const text = (r.content as { text?: string }[]).map((x) => x.text ?? "").join("");
  return { data: (r.structuredContent ?? {}) as Json, text, isError: Boolean(r.isError) };
}

const results: { name: string; ok: boolean; detail: string }[] = [];
async function check(name: string, fn: () => Promise<[boolean, string]>) {
  const t = Date.now();
  try {
    const [ok, detail] = await fn();
    results.push({ name, ok, detail: `${detail} (${((Date.now() - t) / 1000).toFixed(1)} s)` });
  } catch (err) {
    results.push({ name, ok: false, detail: `threw: ${err instanceof Error ? err.message : String(err)}` });
  }
  const last = results.at(-1)!;
  console.log(`${last.ok ? "PASS" : "FAIL"}  ${last.name} — ${last.detail}`);
}

const env = { ...process.env };
const c = await client(env);
const inDays = (n: number) =>
  new Date(Date.now() + n * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10);
const dates = { check_in: inDays(30), check_out: inDays(31) };
let ndlsHotels: Json[] = [];

await check("1. Hotels within 2 km of NDLS with INR prices from ≥2 sources", async () => {
  const r = await call(c, "search_hotels", { station_code: "NDLS", radius_km: 2, ...dates, limit: 30 });
  if (r.isError) return [false, r.text];
  ndlsHotels = r.data.hotels;
  const priced = ndlsHotels.filter((h) => h.cheapest?.per_night_inr);
  const sources = new Set(priced.map((h) => h.cheapest.source));
  const allHaveProvenance = priced.every((h) => h.cheapest.source && h.cheapest.fetched_at);
  return [
    r.data.total >= 10 && priced.length >= 5 && sources.size >= 2 && allHaveProvenance,
    `${r.data.total} hotels, ${priced.length} priced, cheapest-price sources: ${[...sources].join(", ")}`,
  ];
});

await check("2. Hotels within 30 min drive of DEL", async () => {
  const r = await call(c, "search_hotels", {
    iata: "DEL",
    max_drive_minutes: 30,
    sort: "drive_time",
    ...dates,
    limit: 30,
  });
  if (r.isError) return [false, r.text];
  const worst = Math.max(...r.data.hotels.map((h: Json) => h.drive_minutes));
  return [r.data.hotels.length > 0 && worst <= 30, `${r.data.total} hotels, max drive ${worst} min`];
});

await check("3. compare_hotels: 3 hotels × station + airport", async () => {
  const hotels = ndlsHotels.slice(0, 3).map((h) => ({ hotel_id: h.hotel_id }));
  const r = await call(c, "compare_hotels", {
    hotels,
    places: [
      { station_code: "NDLS", label: "arrive" },
      { iata: "DEL", label: "depart" },
    ],
  });
  if (r.isError) return [false, r.text];
  const full = r.data.hotels.every(
    (h: Json) => h.legs.length === 2 && h.legs.every((l: Json) => l.minutes !== null),
  );
  return [
    r.data.hotels.length === 3 && full,
    r.data.hotels.map((h: Json) => `${h.total_minutes} min`).join(", "),
  ];
});

await check("4. plan_stays: Delhi → Agra → Jaipur with a late arrival", async () => {
  const r = await call(c, "plan_stays", {
    stays: [
      {
        arrive: { station_code: "NDLS" },
        arrive_at: `${inDays(30)}T22:30`,
        depart: { station_code: "NZM" },
        depart_at: `${inDays(31)}T08:10`,
      },
      {
        arrive: { station_code: "AGC" },
        arrive_at: `${inDays(31)}T09:50`,
        depart: { station_code: "AGC" },
        depart_at: `${inDays(32)}T06:15`,
      },
      {
        arrive: { station_code: "JP" },
        arrive_at: `${inDays(32)}T11:30`,
        depart: { iata: "JAI" },
        depart_at: `${inDays(33)}T18:00`,
      },
    ],
  });
  if (r.isError) return [false, r.text];
  const stays: Json[] = r.data.stays;
  const enough = stays.every(
    (s) => s.candidates.length >= 3 && s.candidates.every((h: Json) => h.minutes_from_arrival !== null),
  );
  const late = stays[0]?.warnings.some((w: string) => /Late arrival/.test(w));
  return [
    stays.length === 3 && enough && late,
    stays.map((s) => `${s.candidates.length} candidates`).join(", "),
  ];
});

await check("5. find_retiring_rooms NDLS (no live IRCTC call)", async () => {
  const r = await call(c, "find_retiring_rooms", { station_code: "NDLS" });
  if (r.isError) return [false, r.text];
  return [
    r.data.stations[0]?.station_code === "NDLS" && r.data.booking_url.includes("irctc"),
    r.data.booking_url,
  ];
});

await check("6. trivago disabled: search still works and the source shows as disabled", async () => {
  const c2 = await client({ ...env, PROVIDERS_DISABLED: "trivago" });
  const r = await call(c2, "search_hotels", { station_code: "NDLS", radius_km: 2, ...dates });
  const status = await call(c2, "get_data_sources", {});
  const tv = status.data.providers.find((p: Json) => p.id === "trivago");
  return [
    !r.isError && r.data.total > 0 && !r.data.sources_ok.includes("trivago") && tv?.enabled === false,
    `${r.data.total ?? 0} hotels from ${r.data.sources_ok?.join(", ")}`,
  ];
});

await check("7. Response sizes and no upstream instructions or images", async () => {
  const r = await call(c, "search_hotels", { station_code: "NDLS", radius_km: 3, ...dates, limit: 30 });
  const tokens = Math.round(r.text.length / 4);
  const leaked = /system_message|IMPORTANT: Read|base64|data:image/.test(r.text);
  return [tokens < 25_000 && !leaked, `~${tokens} tokens for 30 hotels, leaked=${leaked}`];
});

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} acceptance checks passed`);
process.exit(failed ? 1 : 0);
