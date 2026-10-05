import { AppError } from "../core/errors.js";

export interface HttpOptions {
  userAgent: string;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/** GET a JSON document with timeout, a single retry on network errors/5xx, and mapped error codes. */
export async function getJson<T = unknown>(url: string, opts: HttpOptions): Promise<T> {
  const { userAgent, timeoutMs = 8000, retries = 1, headers = {}, fetchImpl = fetch } = opts;
  const host = new URL(url).host;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { "User-Agent": userAgent, Accept: "application/json", ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError = err;
      continue;
    }

    if (res.status === 429) {
      throw new AppError("RATE_LIMITED", `${host} is rate limiting requests`, "Try again in a minute.");
    }
    if (res.status === 404) {
      throw new AppError("NOT_FOUND", `${host} returned 404 for this request`);
    }
    if (res.status >= 500) {
      lastError = new Error(`${host} returned HTTP ${res.status}`);
      continue;
    }
    if (!res.ok) {
      throw new AppError("UPSTREAM_UNAVAILABLE", `${host} returned HTTP ${res.status}`);
    }

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new AppError("SCHEMA_CHANGED", `${host} returned a non-JSON response`, undefined, { cause: err });
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new AppError("UPSTREAM_UNAVAILABLE", `${host} is unreachable: ${reason}`, undefined, {
    cause: lastError,
  });
}
