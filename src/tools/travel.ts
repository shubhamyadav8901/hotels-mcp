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
  from: z.string(),
  to: z.string(),
  straight_km: z.number(),
  road_km: z.number().nullable(),
  minutes_raw: z.number().nullable(),
  minutes: z.number().nullable(),
  traffic_multiplier: z.number(),
  warning: z.string().nullable(),
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
      outputSchema: { legs: z.array(LegOut), notes: z.array(z.string()) },
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
        "place name. Returns, per hotel, the time and distance to every place, total minutes, the cheapest " +
        "price from the search that found it (with its source, fetch time and dates) and a rank by total " +
        "minutes. Does not fetch new prices; get_hotel_rates does.",
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
        hotels: z.array(
          z.object({
            rank: z.number(),
            hotel_id: z.string().nullable(),
            name: z.string(),
            lat: z.number(),
            lng: z.number(),
            cheapest: z
              .object({
                per_night_inr: z.number().nullable(),
                seller: z.string(),
                source: z.string(),
                fetched_at: z.string(),
                check_in: z.string(),
                check_out: z.string(),
                adults: z.number(),
                children_ages: z.array(z.number()),
              })
              .nullable()
              .describe(
                "Cheapest price from the search that returned this hotel, for that search's dates and party.",
              ),
            total_minutes: z.number().nullable(),
            legs: z.array(LegOut),
          }),
        ),
        notes: z.array(z.string()),
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
