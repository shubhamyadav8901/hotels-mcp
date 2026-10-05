import { GridIndex } from "../core/grid.js";
import type { HotelCandidate, HotelSearchQuery } from "../core/types.js";
import type { LodgingRow } from "../data/datasets.js";
import type { HotelSearchProvider, ProviderInfo } from "./types.js";

export const OSM_LODGING_INFO: ProviderInfo = {
  id: "osm_lodging",
  name: "OpenStreetMap lodging (bundled snapshot)",
  kind: "hotel-locations",
  official: true,
  needsKey: false,
  limitations: [
    "Locations only: no prices, availability or ratings.",
    "Good coverage in metros and tourist towns, thin in smaller towns.",
  ],
};

/** Hotels, guest houses, hostels and motels from the bundled OSM snapshot; never carries prices. */
export function createOsmLodging(rows: LodgingRow[], builtAt: string | null): HotelSearchProvider {
  const index = new GridIndex(rows);
  const fetchedAt = builtAt ?? "unknown";
  const provider: HotelSearchProvider = {
    info: OSM_LODGING_INFO,
    async search(q: HotelSearchQuery): Promise<HotelCandidate[]> {
      return index.within(q, q.radius_km).map(({ item }) => ({
        source: "osm_lodging",
        source_id: item.osm_id,
        name: item.name,
        lat: item.lat,
        lng: item.lng,
        stars: item.stars,
        rating_10: null,
        review_count: null,
        url: `https://www.openstreetmap.org/${{ n: "node", w: "way", r: "relation" }[item.osm_id[0] as "n" | "w" | "r"]}/${item.osm_id.slice(1)}`,
        prices: [],
        fetched_at: fetchedAt,
      }));
    },
    async searchWithCoverage(q) {
      return {
        hotels: await provider.search(q),
        coverage_note: "every mapped listing in the radius; locations only, no prices",
      };
    },
  };
  return provider;
}
