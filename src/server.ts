#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { loadConfig } from "./config.js";
import { DEFAULT_ALLOWED_HOSTS, hostCheck } from "./http-guard.js";
import { createDeps, createServer, type Deps } from "./mcp.js";

async function runStdio(deps: Deps): Promise<void> {
  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
}

/** Stateless Streamable HTTP: one server + transport per request, shared deps (caches, registry). */
function runHttp(deps: Deps): void {
  const { HOST, PORT, ALLOWED_HOSTS } = deps.config;
  const allowedHosts = ALLOWED_HOSTS.length ? ALLOWED_HOSTS : DEFAULT_ALLOWED_HOSTS;
  const app = express();
  // DNS-rebinding protection: only accept requests addressed to an allowed hostname (any port, so a
  // remapped Docker port still works).
  app.use(hostCheck(allowedHosts));
  app.use(express.json({ limit: "1mb" }));

  app.post("/mcp", async (req, res) => {
    const server = createServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) {
        res
          .status(500)
          .json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res
      .status(405)
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.listen(PORT, HOST, () => {
    console.error(
      `india-hotels MCP listening on http://${HOST}:${PORT}/mcp (allowed hosts: ${allowedHosts.join(", ")})`,
    );
  });
}

const deps = createDeps(loadConfig());
const missing = deps
  .snapshots()
  .filter((s) => s.rows === 0)
  .map((s) => s.id);
if (missing.length) {
  console.error(
    `Warning: bundled datasets missing or empty: ${missing.join(", ")} (run npm run build:data).`,
  );
}
if (process.argv.includes("--http")) runHttp(deps);
else await runStdio(deps);
