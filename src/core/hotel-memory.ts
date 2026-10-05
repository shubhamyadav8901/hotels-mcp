import { TtlCache } from "../lib/cache.js";
import type { MergedHotel } from "./merge.js";

const TTL_MS = 6 * 3_600_000;

/** A hotel from a recent search, with the stay and party its prices were quoted for. */
export interface RememberedHotel {
  hotel: MergedHotel;
  check_in: string;
  check_out: string;
  adults: number;
  children_ages: number[];
}

/** Remembers hotels returned by recent searches so later tools can take a hotel_id. */
export class HotelMemory {
  private readonly cache = new TtlCache<RememberedHotel>(5000);

  remember(hotels: MergedHotel[], quotedFor: Omit<RememberedHotel, "hotel">): void {
    for (const hotel of hotels) {
      const entry = { hotel, ...quotedFor };
      for (const id of [hotel.hotel_id, ...hotel.also_ids]) this.cache.set(id, entry, TTL_MS);
    }
  }

  get(id: string): RememberedHotel | undefined {
    return this.cache.get(id);
  }
}
