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
  /** Room as the source names it (e.g. "Family Room with 2 Double Beds"), when the source says. */
  room: string | null;
  /** Meals included, as the source states them (e.g. "Room Only", "Breakfast included"); absent when not stated. */
  meal_plan?: string | null;
  fetched_at: string;
}

/** Everything else a source says about a hotel, shown in full by get_hotel_details. All parts are optional. */
export interface HotelDetails {
  description?: string;
  address?: string;
  phone?: string;
  website?: string;
  /** Photo URLs (a few). */
  images?: string[];
  /** As the source words it, e.g. "6.0 km to City centre". */
  distance_to_centre?: string;
  /** Location score on a 0–5 scale (Google). */
  location_rating?: number;
  /** Category scores, e.g. HotelsCasa's cleanliness/staff, on the source's own scale. */
  category_scores?: { name: string; score: number }[];
  /** What reviews praise and criticise, in the source's words. */
  pros?: string[];
  cons?: string[];
  /** Review topics with how often they are mentioned and how (Google; TripAdvisor mentions). */
  review_topics?: { name: string; mentions: number; positive?: number; negative?: number }[];
  /** Nearby places with how long it takes to reach them (Google). */
  nearby_places?: { name: string; travel?: string }[];
  /** Conditions guests must know, e.g. ID or marriage certificate required. */
  important_info?: string[];
  /** Amenities the source says the property does not have. */
  excluded_amenities?: string[];
  /** Badges the source shows, e.g. "Travellers' Choice". */
  labels?: string[];
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
  /** Kind of property as the source labels it (e.g. "Hotel", "Guest house", "Vacation rental"). */
  property_type?: string | null;
  /** Amenities the source lists for the property (its own wording). */
  amenities?: string[];
  /** Area or locality the source places it in (e.g. "Kochi"). */
  area?: string | null;
  /** Check-in / check-out times the source states (e.g. "2:00 PM"). */
  check_in_time?: string | null;
  check_out_time?: string | null;
  /** The source's usual nightly price range for the property, independent of these dates. */
  typical_price?: { min: number; max: number; currency: string } | null;
  /** Further details, kept for get_hotel_details (search results leave them out). */
  details?: HotelDetails;
}

export interface HotelSearchQuery extends LatLng {
  radius_km: number;
  check_in: string;
  check_out: string;
  /** Adults in the single room searched for; every source is asked for one room. */
  adults: number;
  /** Ages (0–17) of children sharing that room, one entry per child. */
  children_ages?: number[] | undefined;
  /**
   * Readable name of the search point (e.g. "New Delhi railway station, Delhi"), for sources that search by
   * text only. Google Hotels ignores coordinates in a query, so without a name it cannot search near a point.
   */
  place?: string | undefined;
  /** `place` is a town or area ("hotels in X") rather than a point of interest ("hotels near X"). */
  place_is_area?: boolean | undefined;
  /**
   * What the caller will sort and filter by. Sources that support it apply it server-side, so their single
   * page of results is the right page (e.g. Google's cheapest 20 rather than its top 20 by relevance).
   */
  prefer?:
    | {
        sort?: "distance" | "price" | "rating";
        min_stars?: number;
        max_price_inr?: number;
        /**
         * Minimum guest rating on a 0–10 scale. Not sent to sources: each would filter on its own rating and
         * could drop its (possibly cheapest) price for a hotel whose merged rating passes. Applied after merging.
         */
        min_rating_10?: number;
      }
    | undefined;
  /** Set when looking up one known hotel: text-only sources then search for this name near `place`. */
  hotel_name?: string | undefined;
}
