import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError } from "../src/core/errors.js";
import { isConnectionError, UpstreamMcpClient, warmUpUpstreams } from "../src/providers/upstream-mcp.js";

/** A local stateful MCP server with one read-only tool, counting handshakes and tool calls. */
async function fakeUpstream(
  opts: {
    /** Answers the n-th initialize request (1-based) itself instead of the MCP server, e.g. with a 500. */
    failInit?: (n: number, res: ServerResponse) => boolean;
    /** Drops the connection of the n-th tools/call request (1-based) without answering. */
    dropCall?: (n: number) => boolean;
  } = {},
) {
  const stats = { initialize: 0, toolCalls: 0 };
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const http: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const sid = req.headers["mcp-session-id"];
    if (body?.method === "initialize") {
      stats.initialize++;
      if (opts.failInit?.(stats.initialize, res)) return;
      const mcp = new McpServer({ name: "fake", version: "1.0.0" });
      mcp.registerTool("search", { inputSchema: { q: z.string() } }, async ({ q }) => ({
        content: [],
        structuredContent: { echo: q },
      }));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (id) => void sessions.set(id, transport),
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    if (body?.method === "tools/call") {
      stats.toolCalls++;
      if (opts.dropCall?.(stats.toolCalls)) {
        req.socket.destroy();
        return;
      }
    }
    const transport = typeof sid === "string" ? sessions.get(sid) : undefined;
    if (!transport) {
      res.writeHead(404).end("Invalid session ID");
      return;
    }
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  servers.push(http);
  return { url, stats };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

const client = (url: string, name = "fake") => new UpstreamMcpClient(name, url, ["search"], 5_000, "test/1");

describe("UpstreamMcpClient", () => {
  it("shares one session handshake between concurrent first calls", async () => {
    const up = await fakeUpstream();
    const c = client(up.url);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => c.call("search", { q: `p${i}` })));
    expect(results.map((r) => r.structuredContent?.echo)).toEqual(
      Array.from({ length: 12 }, (_, i) => `p${i}`),
    );
    expect(up.stats.initialize).toBe(1);
    // Later calls reuse the session.
    await c.call("search", { q: "again" });
    expect(up.stats.initialize).toBe(1);
  });

  it("does not keep a failed handshake: the next call connects again", async () => {
    const up = await fakeUpstream({
      failInit: (n, res) => {
        if (n > 1) return false;
        res.writeHead(500).end("boom");
        return true;
      },
    });
    const c = client(up.url);
    await expect(c.call("search", { q: "x" })).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await expect(c.call("search", { q: "y" })).resolves.toMatchObject({ structuredContent: { echo: "y" } });
    expect(up.stats.initialize).toBe(2);
  });

  it("retries a call once when its connection drops, but not twice", async () => {
    const once = await fakeUpstream({ dropCall: (n) => n === 1 });
    await expect(client(once.url).call("search", { q: "x" })).resolves.toMatchObject({
      structuredContent: { echo: "x" },
    });
    expect(once.stats.toolCalls).toBe(2);

    const always = await fakeUpstream({ dropCall: () => true });
    await expect(client(always.url).call("search", { q: "x" })).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    expect(always.stats.toolCalls).toBe(2);
  });

  it("does not retry an error the server answered with", async () => {
    const up = await fakeUpstream({
      failInit: (_n, res) => {
        res.writeHead(500).end("boom");
        return true;
      },
    });
    await expect(client(up.url).call("search", { q: "x" })).rejects.toBeInstanceOf(AppError);
    expect(up.stats.initialize).toBe(1);
  });

  it("warm-up opens the session ahead of the first call", async () => {
    const up = await fakeUpstream();
    const c = client(up.url);
    await expect(c.warmUp()).resolves.toBe(true);
    expect(up.stats.initialize).toBe(1);
    await c.call("search", { q: "x" });
    expect(up.stats.initialize).toBe(1);
  });

  it("warm-up failure is logged, never thrown, and not kept", async () => {
    const up = await fakeUpstream({
      failInit: (n, res) => {
        if (n > 1) return false;
        res.writeHead(503).end("down");
        return true;
      },
    });
    const c = client(up.url, "flaky");
    const log = vi.fn();
    await expect(c.warmUp(log)).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^flaky: session warm-up failed/));
    await expect(c.call("search", { q: "x" })).resolves.toMatchObject({ structuredContent: { echo: "x" } });
  });

  it("warmUpUpstreams warms only enabled sources and never rejects", async () => {
    const up = await fakeUpstream();
    const enabled = client(up.url, `on-${randomUUID()}`);
    const disabled = client(up.url, `off-${randomUUID()}`);
    // Nothing listens on port 1: the connection is refused.
    const broken = client("http://127.0.0.1:1/mcp", `broken-${randomUUID()}`);
    const log = vi.fn();
    const names = new Set([enabled.name, broken.name]);
    await expect(warmUpUpstreams([enabled, disabled, broken], (n) => names.has(n), log)).resolves.toEqual(
      expect.arrayContaining([true, false]),
    );
    // Only the enabled working client connected; the disabled one was left alone.
    expect(up.stats.initialize).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^broken-.*: session warm-up failed/);
  });
});

describe("isConnectionError", () => {
  it("recognises fetch network failures through wrapping errors", () => {
    const cause = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    const fetchFailed = new TypeError("fetch failed", { cause });
    expect(isConnectionError(fetchFailed)).toBe(true);
    expect(isConnectionError(new AppError("UPSTREAM_UNAVAILABLE", "x", undefined, { cause }))).toBe(true);
    expect(isConnectionError(new AppError("UPSTREAM_UNAVAILABLE", "timed out"))).toBe(false);
    expect(isConnectionError(new TypeError("x is not a function"))).toBe(false);
  });
});
