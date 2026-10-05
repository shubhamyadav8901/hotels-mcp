/**
 * Current Indian Railways station codes → the code OpenStreetMap still uses for that station.
 * Lookups try the given code first, then this alias.
 */
export const STATION_CODE_ALIASES: Record<string, string> = {
  BNRS: "BSBS", // Banaras (renamed from Manduadih)
  BCT: "MMCT", // Mumbai Central
};
