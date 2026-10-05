import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import { hostCheck } from "../src/http-guard.js";

describe("hostCheck (DNS-rebinding protection)", () => {
  const check = hostCheck(["localhost", "127.0.0.1", "[::1]", "tunnel.example.com:443"]);

  function run(host: string | undefined) {
    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    check({ headers: { host } } as unknown as Request, res as unknown as Response, next);
    return { allowed: next.mock.calls.length === 1, status: res.status.mock.calls[0]?.[0] };
  }

  it.each([
    "localhost:3000",
    "localhost:3918",
    "127.0.0.1:5000",
    "[::1]:3000",
    "LOCALHOST:3000",
    "tunnel.example.com",
  ])("allows %s", (host) => {
    expect(run(host).allowed).toBe(true);
  });

  it.each(["evil.example:3000", "localhost.evil.example", "", undefined])("rejects %s with 403", (host) => {
    expect(run(host)).toEqual({ allowed: false, status: 403 });
  });
});
