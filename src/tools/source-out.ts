import { z } from "zod";
import type { HotelCandidate, PriceQuote } from "../core/types.js";

/** One offer as a source reports it. */
export const OfferOut = z.object({
  seller: z
    .string()
    .nullable()
    .describe(
      "Booking site of the offer, e.g. Agoda (null when the source names none; then it sells the room itself).",
    ),
  per_night_inr: z
    .number()
    .nullable()
    .describe("Per-night price converted to INR (null if no exchange rate)."),
  per_night: z.number().describe("Per-night price in the source's currency."),
  currency: z.string().describe("ISO currency code of per_night and total, e.g. INR or EUR."),
  total: z.number().nullable().describe("Price for the whole stay in that currency (null when not given)."),
  includes_taxes: z
    .boolean()
    .nullable()
    .describe("Whether the price includes taxes such as GST (null when the source does not say)."),
  refundable: z.boolean().nullable().describe("Whether the rate is refundable (null when not stated)."),
  available: z
    .boolean()
    .nullable()
    .describe("Whether the source reports it bookable for these dates (null when not stated)."),
  room: z.string().nullable().describe("Room as the source names it (null when it does not say)."),
  meal_plan: z.string().optional().describe("Meals included as the source states them, e.g. Room Only."),
  url: z.string().nullable().describe("Link to the offer at the source, when given."),
});

/** Everything else a source says about the hotel (get_hotel_details only). */
export const DetailsOut = z
  .object({
    description: z.string().optional().describe("The source's description of the property."),
    address: z.string().optional().describe("Street address."),
    phone: z.string().optional().describe("Phone number."),
    website: z.string().optional().describe("The property's own website."),
    images: z.array(z.string()).optional().describe("A few photo URLs."),
    distance_to_centre: z
      .string()
      .optional()
      .describe('Distance to the city centre as the source words it, e.g. "6.0 km to City centre".'),
    location_rating: z.number().optional().describe("Location score on a 0–5 scale (Google)."),
    category_scores: z
      .array(
        z.object({
          name: z.string().describe("Category, e.g. Cleanliness."),
          score: z.number().describe("Score on the source's own scale."),
        }),
      )
      .optional()
      .describe("Review scores by category."),
    pros: z.array(z.string()).optional().describe("What reviews praise, in the source's words."),
    cons: z.array(z.string()).optional().describe("What reviews criticise, in the source's words."),
    review_topics: z
      .array(
        z.object({
          name: z.string().describe("Topic, e.g. Location or Public transit."),
          mentions: z.number().describe("How many reviews mention it."),
          positive: z.number().optional().describe("How many of those are positive."),
          negative: z.number().optional().describe("How many of those are negative."),
        }),
      )
      .optional()
      .describe("Review topics with how often and how they are mentioned."),
    nearby_places: z
      .array(
        z.object({
          name: z.string().describe("Place."),
          travel: z.string().optional().describe('How to get there, e.g. "Walking 1 min".'),
        }),
      )
      .optional()
      .describe("Nearby places the source lists."),
    important_info: z.array(z.string()).optional().describe("Conditions guests must know, e.g. ID required."),
    excluded_amenities: z
      .array(z.string())
      .optional()
      .describe("Amenities the source says the property does not have."),
    labels: z.array(z.string()).optional().describe("Badges the source shows."),
  })
  .describe("Further details from this source; get_hotel_details only.");

/**
 * One source's own listing of a hotel: its name, rating, details, link and offers. A source that lists the hotel
 * twice gets one section (the first listing's details, both listings' offers).
 */
export const SourceOut = z.object({
  source: z
    .string()
    .describe("Data source id: trivago, hotelscasa, xotelo, serpapi (Google Hotels) or osm_lodging."),
  source_id: z
    .string()
    .describe("The hotel's id at this source; source:source_id is one of the hotel's ids."),
  name: z.string().describe("Hotel name as this source gives it."),
  rating_10: z
    .number()
    .nullable()
    .describe("This source's guest rating on a 0–10 scale (5-point scales doubled); null if unrated."),
  review_count: z.number().nullable().describe("Number of reviews behind rating_10 at this source."),
  stars: z.number().nullable().describe("Hotel class this source gives, 1–5 stars (null if none)."),
  property_type: z
    .string()
    .optional()
    .describe("Kind of property as the source labels it, e.g. Hotel, Homestay."),
  area: z.string().optional().describe("Area or locality the source places it in."),
  amenities: z.array(z.string()).optional().describe("Amenities the source lists, in its own words."),
  check_in_time: z.string().optional().describe("Check-in time the source states."),
  check_out_time: z.string().optional().describe("Check-out time the source states."),
  typical_price: z
    .object({
      min: z.number().describe("Low end of the usual nightly price."),
      max: z.number().describe("High end of the usual nightly price."),
      currency: z.string().describe("Currency of min and max."),
    })
    .optional()
    .describe("The source's usual nightly price range for the property, independent of these dates."),
  url: z.string().nullable().describe("The hotel's page at this source, when given."),
  details: DetailsOut.optional(),
  cheapest_inr: z
    .number()
    .nullable()
    .describe("Lowest per_night_inr among this source's bookable offers (null if none)."),
  offers: z.array(OfferOut).describe("This source's offers for the stay and party, cheapest first."),
  offers_total: z.number().describe("How many offers the source returned (offers may list fewer)."),
  fetched_at: z.string().describe("ISO time this source answered."),
});

export type SourceOutT = z.infer<typeof SourceOut>;

const byInr = (a: PriceQuote, b: PriceQuote) =>
  (a.per_night_inr ?? Number.POSITIVE_INFINITY) - (b.per_night_inr ?? Number.POSITIVE_INFINITY);

const offerOut = (p: PriceQuote): z.infer<typeof OfferOut> => ({
  seller: p.seller,
  per_night_inr: p.per_night_inr,
  per_night: p.per_night,
  currency: p.currency,
  total: p.total,
  includes_taxes: p.includes_taxes,
  refundable: p.refundable,
  available: p.available,
  room: p.room,
  ...(p.meal_plan ? { meal_plan: p.meal_plan } : {}),
  url: p.url,
});

/**
 * Groups a hotel's prices by source, with each source's own listing details. `prices` is the final price list
 * (a re-check may have replaced a source's prices), so offers come from it and details from the listings; a
 * source with prices but no listing gets the hotel's name. Sections are ordered cheapest first, unpriced last.
 */
export function sourcesOut(
  hotel: { name: string; hotel_id: string; also_ids: string[]; listings: HotelCandidate[] },
  prices: PriceQuote[],
  opts: { maxOffers?: number; maxAmenities?: number; details?: boolean } = {},
): SourceOutT[] {
  const ids = [...new Set([...hotel.listings.map((l) => l.source), ...prices.map((p) => p.source)])];
  const sections = ids.map((source): SourceOutT => {
    const listing = hotel.listings.find((l) => l.source === source);
    const own = prices.filter((p) => p.source === source).sort(byInr);
    const offers = opts.maxOffers === undefined ? own : own.slice(0, opts.maxOffers);
    const amenities = listing?.amenities?.length
      ? opts.maxAmenities === undefined
        ? listing.amenities
        : listing.amenities.slice(0, opts.maxAmenities)
      : undefined;
    const fetched = [listing?.fetched_at, ...own.map((p) => p.fetched_at)].filter(Boolean).sort();
    return {
      source,
      // Without a listing (prices from a direct lookup), the hotel's own id at that source.
      source_id:
        listing?.source_id ??
        [hotel.hotel_id, ...hotel.also_ids]
          .find((id) => id.startsWith(`${source}:`))
          ?.slice(source.length + 1) ??
        "",
      name: listing?.name ?? hotel.name,
      rating_10: listing?.rating_10 ?? null,
      review_count: listing?.review_count ?? null,
      stars: listing?.stars ?? null,
      ...(listing?.property_type ? { property_type: listing.property_type } : {}),
      ...(listing?.area ? { area: listing.area } : {}),
      ...(amenities ? { amenities } : {}),
      ...(listing?.check_in_time ? { check_in_time: listing.check_in_time } : {}),
      ...(listing?.check_out_time ? { check_out_time: listing.check_out_time } : {}),
      ...(listing?.typical_price ? { typical_price: listing.typical_price } : {}),
      url: listing?.url ?? null,
      ...(opts.details && listing?.details && Object.keys(listing.details).length
        ? { details: listing.details }
        : {}),
      cheapest_inr: own.find((p) => p.per_night_inr !== null && p.available !== false)?.per_night_inr ?? null,
      offers: offers.map(offerOut),
      offers_total: own.length,
      fetched_at: fetched[fetched.length - 1] ?? "",
    };
  });
  return sections.sort(
    (a, b) => (a.cheapest_inr ?? Number.POSITIVE_INFINITY) - (b.cheapest_inr ?? Number.POSITIVE_INFINITY),
  );
}
