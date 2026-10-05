import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Gazetteer } from "../core/anchors.js";
import { AppError } from "../core/errors.js";
import { handle, readOnly } from "./common.js";
import { AnchorOut } from "./points.js";

// A railway station explicitly (bare "station" counts unless the query is about buses).
const RAIL_WORDS = /\b(railway|rly|junction|jn|train)\b/i;
const STATION_WORD = /\b(station|stn)\b/i;
const BUS_WORDS = /\b(bus|isbt|depot|stand)\b/i;
const asksForRailwayStation = (q: string) =>
  RAIL_WORDS.test(q) || (STATION_WORD.test(q) && !BUS_WORDS.test(q));

const NearOut = AnchorOut.extend({ distance_km: z.number() });

export function registerPlaceTools(server: McpServer, deps: { gazetteer: Gazetteer }): void {
  server.registerTool(
    "resolve_place",
    {
      title: "Resolve a place in India",
      description:
        "Turns a name or code into coordinates, or coordinates into nearby transport points. With `query`: " +
        "matches railway station codes and names, airport IATA codes and names, bus stations, and landmarks or " +
        "localities via OpenStreetMap geocoding, returning ranked matches with kind, code and lat/lng. With " +
        "lat/lng: returns the nearest railway stations (within 10 km), airports with IATA codes (within 60 km) " +
        "and bus stations (within 5 km), with straight-line distances. Does not search hotels.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(120)
          .optional()
          .describe("Name or code, e.g. 'Howrah', 'BLR', 'Hawa Mahal'."),
        kind: z
          .enum(["station", "airport", "bus_station", "landmark", "locality"])
          .optional()
          .describe("Only return this kind of place."),
        lat: z.number().min(6).max(37.5).optional().describe("Latitude, for nearby transport points."),
        lng: z.number().min(68).max(97.5).optional().describe("Longitude, for nearby transport points."),
        limit: z.number().int().min(1).max(10).default(5).describe("Maximum matches for a query."),
      },
      outputSchema: {
        matches: z.array(AnchorOut),
        nearby: z
          .object({ stations: z.array(NearOut), airports: z.array(NearOut), bus_stations: z.array(NearOut) })
          .nullable(),
        notes: z.array(z.string()),
      },
      annotations: readOnly("Resolve a place in India"),
    },
    handle(async (a) => {
      const hasPoint = a.lat !== undefined && a.lng !== undefined;
      if (!a.query && !hasPoint) {
        throw new AppError("INVALID_INPUT", "Give a query, or both lat and lng.");
      }
      const notes = ["Station, bus-station and landmark data © OpenStreetMap contributors (ODbL)."];
      if (hasPoint) {
        return { matches: [], nearby: deps.gazetteer.nearby({ lat: a.lat!, lng: a.lng! }), notes };
      }
      const { anchors, geocoder_errors } = await deps.gazetteer.search(a.query!, {
        kind: a.kind,
        limit: a.limit,
      });
      for (const e of geocoder_errors) notes.push(`Geocoder unavailable: ${e}`);
      if (anchors.length === 0) notes.push("No matches; try a more specific name or add the city.");
      // Asked for a station that doesn't exist (e.g. "Munnar railway station"): say so and name real ones.
      if (
        (!a.kind || a.kind === "station") &&
        asksForRailwayStation(a.query!) &&
        !anchors.some((x) => x.kind === "station") &&
        anchors[0]
      ) {
        const near = deps.gazetteer.nearestStations(anchors[0]);
        notes.push(
          near.length
            ? `No railway station matches "${a.query}". Nearest stations to ${anchors[0].name}: ${near.map((s) => `${s.name} (${s.code}, ${s.distance_km} km straight-line)`).join("; ")}.`
            : `No railway station matches "${a.query}", and none lies within 150 km of ${anchors[0].name}.`,
        );
      }
      return { matches: anchors, nearby: null, notes };
    }),
  );
}
