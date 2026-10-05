import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Gazetteer } from "../core/anchors.js";
import { AppError } from "../core/errors.js";
import type { HotelMemory } from "../core/hotel-memory.js";
import type { HotelSearchDeps } from "../core/hotel-search.js";
import { planStay, type StayRequest } from "../core/itinerary.js";
import {
  RETIRING_ROOM_INDICATIVE_PRICES,
  RETIRING_ROOM_PORTAL,
  RETIRING_ROOM_RULES,
  type RetiringRooms,
} from "../core/retiring.js";
import { istDate, parseIstDateTime } from "../core/time.js";
import type { TravelDeps } from "../core/travel.js";
import { handle, readOnly } from "./common.js";
import { PointInput, pointFields } from "./points.js";

const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "use ISO-8601, e.g. 2026-11-10T20:10+05:30")
  .describe("ISO-8601 datetime; without an offset it is taken as IST.");

const RetiringOut = z.object({
  station_code: z.string(),
  station_name: z.string(),
  managed_by: z.string(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  distance_km: z.number().nullable(),
});

const PointOut = z.object({
  label: z.string(),
  name: z.string(),
  code: z.string().nullable(),
  kind: z.string(),
  at: z.string(),
});

export interface StayToolDeps {
  gazetteer: Gazetteer;
  hotels: HotelSearchDeps;
  travel: TravelDeps;
  retiring: RetiringRooms;
  memory: HotelMemory;
  trainBufferMin: number;
  flightBufferMin: number;
  now: () => Date;
}

export function registerStayTools(server: McpServer, deps: StayToolDeps): void {
  server.registerTool(
    "plan_stays",
    {
      title: "Plan hotel stays for an itinerary",
      description:
        "Plans where to stay for each stop of a trip in India. Each stay is an arrival (place + time) and the " +
        "next departure (place + time); places are lat+lng, station code, IATA code or place name, so train " +
        "and flight times from any source can be passed in. For every stay it works out check-in/check-out " +
        "dates (early-morning arrivals book the previous night), searches hotels near the arrival point and, " +
        "if elsewhere, the departure point, and ranks them by nightly price plus drive time from arrival and to " +
        "departure (valued at value_of_time_inr_per_hour). Returns candidates with leave-by times that include " +
        "a check-in buffer for trains or flights, IRCTC retiring-room options for 3–48 h stays at stations, and " +
        "warnings for late arrivals, early departures and same-day stays. Does not book.",
      inputSchema: {
        stays: z
          .array(
            z.object({
              arrive: PointInput.describe("Where the traveller arrives."),
              arrive_at: isoDateTime,
              depart: PointInput.describe("Where the traveller leaves from next."),
              depart_at: isoDateTime,
            }),
          )
          .min(1)
          .max(6)
          .describe("One entry per stop, in trip order."),
        adults: z
          .number()
          .int()
          .min(1)
          .max(8)
          .default(2)
          .describe("Guests in the room; searches are for one room."),
        radius_km: z.number().min(0.5).max(15).default(3).describe("Hotel search radius around each point."),
        max_price_inr: z.number().positive().optional().describe("Maximum nightly price in INR."),
        min_stars: z.number().int().min(1).max(5).optional(),
        candidates: z.number().int().min(1).max(8).default(4).describe("Hotels to return per stay."),
        value_of_time_inr_per_hour: z
          .number()
          .min(0)
          .max(5000)
          .default(300)
          .describe(
            "How much an hour of transfer time is worth, to trade travel time against price (0 = price only).",
          ),
      },
      outputSchema: {
        stays: z.array(
          z.object({
            stay: z.number(),
            arrive: PointOut,
            depart: PointOut,
            check_in: z.string(),
            check_out: z.string(),
            nights: z.number(),
            stay_hours: z.number(),
            searched_around: z.array(z.string()),
            candidates: z.array(
              z.object({
                hotel_id: z.string(),
                name: z.string(),
                lat: z.number(),
                lng: z.number(),
                stars: z.number().nullable(),
                rating_10: z.number().nullable(),
                per_night_inr: z.number().nullable(),
                seller: z.string().nullable(),
                minutes_from_arrival: z.number().nullable(),
                minutes_to_departure: z.number().nullable(),
                leave_by: z.string().nullable(),
                score_inr: z.number().nullable(),
              }),
            ),
            retiring_rooms: z.array(RetiringOut),
            warnings: z.array(z.string()),
            sources_failed: z.array(z.object({ source: z.string(), code: z.string(), message: z.string() })),
          }),
        ),
        notes: z.array(z.string()),
      },
      annotations: readOnly("Plan hotel stays for an itinerary"),
    },
    handle(async (a) => {
      const today = istDate(deps.now());
      const requests: StayRequest[] = [];
      for (const [i, s] of a.stays.entries()) {
        const arrive_at = parseIstDateTime(s.arrive_at);
        const depart_at = parseIstDateTime(s.depart_at);
        if (depart_at <= arrive_at) {
          throw new AppError("INVALID_INPUT", `Stay ${i + 1}: depart_at must be after arrive_at.`);
        }
        if (istDate(depart_at) < today) throw new AppError("INVALID_INPUT", `Stay ${i + 1} is in the past.`);
        if (depart_at.getTime() - arrive_at.getTime() > 14 * 86_400_000) {
          throw new AppError(
            "INVALID_INPUT",
            `Stay ${i + 1} is longer than 14 days; split it or use search_hotels.`,
          );
        }
        const [arrive, depart] = await Promise.all([
          deps.gazetteer.resolvePoint(s.arrive),
          deps.gazetteer.resolvePoint(s.depart),
        ]);
        requests.push({ arrive, arrive_at, depart, depart_at });
      }

      const opts = {
        adults: a.adults,
        radius_km: a.radius_km,
        max_price_inr: a.max_price_inr,
        min_stars: a.min_stars,
        candidates: a.candidates,
        value_of_time_inr_per_hour: a.value_of_time_inr_per_hour,
        train_buffer_min: deps.trainBufferMin,
        flight_buffer_min: deps.flightBufferMin,
      };
      const planDeps = {
        hotels: deps.hotels,
        travel: deps.travel,
        retiring: deps.retiring,
        memory: deps.memory,
      };
      const stays = [];
      // Sequential, to stay polite to the hotel sources and the public router.
      for (const [i, r] of requests.entries()) stays.push(await planStay(planDeps, r, opts, i + 1));
      return {
        stays,
        notes: [
          `Leave-by times allow ${deps.trainBufferMin} min before trains and ${deps.flightBufferMin} min before flights, plus traffic-adjusted drive time.`,
          "Prices are the cheapest live meta-search price per night and may exclude GST. Drive times use OpenStreetMap routing without live traffic.",
          "Map and station data © OpenStreetMap contributors (ODbL).",
        ],
      };
    }),
  );

  server.registerTool(
    "find_retiring_rooms",
    {
      title: "Find IRCTC railway retiring rooms",
      description:
        "Lists Indian Railways stations that have IRCTC retiring rooms (rooms and dormitories inside the " +
        "station for ticketed passengers), at a station code or within a radius of a place. Returns station " +
        "code, name, operator and distance, the booking rules, indicative price ranges and the IRCTC booking " +
        "portal link. Live availability and exact prices are not available here: they need a Confirmed or RAC " +
        "PNR on the IRCTC portal.",
      inputSchema: {
        ...pointFields,
        radius_km: z
          .number()
          .min(1)
          .max(100)
          .default(25)
          .describe("Search radius when not giving a station_code."),
      },
      outputSchema: {
        stations: z.array(RetiringOut),
        booking_url: z.string(),
        rules: z.array(z.string()),
        indicative_prices: z.string(),
        notes: z.array(z.string()),
      },
      annotations: readOnly("Find IRCTC railway retiring rooms"),
    },
    handle(async (a) => {
      const notes = [
        `Station list from IRCTC's public retiring-room list (${deps.retiring.size} stations), refreshed manually.`,
      ];
      let stations;
      if (a.station_code !== undefined && [a.lat, a.lng, a.iata, a.place].every((v) => v === undefined)) {
        const hit = deps.retiring.atStation(a.station_code);
        stations = hit ? [hit] : [];
        if (!hit) {
          const anchor = deps.gazetteer.station(a.station_code);
          if (anchor) {
            stations = deps.retiring.near(anchor, a.radius_km);
            notes.push(
              `${a.station_code} has no listed retiring rooms; showing stations within ${a.radius_km} km.`,
            );
          } else {
            notes.push(`${a.station_code} has no listed retiring rooms and its location is unknown.`);
          }
        }
      } else {
        const anchor = await deps.gazetteer.resolvePoint(a);
        stations = deps.retiring.near(anchor, a.radius_km);
      }
      if (stations.length === 0) notes.push("No stations with retiring rooms found; try a larger radius_km.");
      return {
        stations,
        booking_url: RETIRING_ROOM_PORTAL,
        rules: RETIRING_ROOM_RULES,
        indicative_prices: RETIRING_ROOM_INDICATIVE_PRICES,
        notes,
      };
    }),
  );
}
