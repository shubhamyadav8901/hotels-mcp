import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AppError, upstreamText } from "../core/errors.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";

/** The parts of a CallToolResult we read from upstream servers. */
export interface UpstreamResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: unknown[];
}

export type CallUpstream = (tool: string, args: Record<string, unknown>) => Promise<UpstreamResult>;

/**
 * A client for a third-party hosted MCP server. Only tools in `allowedTools` can be called, so booking,
 * payment or other side-effecting tools an upstream offers are never reachable, whatever their annotations say.
 */
export class UpstreamMcpClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(
    private readonly name: string,
    private readonly url: string,
    private readonly allowedTools: readonly string[],
    private readonly timeoutMs: number,
    private readonly userAgent: string,
  ) {}

  readonly call: CallUpstream = async (tool, args) => {
    if (!this.allowedTools.includes(tool)) {
      throw new AppError("INTERNAL_ERROR", `${this.name}: tool ${tool} is not allow-listed`);
    }
    const client = await this.connect();
    try {
      return await this.callOnce(client, tool, args);
    } catch (err) {
      // Hosted servers drop sessions (trivago answers 404 "Invalid session ID"); reconnect and retry once.
      if (isSessionLost(err)) {
        await this.reset(client);
        return this.callOnce(await this.connect(), tool, args);
      }
      throw err;
    }
  };

  private async callOnce(
    client: Client,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<UpstreamResult> {
    try {
      return (await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: this.timeoutMs,
      })) as UpstreamResult;
    } catch (err) {
      if (isSessionLost(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const code = /timed? ?out/i.test(message) ? "timed out" : upstreamText(message);
      throw new AppError("UPSTREAM_UNAVAILABLE", `${this.name} call failed: ${code}`, undefined, {
        cause: err,
      });
    }
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new Client({ name: `${SERVER_NAME}-mcp`, version: SERVER_VERSION });
        const transport = new StreamableHTTPClientTransport(new URL(this.url), {
          requestInit: { headers: { "User-Agent": this.userAgent } },
        });
        try {
          await client.connect(transport, { timeout: this.timeoutMs });
        } catch (err) {
          const message = upstreamText(err instanceof Error ? err.message : String(err));
          throw new AppError("UPSTREAM_UNAVAILABLE", `${this.name} is unreachable: ${message}`, undefined, {
            cause: err,
          });
        }
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  /** Drops `stale` if it is still the current client; a concurrent caller may already have replaced it. */
  private async reset(stale: Client): Promise<void> {
    if (this.client === stale) this.client = null;
    await stale.close().catch(() => undefined);
  }
}

function isSessionLost(err: unknown): boolean {
  if (err instanceof StreamableHTTPError && err.code === 404) return true;
  return err instanceof Error && /invalid session/i.test(err.message);
}
