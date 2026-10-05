/**
 * Builds data/xotelo_keys.json.gz: TripAdvisor location keys usable with Xotelo's free `/list`, each with an
 * approximate centre and hotel count, so a lat/lng can be mapped to nearby keys at runtime (Spike S1).
 *
 *   HTTP_USER_AGENT="india-hotels-mcp/0.1 (you@example.com)" npx tsx scripts/build-xotelo-keys.ts \
 *     [--max-keys=1500] [--harvest-pages=30] [--seed-pages=5] [--fresh]
 *
 * How it works (only data.xotelo.com is called; no tripadvisor.com page is fetched):
 *  1. Harvest: page `/list` for India (g293860) with each sort, and the hand-seeded keys below. Every item's
 *     TripAdvisor `url` names the hotel's most specific geo (`Hotel_Review-g<geo>-d<id>-...`), so each page
 *     reveals many location keys.
 *  2. Detail: call `/list?limit=100` once per discovered key (most-seen first). `total_count` gives the hotel
 *     count; the hotels' coordinates give the centre. Hotels on that page reveal further sub-keys.
 *  3. Keys whose hotels spread over a wide area (states, regions) are left out: a runtime radius search
 *     around a point cannot use them.
 *
 * Polite: requests are serial and at least 1.2 s apart, with backoff on errors. Progress is checkpointed
 * to data/.xotelo-checkpoint.json after every call, so an interrupted run resumes where it stopped.
 */
import "../src/net-setup.js";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { haversineKm } from "../src/core/geo.js";
import { parseTripadvisorUrl, type XoteloKeyRow } from "../src/providers/xotelo.js";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const CHECKPOINT = join(DATA_DIR, ".xotelo-checkpoint.json");
const OUT_FILE = "xotelo_keys.json.gz";
const BASE = "https://data.xotelo.com/api/list";
const MIN_GAP_MS = 1200;
/** A key whose hotels lie (80th percentile) further than this from their centre is a region, not a place. */
const MAX_SPREAD_KM = 40;

const UA = process.env.HTTP_USER_AGENT;
if (!UA) {
  console.error("Set HTTP_USER_AGENT (app name + contact) to identify this build to Xotelo.");
  process.exit(1);
}
const args = process.argv.slice(2);
const numArg = (name: string, dflt: number) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.slice(name.length + 3)) : dflt;
};
const MAX_KEYS = numArg("max-keys", 1500);
const HARVEST_PAGES = numArg("harvest-pages", 30);
const SEED_PAGES = numArg("seed-pages", 5);
const FRESH = args.includes("--fresh");

/** India as a whole; `total_count` is capped at 3000 per sort, so each sort gives a different 3000. */
const INDIA = "g293860";
const SORTS = ["best_value", "popularity", "distance"] as const;

/**
 * Hand-seeded keys. Cities were confirmed in Spike S1 (Wikidata P3134 or harvested from Xotelo URLs).
 * State keys marked "?" are unverified guesses from TripAdvisor's id numbering; the build calls each one
 * and skips any that Xotelo rejects or that return no hotels.
 */
const SEEDS: Record<string, string> = {
  // Confirmed states/regions
  g297631: "Kerala",
  g297604: "Goa",
  // Unverified state guesses
  g297665: "Rajasthan?",
  g297627: "Karnataka?",
  g297648: "Maharashtra?",
  g297682: "Uttar Pradesh?",
  g297686: "Uttarakhand?",
  g297617: "Himachal Pradesh?",
  g297622: "Jammu and Kashmir?",
  g297660: "Odisha?",
  g297606: "Gujarat?",
  g297614: "Haryana?",
  g297584: "Andhra Pradesh?",
  // Confirmed cities and towns
  g304551: "New Delhi",
  g304554: "Mumbai",
  g304555: "Jaipur",
  g297683: "Agra",
  g297628: "Bengaluru",
  g304556: "Chennai",
  g297586: "Hyderabad",
  g304558: "Kolkata",
  g297633: "Kochi",
  g297615: "Gurugram",
  g297685: "Varanasi",
  g297672: "Udaipur",
  g297667: "Jaisalmer",
  g297668: "Jodhpur",
  g303884: "Amritsar",
  g297605: "Candolim",
  g297661: "Bhubaneswar",
  g297687: "Dehradun",
  g659796: "Gangtok",
  g304553: "Mysuru",
  g304552: "Shimla",
  g503703: "Puri",
  g303881: "Munnar",
  g297618: "Manali",
  g580106: "Rishikesh",
  g297636: "Thekkady",
  g297623: "Srinagar",
  g297608: "Ahmedabad",
  g297679: "Ooty",
  g635749: "Mahabaleshwar",
  g319726: "Bhopal",
  g616028: "Haridwar",
  g297684: "Lucknow",
  g503692: "Guwahati",
  g1532344: "Navi Mumbai",
  g297637: "Thiruvananthapuram",
  g297654: "Pune",
};

interface Detail {
  name: string;
  lat: number;
  lng: number;
  hotels: number;
  spread_km: number;
}
interface Checkpoint {
  /** Harvest pages already fetched, as "key:sort:offset". */
  harvested: string[];
  /** Every key seen in a hotel URL: place name and how many hotels named it. */
  seen: Record<string, { name: string; hits: number }>;
  details: Record<string, Detail | { error: string }>;
}

const cp: Checkpoint =
  !FRESH && existsSync(CHECKPOINT)
    ? (JSON.parse(readFileSync(CHECKPOINT, "utf8")) as Checkpoint)
    : { harvested: [], seen: {}, details: {} };
const harvested = new Set(cp.harvested);
const saveCheckpoint = () => {
  cp.harvested = [...harvested];
  writeFileSync(`${CHECKPOINT}.tmp`, JSON.stringify(cp));
  renameSync(`${CHECKPOINT}.tmp`, CHECKPOINT);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
let calls = 0;

interface Item {
  url?: string | null;
  geo?: { latitude: number; longitude: number } | null;
}
type ListResult = { ok: true; total: number; items: Item[] } | { ok: false; error: string };

/** One polite `/list` call with retries; Xotelo reports errors in-band with HTTP 200. */
async function list(key: string, limit: number, offset: number, sort: string): Promise<ListResult> {
  const url = `${BASE}?location_key=${key}&limit=${limit}&offset=${offset}&sort=${sort}`;
  const backoff = [5_000, 20_000, 60_000, 120_000];
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    calls++;
    let why: string;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA!, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          error?: { status_code?: number; message?: string } | null;
          result?: { total_count: number; list: Item[] } | null;
        };
        if (body.error) {
          const msg = `${body.error.status_code ?? "?"} ${body.error.message ?? ""}`.trim();
          // 4xx in-band errors are permanent for this key; anything else is retried.
          if ((body.error.status_code ?? 500) < 500 && body.error.status_code !== 429)
            return { ok: false, error: msg };
          why = msg;
        } else if (body.result) {
          return { ok: true, total: body.result.total_count, items: body.result.list };
        } else {
          why = "no result";
        }
      } else {
        why = `HTTP ${res.status}`;
      }
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
    if (attempt >= backoff.length) return { ok: false, error: `gave up: ${why}` };
    console.error(`  ${key}@${offset} failed (${why}); retry in ${backoff[attempt]! / 1000} s`);
    await sleep(backoff[attempt]!);
  }
}

/** Records every location key named by the hotels' URLs. */
function harvest(items: Item[]): void {
  for (const it of items) {
    const p = parseTripadvisorUrl(it.url);
    if (!p) continue;
    const s = (cp.seen[p.geo] ??= { name: p.place, hits: 0 });
    s.hits++;
  }
}

async function harvestKey(key: string, sort: string, pages: number): Promise<void> {
  for (let page = 0; page < pages; page++) {
    const id = `${key}:${sort}:${page * 100}`;
    if (harvested.has(id)) continue;
    const res = await list(key, 100, page * 100, sort);
    harvested.add(id);
    if (res.ok) harvest(res.items);
    saveCheckpoint();
    if (!res.ok || res.items.length < 100 || (page + 1) * 100 >= res.total) {
      // Mark the remaining pages done so a resumed run does not refetch an exhausted key.
      for (let p = page + 1; p < pages; p++) harvested.add(`${key}:${sort}:${p * 100}`);
      saveCheckpoint();
      return;
    }
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** Centre = mean of the hotels within 25 km of the median point; spread = 80th percentile distance. */
function centre(points: { lat: number; lng: number }[]): { lat: number; lng: number; spread_km: number } {
  const med = { lat: median(points.map((p) => p.lat)), lng: median(points.map((p) => p.lng)) };
  const near = points.filter((p) => haversineKm(med, p) <= 25);
  const use = near.length ? near : points;
  const c = {
    lat: use.reduce((a, p) => a + p.lat, 0) / use.length,
    lng: use.reduce((a, p) => a + p.lng, 0) / use.length,
  };
  const d = points.map((p) => haversineKm(c, p)).sort((a, b) => a - b);
  return {
    lat: round5(c.lat),
    lng: round5(c.lng),
    spread_km: Math.round(d[Math.floor(d.length * 0.8)]! * 10) / 10,
  };
}

async function detail(key: string): Promise<void> {
  const res = await list(key, 100, 0, "best_value");
  if (!res.ok) {
    cp.details[key] = { error: res.error };
    return;
  }
  harvest(res.items);
  const own = res.items.filter((it) => it.geo && parseTripadvisorUrl(it.url)?.geo === key);
  const pts = (own.length >= 3 ? own : res.items)
    .filter((it) => it.geo)
    .map((it) => ({ lat: it.geo!.latitude, lng: it.geo!.longitude }));
  if (res.total === 0 || pts.length === 0) {
    cp.details[key] = { error: "no hotels" };
    return;
  }
  const ownPlace = own.map((it) => parseTripadvisorUrl(it.url)?.place).find(Boolean);
  const name = ownPlace ?? cp.seen[key]?.name ?? SEEDS[key]?.replace(/\?$/, "") ?? key;
  cp.details[key] = { name, hotels: res.total, ...centre(pts) };
}

function rows(): XoteloKeyRow[] {
  return Object.entries(cp.details)
    .flatMap(([key, d]) =>
      "error" in d || d.spread_km > MAX_SPREAD_KM
        ? []
        : [{ key, name: d.name, lat: d.lat, lng: d.lng, hotels: d.hotels }],
    )
    .sort((a, b) => b.hotels - a.hotels || a.key.localeCompare(b.key));
}

function writeOutput(): number {
  const out = rows();
  writeFileSync(join(DATA_DIR, OUT_FILE), gzipSync(JSON.stringify(out)));
  const manifestPath = join(DATA_DIR, "manifest.json");
  const manifest = (
    existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { datasets: {} }
  ) as { datasets: Record<string, unknown> };
  manifest.datasets.xotelo_keys = {
    rows: out.length,
    built_at: new Date().toISOString(),
    source: "Xotelo /list (data.xotelo.com); location keys parsed from TripAdvisor hotel URLs",
    licence: "Derived from Xotelo API responses (TripAdvisor data); no redistribution licence stated",
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return out.length;
}

async function main(): Promise<void> {
  console.error(
    `harvest: India x ${SORTS.length} sorts x ${HARVEST_PAGES} pages, ${Object.keys(SEEDS).length} seeds`,
  );
  for (const sort of SORTS) await harvestKey(INDIA, sort, HARVEST_PAGES);
  for (const key of Object.keys(SEEDS)) await harvestKey(key, "best_value", SEED_PAGES);
  console.error(`  ${Object.keys(cp.seen).length} keys seen after ${calls} calls`);

  for (const key of Object.keys(SEEDS)) if (!cp.seen[key]) cp.seen[key] = { name: SEEDS[key]!, hits: 0 };
  let done = Object.keys(cp.details).length;
  while (done < MAX_KEYS) {
    // Seeds first, then the key named by the most hotels so far.
    let next: string | undefined;
    let best = -1;
    for (const [key, s] of Object.entries(cp.seen)) {
      if (key === INDIA || cp.details[key]) continue;
      const score = key in SEEDS ? Number.MAX_SAFE_INTEGER : s.hits;
      if (score > best) [best, next] = [score, key];
    }
    if (!next) break;
    await detail(next);
    saveCheckpoint();
    done++;
    if (done % 25 === 0) {
      const n = writeOutput();
      console.error(
        `  ${done} keys detailed (${n} usable), ${Object.keys(cp.seen).length} seen, ${calls} calls`,
      );
    }
  }
  const n = writeOutput();
  console.error(
    `done: ${n} usable keys from ${done} detailed (${Object.keys(cp.seen).length} seen), ${calls} calls`,
  );
}

await main();
