export interface LatLng {
  lat: number;
  lng: number;
}

/** One price for one hotel from one source, as the source reported it. */
export interface PriceQuote {
  /** Provider id that returned this price, e.g. "trivago". */
  source: string;
  /** Booking site or advertiser the price belongs to, e.g. "Booking.com"; null when the source is the seller. */
  seller: string | null;
  per_night: number;
  total: number | null;
  currency: string;
  /** Per-night price converted to INR; null until converted or when no rate is available. */
  per_night_inr: number | null;
  /** true/false when the source states it; null when unknown (meta-search prices are often pre-tax). */
  includes_taxes: boolean | null;
  available: boolean | null;
  refundable: boolean | null;
  url: string | null;
  fetched_at: string;
}

/** A hotel as one source describes it. Merging across sources happens later. */
export interface HotelCandidate {
  source: string;
  source_id: string;
  name: string;
  lat: number;
  lng: number;
  stars: number | null;
  /** Guest review score normalised to a 0–10 scale. */
  rating_10: number | null;
  review_count: number | null;
  url: string | null;
  prices: PriceQuote[];
  fetched_at: string;
}

export interface HotelSearchQuery extends LatLng {
  radius_km: number;
  check_in: string;
  check_out: string;
  /** Guests in the single room searched for; every source is asked for one room. */
  adults: number;
  /**
   * Readable name of the search point (e.g. "New Delhi railway station, Delhi"), for sources that search by
   * text only. Google Hotels ignores coordinates in a query, so without a name it cannot search near a point.
   */
  place?: string | undefined;
  /** Set when looking up one known hotel: text-only sources then search for this name near `place`. */
  hotel_name?: string | undefined;
}
