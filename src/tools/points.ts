import { z } from "zod";

/** Input shape for any place: exactly one of lat+lng, station_code, iata or place. */
export const pointFields = {
  lat: z.number().min(6).max(37.5).optional().describe("Latitude (India). Use with lng."),
  lng: z.number().min(68).max(97.5).optional().describe("Longitude (India). Use with lat."),
  station_code: z
    .string()
    .regex(/^[A-Za-z]{1,5}$/)
    .optional()
    .describe("Indian Railways station code, e.g. NDLS."),
  iata: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional()
    .describe("Indian airport IATA code, e.g. DEL."),
  place: z
    .string()
    .min(2)
    .max(120)
    .optional()
    .describe("Place name, e.g. 'Taj Mahal' or 'Paharganj, Delhi'; resolved to its best match."),
};

export const PointInput = z
  .object({ ...pointFields, label: z.string().max(60).optional().describe("Name to show for this point.") })
  .describe("A place: exactly one of lat+lng, station_code, iata or place.");

export const AnchorOut = z.object({
  kind: z
    .string()
    .describe("Kind of place: station, airport, bus_station, landmark, locality or point (raw coordinates)."),
  name: z.string().describe("Place name."),
  code: z
    .string()
    .nullable()
    .describe("Railway station code or airport IATA code (null when the place has none)."),
  context: z
    .string()
    .nullable()
    .describe(
      "Extra detail, e.g. the airport's city, the bus operator, a halt marker or the geocoder's locality.",
    ),
  lat: z.number().describe("Latitude."),
  lng: z.number().describe("Longitude."),
  source: z
    .string()
    .describe(
      "Dataset or geocoder the place came from, e.g. openstreetmap, ourairports, or input for given coordinates.",
    ),
});
