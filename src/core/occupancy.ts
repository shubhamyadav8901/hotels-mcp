import type { PriceQuote } from "./types.js";

/**
 * How far a price can be trusted to be for ONE room holding the whole party:
 * - confirmed: the source names a room that fits the party (or it is a normal one/two-person stay it
 *   checked live);
 * - likely: the source searched for the party but does not name the room;
 * - unverified: the source is known to quote two rooms (or nonsense) for larger parties under a
 *   one-room request (trivago, Xotelo; live checks 2026-10-05).
 */
export type OccupancyLevel = "confirmed" | "likely" | "unverified";

export interface OccupancyLabel {
  occupancy: OccupancyLevel;
  occupancy_note: string | null;
}

/** Sources whose prices for more than two guests can be for two rooms although one was asked for. */
const MULTI_ROOM_RISK = new Set(["trivago", "xotelo"]);

/**
 * How many people a room name says it sleeps, or null when it doesn't say. Only explicit wording counts:
 * suites, studios, apartments and villas vary too much, and dormitory beds are sold per bed.
 */
export function roomCapacity(room: string): number | null {
  const name = room.toLowerCase();
  if (/\b(dorm|dormitory|bunk|bed in)\b/.test(name)) return null;
  const n = name.match(/\b(\d)[\s-]*(bed|bedded|person|persons|pax|people|guest|guests|sharing)\b/);
  if (n) return Number(n[1]);
  const words: [RegExp, number][] = [
    [/\b(2|two)\s*(double|queen|king)\s*beds?\b/, 4],
    [/\b(quad|quadruple|four)\b/, 4],
    [/\bfamily\b/, 4],
    [/\b(triple|three)\b/, 3],
  ];
  for (const [re, cap] of words) if (re.test(name)) return cap;
  return null;
}

export function occupancyLabel(q: PriceQuote, guests: number): OccupancyLabel {
  if (guests <= 2) {
    return q.source === "hotelscasa" && q.available === true
      ? { occupancy: "confirmed", occupancy_note: null }
      : { occupancy: "likely", occupancy_note: null };
  }
  if (MULTI_ROOM_RISK.has(q.source)) {
    return {
      occupancy: "unverified",
      occupancy_note: `${q.source} sometimes prices ${guests} guests as two rooms under a one-room request; get_hotel_rates with check_single_room compares it with the two-adult price.`,
    };
  }
  if (q.source === "hotelscasa") {
    const cap = q.room ? roomCapacity(q.room) : null;
    if (cap !== null && cap >= guests) return { occupancy: "confirmed", occupancy_note: null };
    return {
      occupancy: "likely",
      occupancy_note: !q.room
        ? `Offered for ${guests} guests; the room is not named.`
        : cap !== null
          ? `Offered for ${guests} guests, but the room name ("${q.room}") suggests it sleeps ${cap}; it may rely on extra beds.`
          : `Offered for ${guests} guests, but the room name ("${q.room}") does not say how many it sleeps; it may rely on extra beds.`,
    };
  }
  if (q.source === "serpapi") {
    return {
      occupancy: "likely",
      occupancy_note: `Google Hotels searched for ${guests} guests and leaves out hotels that cannot host them; it does not name the room.`,
    };
  }
  return { occupancy: "likely", occupancy_note: null };
}

/** Price to rank and filter a hotel by: its cheapest single-room price when it has one, else its cheapest. */
export function effectivePrice(h: { cheapest: PriceQuote | null; cheapest_single_room: PriceQuote | null }) {
  return h.cheapest_single_room ?? h.cheapest;
}

/** Cheapest price that is confirmed or likely to be for one room holding the party. */
export function cheapestSingleRoom(prices: PriceQuote[]): PriceQuote | null {
  let best: PriceQuote | null = null;
  for (const p of prices) {
    if (p.per_night_inr === null || p.available === false || p.occupancy === "unverified") continue;
    if (!best || p.per_night_inr < (best.per_night_inr as number)) best = p;
  }
  return best;
}

export type SingleRoomVerdict = "plausible_single_room" | "looks_like_2_rooms" | "implausible" | "unknown";

/** Largest party the doubling test can judge: beyond 4, three or more rooms make the ratio ambiguous. */
export const VERDICT_MAX_GUESTS = 4;

/**
 * Compares a price for a party of 3–4 with the same seller's two-adult price for the same hotel and dates.
 * About exactly double means two double rooms; four times or more is not a believable single room. Larger
 * parties are not judged: a three-room price (~3×) would look like a plausible single room.
 */
export function singleRoomVerdict(
  partyInr: number | null,
  twoAdultInr: number | null,
  guests: number,
): SingleRoomVerdict {
  if (guests > VERDICT_MAX_GUESTS) return "unknown";
  if (partyInr === null || twoAdultInr === null || twoAdultInr <= 0) return "unknown";
  const ratio = partyInr / twoAdultInr;
  if (ratio >= 4) return "implausible";
  if (Math.abs(ratio - 2) <= 0.03) return "looks_like_2_rooms";
  return "plausible_single_room";
}
