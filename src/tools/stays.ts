import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchPlaceName, type Gazetteer } from "../core/anchors.js";
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
import { minRatingField, pctTo10 } from "./filters.js";
import { occupancyFields, occupancyNote, validateOccupancy } from "./occupancy.js";
import { PointInput, pointFields } from "./points.js";

const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "use ISO-8601, e.g. 2026-11-10T20:10+05:30")
  .describe("ISO-8601 datetime; without an offset it is taken as IST.");

const RetiringOut = z.object({
  station_code: z.string().describe("Station code."),
  station_name: z.string().describe("Station name."),
  managed_by: z.string().describe("Who runs the retiring rooms, as IRCTC lists it."),
  lat: z.number().nullable().describe("Station latitude (null if unknown)."),
  lng: z.number().nullable().describe("Station longitude (null if unknown)."),
  distance_km: z
    .number()
    .nullable()
    .describe("Straight-line distance from the search place, km; 0 for the station itself."),
});

const PointOut = z.object({
  label: z.string().describe("Label of the point: as given, else its code or name."),
  name: z.string().describe("Resolved place name."),
  code: z
    .string()
    .nullable()
    .describe("Railway station code or airport IATA code (null when the place has none)."),
  kind: z
    .string()
    .describe("Kind of place: station, airport, bus_station, landmark, locality or point (raw coordinates)."),
  at: z.string().describe("Arrival or departure time in IST, ISO-8601 with +05:30."),
});

export interface StayToolDeps {
  defaultMinRatingPct: number;
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
        ...occupancyFields,
        radius_km: z.number().min(0.5).max(15).default(3).describe("Hotel search radius around each point."),
        max_price_inr: z.number().positive().optional().describe("Maximum nightly price in INR."),
        min_stars: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Minimum hotel class (official stars)."),
        min_rating_pct: minRatingField(deps.defaultMinRatingPct),
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
        stays: z
          .array(
            z.object({
              stay: z.number().describe("Stay number, from 1, in trip order."),
              arrive: PointOut.describe("Where and when the traveller arrives."),
              depart: PointOut.describe("Where and when the traveller leaves."),
              check_in: z
                .string()
                .describe("Hotel check-in date, YYYY-MM-DD; the previous day for arrivals before 06:00 IST."),
              check_out: z.string().describe("Hotel check-out date, YYYY-MM-DD."),
              nights: z.number().describe("Nights between check_in and check_out."),
              stay_hours: z.number().describe("Hours from arrival to departure, 1 decimal."),
              searched_around: z
                .array(z.string())
                .describe(
                  "Labels of the points hotels were searched around: the arrival, and the departure when elsewhere.",
                ),
              candidates: z
                .array(
                  z.object({
                    hotel_id: z
                      .string()
                      .describe("Hotel id as source:source_id of the first source that listed it."),
                    name: z.string().describe("Hotel name."),
                    lat: z.number().describe("Hotel latitude."),
                    lng: z.number().describe("Hotel longitude."),
                    stars: z
                      .number()
                      .nullable()
                      .describe("Official hotel class, 1–5 stars (null if unknown)."),
                    rating_10: z
                      .number()
                      .nullable()
                      .describe("Guest review score on a 0–10 scale (null if unrated)."),
                    per_night_inr: z
                      .number()
                      .nullable()
                      .describe("Lowest per-night INR price across sources."),
                    seller: z
                      .string()
                      .nullable()
                      .describe(
                        "Booking site of per_night_inr; the source id when the source names no seller.",
                      ),
                    minutes_from_arrival: z
                      .number()
                      .nullable()
                      .describe(
                        "Traffic-adjusted drive from the arrival point, minutes (null when not routed).",
                      ),
                    minutes_to_departure: z
                      .number()
                      .nullable()
                      .describe(
                        "Traffic-adjusted drive to the departure point, minutes (null when not routed).",
                      ),
                    leave_by: z
                      .string()
                      .nullable()
                      .describe(
                        "Latest time to leave the hotel, IST ISO-8601: departure minus drive time and the train or flight buffer.",
                      ),
                    score_inr: z
                      .number()
                      .nullable()
                      .describe(
                        "per_night_inr × nights plus both drives valued at value_of_time_inr_per_hour, INR; lower is better.",
                      ),
                  }),
                )
                .describe("Hotels for this stay, lowest score_inr first, then cheapest."),
              retiring_rooms: z
                .array(RetiringOut)
                .describe(
                  "Arrival or departure stations with IRCTC retiring rooms, listed only for 3–48 h stays.",
                ),
              warnings: z
                .array(z.string())
                .describe("Late arrivals, early departures, short or same-day stays and empty results."),
              sources_failed: z
                .array(
                  z.object({
                    source: z.string().describe("Id of the source that failed."),
                    code: z.string().describe("Error code, e.g. UPSTREAM_UNAVAILABLE or RATE_LIMITED."),
                    message: z.string().describe("What went wrong."),
                  }),
                )
                .describe("Sources that did not answer for this stay, and why."),
            }),
          )
          .describe("One plan per requested stay, in trip order."),
        notes: z.array(z.string()).describe("Buffers used, price and routing caveats, and attribution."),
      },
      annotations: readOnly("Plan hotel stays for an itinerary"),
    },
    handle(async (a) => {
      validateOccupancy(a.adults, a.children_ages);
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
        requests.push({
          arrive: { ...arrive, search_name: searchPlaceName(arrive, deps.gazetteer) },
          arrive_at,
          depart: { ...depart, search_name: searchPlaceName(depart, deps.gazetteer) },
          depart_at,
        });
      }

      const opts = {
        adults: a.adults,
        children_ages: a.children_ages,
        radius_km: a.radius_km,
        max_price_inr: a.max_price_inr,
        min_stars: a.min_stars,
        min_rating_10: pctTo10(a.min_rating_pct),
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
          occupancyNote(a.adults, a.children_ages),
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
        stations: z.array(RetiringOut).describe("Stations with IRCTC retiring rooms, nearest first."),
        booking_url: z.string().describe("IRCTC retiring-room booking portal."),
        rules: z.array(z.string()).describe("IRCTC booking rules for retiring rooms."),
        indicative_prices: z.string().describe("Typical price ranges from secondary sources; not live."),
        notes: z.array(z.string()).describe("Data source and search caveats."),
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
