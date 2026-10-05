/**
 * Writes docs/tools.md from the server's own tool definitions (MCP tools/list), so the reference always matches
 * what clients see: every tool's description, input fields (type, required, default, limits, description) and
 * output fields.
 *
 *   npm run docs:tools          # regenerate docs/tools.md
 *   npm run docs:check          # fail if docs/tools.md is out of date (used in CI)
 *
 * Defaults are the server's built-in defaults (no .env), e.g. min_rating_pct 0.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createDeps, createServer, SERVER_NAME, SERVER_VERSION } from "../src/mcp.js";

type Schema = {
  type?: string | string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  anyOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: string;
};

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "tools.md");
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();

/** Collapses nullable unions (`anyOf: [X, {type: null}]`) into X plus a nullable flag. */
function unwrap(s: Schema): { schema: Schema; nullable: boolean } {
  if (s.anyOf) {
    const rest = s.anyOf.filter((x) => x.type !== "null");
    const nullable = rest.length < s.anyOf.length;
    if (rest.length === 1)
      return { schema: { ...rest[0]!, description: s.description ?? rest[0]!.description }, nullable };
  }
  if (Array.isArray(s.type) && s.type.includes("null")) {
    return { schema: { ...s, type: s.type.filter((t) => t !== "null") }, nullable: true };
  }
  return { schema: s, nullable: false };
}

function typeOf(s: Schema): string {
  const { schema, nullable } = unwrap(s);
  let t: string;
  if (schema.enum) t = schema.enum.map((v) => `\`${JSON.stringify(v)}\``).join(" \\| ");
  else if (schema.anyOf) t = schema.anyOf.map(typeOf).join(" \\| ");
  else if (schema.type === "array") t = `${schema.items ? typeOf(schema.items) : "any"}[]`;
  else t = Array.isArray(schema.type) ? schema.type.join(" \\| ") : (schema.type ?? "any");
  return nullable ? `${t} \\| null` : t;
}

function limits(s: Schema): string {
  const { schema } = unwrap(s);
  const out: string[] = [];
  if (schema.minimum !== undefined) out.push(`≥ ${schema.minimum}`);
  if (schema.exclusiveMinimum !== undefined) out.push(`> ${schema.exclusiveMinimum}`);
  // zod's .int() adds Number.MAX_SAFE_INTEGER as a maximum; it isn't a real limit.
  if (schema.maximum !== undefined && schema.maximum < Number.MAX_SAFE_INTEGER)
    out.push(`≤ ${schema.maximum}`);
  if (schema.minLength !== undefined) out.push(`length ≥ ${schema.minLength}`);
  if (schema.maxLength !== undefined) out.push(`length ≤ ${schema.maxLength}`);
  if (schema.minItems !== undefined) out.push(`items ≥ ${schema.minItems}`);
  if (schema.maxItems !== undefined) out.push(`items ≤ ${schema.maxItems}`);
  if (schema.pattern) out.push(`pattern \`${schema.pattern}\``);
  if (schema.format) out.push(schema.format);
  const items = schema.type === "array" && schema.items ? unwrap(schema.items).schema : undefined;
  if (items?.minimum !== undefined || items?.maximum !== undefined) {
    out.push(
      `each ${[items.minimum !== undefined ? `≥ ${items.minimum}` : "", items.maximum !== undefined ? `≤ ${items.maximum}` : ""].filter(Boolean).join(", ")}`,
    );
  }
  return out.join(", ");
}

/** One row per field, nested objects and arrays of objects expanded with dotted paths (`hotels[].name`). */
function rows(
  props: Record<string, Schema>,
  required: string[],
  prefix: string,
  withInputCols: boolean,
): string[] {
  const out: string[] = [];
  for (const [name, raw] of Object.entries(props)) {
    const { schema } = unwrap(raw);
    const path = `${prefix}${name}`;
    const desc = cell(raw.description ?? schema.description ?? "");
    if (withInputCols) {
      const def =
        schema.default !== undefined
          ? `\`${JSON.stringify(schema.default)}\``
          : raw.default !== undefined
            ? `\`${JSON.stringify(raw.default)}\``
            : "";
      const req = required.includes(name) && def === "" ? "yes" : "";
      out.push(`| \`${path}\` | ${typeOf(raw)} | ${req} | ${def} | ${cell(limits(raw))} | ${desc} |`);
    } else {
      out.push(`| \`${path}\` | ${typeOf(raw)} | ${desc} |`);
    }
    const obj =
      schema.type === "object"
        ? schema
        : schema.type === "array" && schema.items
          ? unwrap(schema.items).schema
          : undefined;
    if (obj?.type === "object" && obj.properties) {
      const childPrefix = schema.type === "array" ? `${path}[].` : `${path}.`;
      out.push(...rows(obj.properties, obj.required ?? [], childPrefix, withInputCols));
    }
  }
  return out;
}

async function render(): Promise<string> {
  const deps = createDeps(loadConfig({}));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gen-tool-docs", version: "0" });
  await Promise.all([createServer(deps).connect(b), client.connect(a)]);
  const { tools } = await client.listTools();

  const lines: string[] = [
    "# Tool reference",
    "",
    `<!-- Generated by \`npm run docs:tools\` from the server's tools/list (${SERVER_NAME} ${SERVER_VERSION}). Do not edit by hand. -->`,
    "",
    "Every tool is read-only. Inputs and outputs below are exactly what MCP clients receive from `tools/list`;",
    "defaults are the server's built-in ones (`min_rating_pct` follows `DEFAULT_MIN_RATING_PCT`, 0 unless set).",
    "Every response also carries the same JSON as text, and errors come back as",
    '`{"error": {"code", "message", "hint"}}` with `isError: true`.',
    "",
    ...tools.map((t) => `- [\`${t.name}\`](#${t.name}) — ${t.annotations?.title ?? t.title ?? ""}`),
    "",
  ];
  for (const t of tools) {
    const input = t.inputSchema as Schema;
    const output = t.outputSchema as Schema | undefined;
    lines.push(
      `## ${t.name}`,
      "",
      `**${t.annotations?.title ?? t.title ?? t.name}**`,
      "",
      t.description ?? "",
      "",
    );
    lines.push("### Input", "");
    if (input.properties && Object.keys(input.properties).length) {
      lines.push("| Field | Type | Required | Default | Limits | Description |", "|---|---|---|---|---|---|");
      lines.push(...rows(input.properties, input.required ?? [], "", true), "");
    } else {
      lines.push("No inputs.", "");
    }
    if (output?.properties) {
      lines.push("### Output", "", "| Field | Type | Description |", "|---|---|---|");
      lines.push(...rows(output.properties, output.required ?? [], "", false), "");
    }
  }
  await client.close();
  return lines.join("\n");
}

const md = await render();
if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== md) {
    console.error("docs/tools.md is out of date. Run `npm run docs:tools` and commit the result.");
    process.exit(1);
  }
  console.error("docs/tools.md is up to date.");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, md);
  console.error(`Wrote ${OUT}`);
}
process.exit(0);
