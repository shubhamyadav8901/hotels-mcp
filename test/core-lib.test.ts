import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AppError } from "../src/core/errors.js";
import { TtlCache } from "../src/lib/cache.js";
import { getJson } from "../src/lib/http.js";
import { ProviderRegistry } from "../src/providers/registry.js";

describe("config", () => {
  it("applies defaults and parses the disabled-provider list", () => {
    const c = loadConfig({ PROVIDERS_DISABLED: "xotelo, serpapi ,", SERPAPI_KEY: "  " });
    expect(c.PROVIDERS_DISABLED).toEqual(["xotelo", "serpapi"]);
    expect(c.SERPAPI_KEY).toBeUndefined();
    expect(c.METRO_TRAFFIC_MULTIPLIER).toBe(1.5);
  });

  it("rejects out-of-range values with a readable message", () => {
    expect(() => loadConfig({ METRO_TRAFFIC_MULTIPLIER: "9" })).toThrow(/METRO_TRAFFIC_MULTIPLIER/);
  });
});

describe("TtlCache", () => {
  it("expires entries and evicts the least recently used", () => {
    let t = 0;
    const cache = new TtlCache<number>(2, () => t);
    cache.set("a", 1, 100);
    cache.set("b", 2, 100);
    cache.get("a");
    cache.set("c", 3, 100);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    t = 100;
    expect(cache.get("a")).toBeUndefined();
  });

  it("shares one computation between concurrent callers", async () => {
    const cache = new TtlCache<number>();
    const compute = vi.fn(async () => 42);
    const [a, b] = await Promise.all([
      cache.getOrSet("k", 1000, compute),
      cache.getOrSet("k", 1000, compute),
    ]);
    expect([a, b]).toEqual([42, 42]);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});

describe("getJson", () => {
  const ua = { userAgent: "test" };

  it("retries once on 5xx then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await expect(getJson("https://x.test/a", { ...ua, fetchImpl })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps 429 to RATE_LIMITED and non-JSON to SCHEMA_CHANGED", async () => {
    const rateLimited = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    await expect(getJson("https://x.test/a", { ...ua, fetchImpl: rateLimited })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    const html = vi.fn().mockResolvedValue(new Response("<html>", { status: 200 }));
    await expect(getJson("https://x.test/a", { ...ua, fetchImpl: html })).rejects.toMatchObject({
      code: "SCHEMA_CHANGED",
    });
  });

  it("reports UPSTREAM_UNAVAILABLE after network failures", async () => {
    const down = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(getJson("https://x.test/a", { ...ua, fetchImpl: down })).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    expect(down).toHaveBeenCalledTimes(2);
  });
});

describe("ProviderRegistry", () => {
  const info = {
    id: "p",
    name: "P",
    kind: "hotel-prices" as const,
    official: true,
    needsKey: true,
    limitations: [],
  };

  it("disables providers with a missing key and refuses to run them", async () => {
    const r = new ProviderRegistry();
    r.register(info, { missingKey: true });
    expect(r.isEnabled("p")).toBe(false);
    await expect(r.run("p", async () => 1)).rejects.toMatchObject({ code: "DISABLED" });
  });

  it("records the last success and last error", async () => {
    const r = new ProviderRegistry([], () => new Date("2026-10-05T00:00:00Z"));
    r.register(info);
    await r.run("p", async () => 1);
    await expect(
      r.run("p", async () => {
        throw new AppError("RATE_LIMITED", "slow down");
      }),
    ).rejects.toBeInstanceOf(AppError);
    const [s] = r.status();
    expect(s?.last_success_at).toBe("2026-10-05T00:00:00.000Z");
    expect(s?.last_error).toEqual({
      at: "2026-10-05T00:00:00.000Z",
      code: "RATE_LIMITED",
      message: "slow down",
    });
  });
});

describe("unofficial sources", () => {
  const unofficial = {
    id: "u",
    name: "U",
    kind: "hotel-prices" as const,
    official: false,
    needsKey: false,
    limitations: [],
  };

  it("are disabled unless ENABLE_UNOFFICIAL_SOURCES is true", () => {
    const off = new ProviderRegistry([], () => new Date(), false);
    off.register(unofficial);
    expect(off.status()[0]).toMatchObject({
      enabled: false,
      disabled_reason: expect.stringMatching(/ENABLE_UNOFFICIAL_SOURCES/),
    });
    const on = new ProviderRegistry([], () => new Date(), true);
    on.register(unofficial);
    expect(on.isEnabled("u")).toBe(true);
  });

  it("default to off in configuration", () => {
    expect(loadConfig({}).ENABLE_UNOFFICIAL_SOURCES).toBe(false);
    expect(loadConfig({ ENABLE_UNOFFICIAL_SOURCES: "true" }).ENABLE_UNOFFICIAL_SOURCES).toBe(true);
  });
});
