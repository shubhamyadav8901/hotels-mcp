import type { RequestHandler } from "express";

export const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Rejects requests whose Host header names a hostname outside `allowed` (compared without the port). */
export function hostCheck(allowed: readonly string[]): RequestHandler {
  const names = new Set(allowed.map((h) => h.toLowerCase().replace(/:\d+$/, "")));
  return (req, res, next) => {
    const host = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    if (names.has(host)) return next();
    res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Host not allowed" }, id: null });
  };
}
