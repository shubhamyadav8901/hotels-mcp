export type ErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "UPSTREAM_UNAVAILABLE"
  | "RATE_LIMITED"
  | "SCHEMA_CHANGED"
  | "QUOTA_EXHAUSTED"
  | "DISABLED"
  | "TIMEOUT"
  | "INTERNAL_ERROR";

/** An error whose message is safe to show to the model, with a code and a next-step hint. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AppError";
  }
}

const PROGRAMMING_ERRORS = [TypeError, RangeError, ReferenceError, SyntaxError];

/**
 * Normalises any thrown value. Programming errors (TypeError and friends) become INTERNAL_ERROR and are
 * logged with their stack, so a bug is never mistaken for a flaky upstream.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (PROGRAMMING_ERRORS.some((E) => err instanceof E)) {
    console.error("Internal error:", err);
    return new AppError("INTERNAL_ERROR", "Internal error in the hotels server", undefined, { cause: err });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new AppError("UPSTREAM_UNAVAILABLE", upstreamText(message), undefined, { cause: err });
}

/**
 * Text that originates upstream (error messages from third-party services) is shown only as a short,
 * single-line quote, so it cannot carry formatting or long instructions into the model's context.
 */
export function upstreamText(text: string | null | undefined, max = 160): string {
  const flat = (text ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
