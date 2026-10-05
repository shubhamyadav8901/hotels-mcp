import type { z } from "zod";
import { AppError } from "../core/errors.js";

/** Parses a display amount such as "₹21,689", "US$ 1,234.50" or "8.1" into a number; null if none. */
export function parseAmount(text: string | number | null | undefined): number | null {
  if (typeof text === "number") return Number.isFinite(text) ? text : null;
  if (!text) return null;
  const match = text.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/** Validates an upstream payload; a mismatch means the upstream changed shape, never "no results". */
export function parseUpstream<S extends z.ZodType>(provider: string, schema: S, data: unknown): z.infer<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first ? `${first.path.join(".")}: ${first.message}` : "unknown";
    throw new AppError(
      "SCHEMA_CHANGED",
      `${provider} returned data in an unexpected shape (${where})`,
      "The source may have changed its format; other sources are unaffected.",
    );
  }
  return parsed.data;
}
