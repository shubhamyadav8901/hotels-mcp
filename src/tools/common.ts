import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { toAppError } from "../core/errors.js";

/** Every tool in this server only reads public data from the network. */
export function readOnly(title: string): ToolAnnotations {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
}

export function ok(structured: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: structured,
    content: [{ type: "text", text: JSON.stringify(structured) }],
  };
}

export function fail(err: unknown): CallToolResult {
  const e = toAppError(err);
  const body = { error: { code: e.code, message: e.message, hint: e.hint ?? null } };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
}

/** Wraps a handler so thrown errors become `isError` results instead of protocol errors. */
export function handle<A>(fn: (args: A) => Promise<Record<string, unknown>>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}
