import type { PriceQuote } from "./types.js";

/**
 * Whether a price is for ONE room holding the whole party, and on what evidence. Sources mostly show only
 * the cheapest offer per booking site, and for 3+ guests that is often two rooms (trivago's price for 4
 * adults in one room matched its two-room price at every hotel checked, 2026-10-05), while a pricier room
 * for the party may exist. So a price is called one room or two rooms only on evidence, never by default:
 * - one_room: a room name that sleeps the party, or a site's rate stated for that many guests;
 * - two_rooms: a combo or multi-bedroom unit by name, or about exactly double (1.9–2.15x) the same booking
 *   site's 2-adult price for the hotel;
 * - unknown: anything else (the note says what is known). For 1–2 guests every price is one room.
 */
export const ROOM_FITS = ["one_room", "two_rooms", "unknown"] as const;
export type RoomFitValue = (typeof ROOM_FITS)[number];
export const FIT_BASES = ["party_search", "room_name", "room_capacity", "price_ratio", "none"] as const;
export type FitBasis = (typeof FIT_BASES)[number];

export interface RoomFit {
  fit: RoomFitValue;
  fit_basis: FitBasis;
  fit_note: string | null;
}

/** The fit values in one sentence, for tool schemas. */
export const ROOM_FIT_TEXT =
  "one_room (a room name that sleeps the party, or a booking site's rate stated for that many guests; every price for 1–2 guests), two_rooms (a combo or multi-bedroom unit by name, or about exactly double the same booking site's 2-adult price), unknown (not shown to be either; fit_note says what is known).";
export const FIT_BASIS_TEXT =
  "Evidence for fit: party_search (the source was searched for the party; proves one room only for 1–2 guests), room_name (the room's name), room_capacity (the booking site's stated guest count for the rate), price_ratio (compared with the same booking site's 2-adult price), none.";

/** Sources that show only the cheapest offer per booking site, with no room name. */
export const CHEAPEST_OFFER_ONLY: ReadonlySet<string> = new Set(["trivago", "xotelo"]);
/** About exactly double the 2-adult price: the usual sign of two rooms. A family room is often 2.5x or more. */
const TWO_ROOMS_RATIO = { min: 1.9, max: 2.15 };
/** Largest party the doubling test can judge: beyond 4, three rooms would not show as doubling. */
export const RATIO_MAX_GUESTS = 4;
const COMBO = /\b(combo|combination)\b|\b(2|two)\s*rooms\b|\b\d\s*x\s*rooms?\b/i;

const fitOf = (fit: RoomFitValue, fit_basis: FitBasis, fit_note: string | null): RoomFit => ({
  fit,
  fit_basis,
  fit_note,
});

export function roomFit(q: PriceQuote, guests: number): RoomFit {
  if (guests <= 2) return fitOf("one_room", "party_search", null);
  const room = q.room;
  const site = q.seller ?? q.source;
  if (room && COMBO.test(room)) return fitOf("two_rooms", "room_name", `"${room}" is several rooms.`);
  const bedrooms = room ? bedroomCount(room) : 0;
  if (bedrooms > 1) {
    return fitOf("two_rooms", "room_name", `"${room}" is a whole ${bedrooms}-bedroom unit, not one room.`);
  }
  if (q.room_guests != null) {
    return q.room_guests >= guests
      ? fitOf(
          "one_room",
          "room_capacity",
          `${site} states this rate for ${q.room_guests} guests${room ? ` ("${room}")` : ""}.`,
        )
      : fitOf(
          "unknown",
          "room_capacity",
          `${site} states this rate for ${q.room_guests} guests, fewer than ${guests}.`,
        );
  }
  const cap = room ? roomCapacity(room) : null;
  if (cap !== null && cap >= guests && q.priced_for_guests !== undefined && q.priced_for_guests < guests) {
    return fitOf(
      "unknown",
      "room_name",
      `"${room}" sleeps ${cap}, but this price is for ${q.priced_for_guests} guests; for ${guests} it may cost more.`,
    );
  }
  if (cap !== null && cap >= guests) return fitOf("one_room", "room_name", `"${room}" sleeps ${cap}.`);
  if (cap !== null) {
    return fitOf("unknown", "room_name", `"${room}" sleeps ${cap}; ${guests} guests may need an extra bed.`);
  }
  if (CHEAPEST_OFFER_ONLY.has(q.source)) {
    const base = q.two_adult_per_night ?? null;
    const ratio = base ? Math.round((q.per_night / base) * 100) / 100 : null;
    if (
      ratio !== null &&
      guests <= RATIO_MAX_GUESTS &&
      ratio >= TWO_ROOMS_RATIO.min &&
      ratio <= TWO_ROOMS_RATIO.max
    ) {
      return fitOf(
        "two_rooms",
        "price_ratio",
        `${ratio}x ${site}'s 2-adult price for this hotel: the usual sign of two rooms. A room for ${guests} may exist at a higher price.`,
      );
    }
    return fitOf(
      "unknown",
      ratio !== null ? "price_ratio" : "none",
      `${q.source} shows only the cheapest offer per booking site, which for ${guests} guests is often two rooms` +
        (ratio !== null ? `; this is ${ratio}x ${site}'s 2-adult price.` : "."),
    );
  }
  if (q.source === "hotelscasa") {
    return fitOf(
      "unknown",
      "party_search",
      room
        ? `Offered for ${guests} guests as "${room}", which does not say how many it sleeps.`
        : `Offered for ${guests} guests; the room is not named.`,
    );
  }
  if (q.source === "serpapi") {
    return fitOf(
      "unknown",
      "party_search",
      `Google lists this hotel for ${guests} guests, but this price names no room and can be a multi-room deal.`,
    );
  }
  return fitOf("unknown", "none", null);
}

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

export const ROOM_STATUSES = ["one_room", "unverified", "two_rooms_only"] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];
export const ROOM_STATUS_TEXT =
  "one_room (at least one price is one room for the party), two_rooms_only (every price found is two rooms; a room for the party may still exist at a higher price), unverified (otherwise).";

const bookable = (p: PriceQuote) => p.per_night_inr !== null && p.available !== false;

function cheapestOf(prices: PriceQuote[], keep: (p: PriceQuote) => boolean): PriceQuote | null {
  let best: PriceQuote | null = null;
  for (const p of prices) {
    if (!bookable(p) || !keep(p)) continue;
    if (!best || (p.per_night_inr as number) < (best.per_night_inr as number)) best = p;
  }
  return best;
}

/** Cheapest price that is one room for the party. */
export function cheapestOneRoom(prices: PriceQuote[]): PriceQuote | null {
  return cheapestOf(prices, (p) => p.fit === "one_room");
}

/** From every bookable price, converted to INR or not: an unconverted one-room price still counts. */
export function roomStatus(prices: PriceQuote[]): RoomStatus {
  const offered = prices.filter((p) => p.available !== false);
  if (offered.some((p) => p.fit === "one_room")) return "one_room";
  return offered.length > 0 && offered.every((p) => p.fit === "two_rooms") ? "two_rooms_only" : "unverified";
}

/**
 * Price a hotel is ranked and filtered by: its cheapest one-room price, else its cheapest price not known to
 * be two rooms, else its cheapest (two-room) price.
 */
export function rankPrice(prices: PriceQuote[]): PriceQuote | null {
  return (
    cheapestOneRoom(prices) ??
    cheapestOf(prices, (p) => p.fit !== "two_rooms") ??
    cheapestOf(prices, () => true)
  );
}
