import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import { connect, testDeps } from "./helpers.js";

describe("MCP surface", () => {
  it("marks every tool read-only and non-destructive, with a title and output schema", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name.length).toBeLessThanOrEqual(64);
      expect(tool.annotations?.title, tool.name).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.outputSchema, tool.name).toBeDefined();
    }
  });

  it("returns provider status from get_data_sources as structured content and text", async () => {
    const registry = new ProviderRegistry(["xotelo"]);
    registry.register({
      id: "xotelo",
      name: "Xotelo",
      kind: "hotel-prices",
      official: false,
      needsKey: false,
      limitations: ["unofficial"],
    });
    const client = await connect(testDeps({ registry }));
    const result = await client.callTool({ name: "get_data_sources", arguments: {} });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { providers: { id: string; enabled: boolean }[] };
    expect(structured.providers).toEqual([
      expect.objectContaining({
        id: "xotelo",
        enabled: false,
        disabled_reason: "disabled by PROVIDERS_DISABLED",
      }),
    ]);
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text)).toEqual(structured);
  });
});

describe("search_hotels tool", () => {
  const T = "2026-10-05T10:00:00.000Z";
  const provider = (id: string, hotels: unknown[] | Error) => ({
    info: { id, name: id, kind: "hotel-prices" as const, official: false, needsKey: false, limitations: [] },
    search: async () => {
      if (hotels instanceof Error) throw hotels;
      return hotels as never;
    },
  });
  const h = {
    source: "a",
    source_id: "1",
    name: "Near Inn",
    lat: 28.6435,
    lng: 77.2194,
    stars: 3,
    rating_10: 8,
    review_count: 10,
    url: null,
    fetched_at: T,
    prices: [
      {
        source: "a",
        seller: "Booking.com",
        per_night: 4000,
        total: 4000,
        currency: "INR",
        per_night_inr: null,
        includes_taxes: null,
        available: null,
        refundable: null,
        url: null,
        room: null,
        fetched_at: T,
      },
    ],
  };

  function depsWith(providers: ReturnType<typeof provider>[]) {
    const registry = new ProviderRegistry();
    providers.forEach((p) => registry.register(p.info));
    return testDeps({ registry, hotelProviders: providers, now: () => new Date(T) });
  }

  const args = { lat: 28.643, lng: 77.2194, check_in: "2026-11-10", check_out: "2026-11-11" };

  it("returns merged hotels with INR prices and a paging summary that matches the output schema", async () => {
    const client = await connect(depsWith([provider("a", [h])]));
    const result = await client.callTool({ name: "search_hotels", arguments: args });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      showing: "Showing 1–1 of 1",
      hotels: [{ hotel_id: "a:1", cheapest: { per_night_inr: 4000, seller: "Booking.com" } }],
      sources_ok: ["a"],
    });
  });

  it("errors with a hint when every source fails", async () => {
    const client = await connect(depsWith([provider("a", new Error("boom"))]));
    const result = await client.callTool({ name: "search_hotels", arguments: args });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(body.error).toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      hint: expect.stringContaining("get_data_sources"),
    });
  });

  it("rejects past or reversed dates using the date in India", async () => {
    const client = await connect(depsWith([provider("a", [h])]));
    // 2026-10-05T20:00Z is already 2026-10-06 in IST.
    const late = await connect({
      ...depsWith([provider("a", [h])]),
      now: () => new Date("2026-10-05T20:00:00Z"),
    });
    const past = await late.callTool({
      name: "search_hotels",
      arguments: { ...args, check_in: "2026-10-05", check_out: "2026-10-07" },
    });
    expect(past.isError).toBe(true);
    const reversed = await client.callTool({
      name: "search_hotels",
      arguments: { ...args, check_out: "2026-11-09" },
    });
    expect(reversed.isError).toBe(true);
  });
});

describe("min_rating_pct default", () => {
  const T = "2026-10-05T10:00:00.000Z";
  const quote = (per_night: number) => ({
    source: "a",
    seller: null,
    per_night,
    total: null,
    currency: "INR",
    per_night_inr: null,
    includes_taxes: null,
    available: null,
    refundable: null,
    url: null,
    room: null,
    fetched_at: T,
  });
  const cand = (id: string, rating_10: number | null) => ({
    source: "a",
    source_id: id,
    name: `Hotel ${id}`,
    lat: 28.6435 + Number(id) * 0.0005,
    lng: 77.2194,
    stars: 3,
    rating_10,
    review_count: rating_10 === null ? null : 10,
    url: null,
    prices: [quote(1000 + Number(id))],
    fetched_at: T,
  });
  const provider = {
    info: {
      id: "a",
      name: "a",
      kind: "hotel-prices" as const,
      official: true,
      needsKey: false,
      limitations: [],
    },
    search: async () => [cand("1", 8.5), cand("2", 5.0), cand("3", null)],
  };
  async function client(defaultPct: string) {
    const registry = new ProviderRegistry();
    registry.register(provider.info);
    const base = testDeps({ registry, hotelProviders: [provider], now: () => new Date(T) });
    const { loadConfig } = await import("../src/config.js");
    return connect({ ...base, config: loadConfig({ DEFAULT_MIN_RATING_PCT: defaultPct }) });
  }
  const args = { lat: 28.643, lng: 77.2194, check_in: "2026-11-10", check_out: "2026-11-11" };
  const names = (r: unknown) =>
    (r as { structuredContent: { hotels: { name: string }[] } }).structuredContent.hotels.map((h) => h.name);

  it("advertises the server default in the tool schema", async () => {
    const c = await client("60");
    const { tools } = await c.listTools();
    const prop = (
      tools.find((t) => t.name === "search_hotels")!.inputSchema.properties as Record<
        string,
        { default?: number }
      >
    ).min_rating_pct;
    expect(prop?.default).toBe(60);
  });

  it("applies the default, lets the agent override it, and 0 turns it off", async () => {
    const c = await client("60");
    expect(names(await c.callTool({ name: "search_hotels", arguments: args }))).toEqual(["Hotel 1"]);
    expect(
      names(await c.callTool({ name: "search_hotels", arguments: { ...args, min_rating_pct: 40 } })),
    ).toEqual(["Hotel 1", "Hotel 2"]);
    expect(
      names(await c.callTool({ name: "search_hotels", arguments: { ...args, min_rating_pct: 0 } })),
    ).toEqual(["Hotel 1", "Hotel 2", "Hotel 3"]);
  });

  it("defaults to no filter when the server sets none", async () => {
    const c = await client("0");
    expect(names(await c.callTool({ name: "search_hotels", arguments: args }))).toHaveLength(3);
  });
});
