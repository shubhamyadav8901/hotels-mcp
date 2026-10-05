import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/core/errors.js";
import { createSerpApi, type QuotaFs } from "../src/providers/serpapi.js";
import type { HotelSearchQuery } from "../src/core/types.js";

const query: HotelSearchQuery = {
  lat: 12.97,
  lng: 77.59,
  radius_km: 5,
  place: "Bengaluru",
  check_in: "2026-10-12",
  check_out: "2026-10-13",
  adults: 2,
};
const stay = { check_in: "2026-10-12", check_out: "2026-10-13", adults: 2 };

let dir: string;
let statePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "serpapi-quota-"));
  statePath = join(dir, "state", "serpapi-quota.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function make(opts: { at?: () => number; fsImpl?: QuotaFs; roomsPerHour?: number; path?: string } = {}) {
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify({ properties: [] }), { status: 200 }),
  ) as unknown as typeof fetch;
  const serp = createSerpApi({
    apiKey: "test-key",
    http: { userAgent: "test", fetchImpl, retries: 0 },
    now: opts.at ?? (() => Date.parse("2026-10-05T10:00:00Z")),
    statePath: opts.path ?? statePath,
    fs: opts.fsImpl,
    roomsPerHour: opts.roomsPerHour,
  });
  return { serp, fetchImpl };
}

const saved = () => JSON.parse(readFileSync(statePath, "utf8"));

describe("serpapi persistent quota", () => {
  it("keeps the month's count across a restart", async () => {
    const first = make();
    await first.serp.search(query);
    await first.serp.search({ ...query, place: "Mysuru" });
    expect(first.serp.quotaRemaining()).toBe(248);
    expect(saved()).toEqual({ month: "2026-10", used: 2 });

    const restarted = make();
    expect(restarted.serp.quotaRemaining()).toBe(248);
    await restarted.serp.search({ ...query, place: "Hassan" });
    expect(restarted.serp.quotaRemaining()).toBe(247);
    expect(saved()).toEqual({ month: "2026-10", used: 3 });
  });

  it("counts searches by two processes sharing the file, without losing either's", async () => {
    const a = make();
    const b = make();
    await a.serp.search(query);
    await b.serp.search({ ...query, place: "Mysuru" });
    await a.serp.search({ ...query, place: "Hassan" });
    expect(saved()).toEqual({ month: "2026-10", used: 3 });
  });

  it("resets when the month rolls over", async () => {
    let t = Date.parse("2026-10-31T23:00:00Z");
    const { serp } = make({ at: () => t });
    await serp.search(query);
    expect(serp.quotaRemaining()).toBe(249);
    t = Date.parse("2026-11-01T01:00:00Z");
    expect(serp.quotaRemaining()).toBe(250);
    await serp.search({ ...query, place: "Mysuru" });
    expect(saved()).toEqual({ month: "2026-11", used: 1 });

    // A saved count from an earlier month doesn't carry over after a restart either.
    writeFileSync(statePath, JSON.stringify({ month: "2026-09", used: 200 }));
    expect(make({ at: () => t }).serp.quotaRemaining()).toBe(250);
  });

  it("starts from 0 on a corrupt or wrong-shaped file without throwing", async () => {
    fs.mkdirSync(join(dir, "state"));
    writeFileSync(statePath, "{not json");
    const { serp } = make();
    expect(serp.quotaRemaining()).toBe(250);
    await serp.search(query);
    expect(saved()).toEqual({ month: "2026-10", used: 1 });

    writeFileSync(statePath, JSON.stringify({ month: 7, used: "lots" }));
    expect(make().serp.quotaRemaining()).toBe(250);
  });

  it("still searches (and logs once) when the file can't be written", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: QuotaFs = {
      ...fs,
      writeFileSync: () => {
        throw new Error("EROFS: read-only file system");
      },
    } as QuotaFs;
    const { serp, fetchImpl } = make({ fsImpl: failing });
    await expect(serp.search(query)).resolves.toEqual([]);
    await expect(serp.search({ ...query, place: "Mysuru" })).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(serp.quotaRemaining()).toBe(248);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toContain("EROFS");
    expect(String(err.mock.calls[0]![0])).not.toContain("test-key");
    err.mockRestore();
  });
});

describe("serpapi room-list hourly cap", () => {
  it("throws RATE_LIMITED after N uncached lookups in an hour, then frees up as the hour rolls", async () => {
    let t = Date.parse("2026-10-05T10:00:00Z");
    const { serp, fetchImpl } = make({ at: () => t, roomsPerHour: 2 });
    await serp.rooms("tok1", stay);
    t += 20 * 60_000;
    await serp.rooms("tok2", stay);
    const err = await serp.rooms("tok3", stay).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("RATE_LIMITED");
    expect((err as AppError).message).toBe(
      "Google room-list lookups are capped at 2 per hour to save SerpApi quota; the next is possible in ~40 min, and until then every uncached lookup gets this same answer",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(serp.quotaRemaining()).toBe(248);

    t += 40 * 60_000 + 1;
    await expect(serp.rooms("tok3", stay)).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not count cache hits against the cap or the quota", async () => {
    const { serp, fetchImpl } = make({ roomsPerHour: 1 });
    await serp.rooms("tok1", stay);
    await serp.rooms("tok1", stay);
    await serp.rooms("tok1", stay);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(serp.quotaRemaining()).toBe(249);
    await expect(serp.rooms("tok2", stay)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("is unlimited at 0, and search pages never count against it", async () => {
    const { serp, fetchImpl } = make({ roomsPerHour: 0 });
    for (let i = 0; i < 12; i++) await serp.rooms(`tok${i}`, stay);
    expect(fetchImpl).toHaveBeenCalledTimes(12);

    const capped = make({ roomsPerHour: 1, path: join(dir, "other.json") });
    for (const place of ["A", "B", "C"]) await capped.serp.search({ ...query, place });
    await expect(capped.serp.rooms("tok", stay)).resolves.toEqual([]);
  });
});
