import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Gazetteer } from "../core/anchors.js";
import { AppError } from "../core/errors.js";
import type { HotelMemory } from "../core/hotel-memory.js";
import { cheapest } from "../core/merge.js";
import { travelMatrix, type LabelledPoint, type TravelDeps } from "../core/travel.js";
import { handle, readOnly } from "./common.js";
import { PointInput } from "./points.js";

const LegOut = z.object({
  from: z.string().describe("Label of the origin."),
  to: z.string().describe("Label of the destination."),
  straight_km: z.number().describe("Straight-line distance, km."),
  road_km: z
    .number()
    .nullable()
    .describe("Road distance along the route, km (null when no route was found)."),
  minutes_raw: z
    .number()
    .nullable()
    .describe("Free-flow travel time from the router, minutes (null when no route)."),
  minutes: z
    .number()
    .nullable()
    .describe(
      "Travel time after the traffic multiplier, minutes; equals minutes_raw for walking (null when no route).",
    ),
  traffic_multiplier: z
    .number()
    .describe("Factor applied to free-flow drive time for traffic, higher in metro areas; 1 for walking."),
  warning: z
    .string()
    .nullable()
    .describe("Set when no route was found or a point is over 500 m from the nearest road."),
});

const modeField = z
  .enum(["drive", "walk"])
  .default("drive")
  .describe("drive (car/taxi, with traffic allowance) or walk.");

const ROUTING_NOTE =
  "Times from OpenStreetMap routing (OSRM). Drive minutes = free-flow minutes × traffic_multiplier; there is no live traffic. Routing data © OpenStreetMap contributors.";

export function registerTravelTools(
  server: McpServer,
  deps: { gazetteer: Gazetteer; travel: TravelDeps; memory: HotelMemory },
): void {
  server.registerTool(
    "travel_times",
    {
      title: "Travel times between places",
      description:
        "Computes road distance and travel time from each origin to each destination in India (a matrix), by " +
        "car or on foot. Each place is lat+lng, a railway station code, an airport IATA code or a place name. " +
        "Returns straight-line km, road km, free-flow minutes and traffic-adjusted minutes per pair, with a " +
        "warning when a point is far from any road. Does not cover public transport or flights.",
      inputSchema: {
        origins: z.array(PointInput).min(1).max(10).describe("Starting places."),
        destinations: z.array(PointInput).min(1).max(25).describe("Destination places."),
        mode: modeField,
      },
      outputSchema: {
        legs: z.array(LegOut).describe("One leg per origin–destination pair, origin by origin."),
        notes: z.array(z.string()).describe("How times are computed, and attribution."),
      },
      annotations: readOnly("Travel times between places"),
    },
    handle(async (a) => {
      const origins = await Promise.all(a.origins.map((p) => deps.gazetteer.resolvePoint(p)));
      const dests = await Promise.all(a.destinations.map((p) => deps.gazetteer.resolvePoint(p)));
      const matrix = await travelMatrix(deps.travel, origins, dests, a.mode);
      return { legs: matrix.flat(), notes: [ROUTING_NOTE] };
    }),
  );

  const HotelRef = z
    .object({
      hotel_id: z.string().optional().describe("hotel_id from search_hotels."),
      name: z.string().max(120).optional().describe("Hotel name, when giving lat/lng instead of hotel_id."),
      lat: z.number().min(6).max(37.5).optional(),
      lng: z.number().min(68).max(97.5).optional(),
    })
    .describe("A hotel: hotel_id from search_hotels, or name + lat + lng.");

  server.registerTool(
    "compare_hotels",
    {
      title: "Compare hotels by travel time",
      description:
        "Compares up to 10 hotels by travel time to a set of labelled places, such as tonight's arrival " +
        "station, tomorrow's departure airport and attractions. Hotels are hotel_ids from search_hotels (which " +
        "also supplies their cheapest price) or name + lat/lng. Places are lat+lng, station code, IATA code or " +
        "place name. Returns, per hotel, the time and distance to every place, total minutes, the " +
        "cheapest price from the search that found it (with its source, fetch time and dates) and a rank by total " +
        "minutes. Does not fetch new prices; get_hotel_details does.",
      inputSchema: {
        hotels: z.array(HotelRef).min(1).max(10).describe("Hotels to compare."),
        places: z
          .array(PointInput)
          .min(1)
          .max(6)
          .describe("Places to measure from each hotel; set label, e.g. 'arrive NDLS 20:10'."),
        mode: modeField,
      },
      outputSchema: {
        hotels: z
          .array(
            z.object({
              rank: z.number().describe("Position by total_minutes, then per_night_inr; 1 is best."),
              hotel_id: z
                .string()
                .nullable()
                .describe("hotel_id as given (null when the hotel was given by lat/lng)."),
              name: z.string().describe("Hotel name (the coordinates when no name was given)."),
              lat: z.number().describe("Hotel latitude."),
              lng: z.number().describe("Hotel longitude."),
              cheapest: z
                .object({
                  per_night_inr: z
                    .number()
                    .nullable()
                    .describe("Per-night price converted to INR (null if no exchange rate)."),
                  seller: z
                    .string()
                    .describe(
                      "Booking site the price is from; the source id when the source names no seller.",
                    ),
                  source: z.string().describe("Id of the data source that returned the price."),
                  fetched_at: z.string().describe("ISO time the source returned this price."),
                  check_in: z.string().describe("Check-in date of that search, YYYY-MM-DD."),
                  check_out: z.string().describe("Check-out date of that search, YYYY-MM-DD."),
                  adults: z.number().describe("Adults in that search."),
                  children_ages: z.array(z.number()).describe("Ages of children in that search."),
                })
                .nullable()
                .describe(
                  "Lowest per-night INR price across sources from that search, for its dates and party.",
                ),
              total_minutes: z
                .number()
                .nullable()
                .describe("Sum of minutes over all legs (null when any leg has no route)."),
              legs: z.array(LegOut).describe("Travel from this hotel to each place, in the order given."),
            }),
          )
          .describe("Hotels sorted by rank."),
        notes: z.array(z.string()).describe("How times are computed, caveats and attribution."),
      },
      annotations: readOnly("Compare hotels by travel time"),
    },
    handle(async (a) => {
      const notes = [ROUTING_NOTE];
      const hotels = a.hotels.map((h) => {
        if (h.hotel_id) {
          const known = deps.memory.get(h.hotel_id);
          if (known) {
            const p = cheapest(known.hotel.prices);
            return {
              id: h.hotel_id,
              name: known.hotel.name,
              lat: known.hotel.lat,
              lng: known.hotel.lng,
              price: p && {
                per_night_inr: p.per_night_inr,
                seller: p.seller ?? p.source,
                source: p.source,
                fetched_at: p.fetched_at,
                check_in: known.check_in,
                check_out: known.check_out,
                adults: known.adults,
                children_ages: known.children_ages,
              },
            };
          }
          if (h.lat === undefined || h.lng === undefined) {
            throw new AppError(
              "NOT_FOUND",
              `hotel_id ${h.hotel_id} is not from a recent search.`,
              "Run search_hotels again, or pass the hotel's name, lat and lng.",
            );
          }
        }
        if (h.lat === undefined || h.lng === undefined) {
          throw new AppError("INVALID_INPUT", "Each hotel needs a hotel_id or lat and lng.");
        }
        return {
          id: h.hotel_id ?? null,
          name: h.name ?? `${h.lat},${h.lng}`,
          lat: h.lat,
          lng: h.lng,
          price: null,
        };
      });
      const places = await Promise.all(a.places.map((p) => deps.gazetteer.resolvePoint(p)));
      const origins: LabelledPoint[] = hotels.map((h) => ({ lat: h.lat, lng: h.lng, label: h.name }));
      const matrix = await travelMatrix(deps.travel, origins, places, a.mode);

      const rows = hotels.map((h, i) => {
        const legs = matrix[i]!;
        const total = legs.every((l) => l.minutes !== null) ? legs.reduce((s, l) => s + l.minutes!, 0) : null;
        return {
          rank: 0,
          hotel_id: h.id,
          name: h.name,
          lat: h.lat,
          lng: h.lng,
          cheapest: h.price,
          total_minutes: total,
          legs,
        };
      });
      rows.sort(
        (x, y) =>
          (x.total_minutes ?? Infinity) - (y.total_minutes ?? Infinity) ||
          (x.cheapest?.per_night_inr ?? Infinity) - (y.cheapest?.per_night_inr ?? Infinity),
      );
      rows.forEach((r, i) => (r.rank = i + 1));
      if (rows.some((r) => r.total_minutes === null))
        notes.push("total_minutes is null where a leg had no route.");
      return { hotels: rows, notes };
    }),
  );
}
