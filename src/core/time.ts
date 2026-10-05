import { AppError } from "./errors.js";

const IST_OFFSET_MS = 5.5 * 3_600_000;

/** Parses an ISO-8601 datetime; one without an offset is taken as India Standard Time. */
export function parseIstDateTime(value: string): Date {
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const d = new Date(hasOffset ? value : `${value}+05:30`);
  if (Number.isNaN(d.getTime()) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    throw new AppError(
      "INVALID_INPUT",
      `Not an ISO-8601 datetime: ${value} (use e.g. 2026-11-10T20:10+05:30).`,
    );
  }
  return d;
}

/** YYYY-MM-DD of the instant in IST. */
export function istDate(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Hours and minutes of the instant in IST. */
export function istClock(d: Date): { hour: number; minute: number; text: string } {
  const iso = new Date(d.getTime() + IST_OFFSET_MS).toISOString();
  return { hour: Number(iso.slice(11, 13)), minute: Number(iso.slice(14, 16)), text: iso.slice(11, 16) };
}

/** ISO-8601 with the +05:30 offset, to the minute. */
export function istIso(d: Date): string {
  return `${new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16)}+05:30`;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
