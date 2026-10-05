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
  // Dormitory beds are sold per bed, and a multi-bedroom unit is several rooms: neither says how many one
  // room sleeps. A "1 Bedroom" note doesn't hide the room's own capacity ("Family Quadruple Room, 1 Bedroom").
  if (/\b(dorm|dormitory|bunk|bed in)\b/.test(name) || bedroomCount(name) > 1) return null;
  const withoutBedrooms = name.replace(/\b(\d+|one|single)[\s-]*(bedrooms?|bhk)\b/g, " ");
  // "2 Adults + 2 Children" sleeps four.
  const party = withoutBedrooms.match(/\b(\d)\s*adults?\b.*?\b(\d)\s*(child|children|kids?)\b/);
  if (party) return Number(party[1]) + Number(party[2]);
  const n = withoutBedrooms.match(
    /\b(\d)[\s-]*(bed|bedded|person|persons|pax|people|guest|guests|adult|adults|sharing)\b/,
  );
  if (n) return Number(n[1]);
  const words: [RegExp, number][] = [
    [/\b(2|two)\s*(double|queen|king)\s*beds?\b/, 4],
    [/\b(quad|quadruple|four)\b/, 4],
    [/\bfamily\b/, 4],
    [/\b(triple|three)\b/, 3],
  ];
  for (const [re, cap] of words) if (re.test(withoutBedrooms)) return cap;
  return null;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  single: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

/** Bedrooms a unit name declares ("Two Bedroom Apartment", "3BHK", "2-Bedroom Villa"); 0 when it doesn't say. */
export function bedroomCount(room: string): number {
  const m = room.toLowerCase().match(/\b(\d+|one|single|two|three|four|five|six)[\s-]*(bedrooms?|bhk)\b/);
  if (!m) return 0;
  return /^\d+$/.test(m[1]!) ? Number(m[1]) : (NUMBER_WORDS[m[1]!] ?? 0);
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
  // A whole multi-bedroom unit (apartment, villa) is several rooms, whatever the source.
  const bedrooms = q.room ? bedroomCount(q.room) : 0;
  if (bedrooms > 1) {
    return {
      occupancy: "unverified",
      occupancy_note: `"${q.room}" is a whole ${bedrooms}-bedroom unit, not a single room.`,
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

export type SingleRoomVerdict =
  | "priced_as_2_adults"
  | "plausible_single_room"
  | "looks_like_2_rooms"
  | "unusually_high"
  | "implausible"
  | "unknown";

export const SINGLE_ROOM_VERDICTS = [
  "priced_as_2_adults",
  "plausible_single_room",
  "looks_like_2_rooms",
  "unusually_high",
  "implausible",
  "unknown",
] as const;

/** Largest party the doubling test can judge: beyond 4, three or more rooms make the ratio ambiguous. */
export const VERDICT_MAX_GUESTS = 4;

/**
 * Compares a price for a party of 3–4 with the same seller's two-adult price for the same hotel and dates
 * (bands from live checks, 2026-10-05):
 * - ≤1.1×: the seller ignored the party size, so it is probably a two-person room;
 * - 1.1–1.85×: an extra-guest charge or a bigger room — plausible as one room;
 * - 1.85–2.15×: about double — looks like two rooms;
 * - 2.15–4×: unusually high for one room; check the room type;
 * - ≥4×: not a believable single-room price.
 * Larger parties are not judged: three rooms (~3×) would be ambiguous.
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
  if (ratio > 2.15) return "unusually_high";
  if (ratio >= 1.85) return "looks_like_2_rooms";
  if (ratio <= 1.1) return "priced_as_2_adults";
  return "plausible_single_room";
}
