import { haversineKm } from "./geo.js";
import type { LatLng } from "./types.js";

const CELL_DEG = 0.05; // ≈5.5 km at India's latitudes

/** Fixed-grid spatial index for radius queries over a few tens of thousands of points. */
export class GridIndex<T extends LatLng> {
  private readonly cells = new Map<string, T[]>();

  constructor(items: Iterable<T>) {
    for (const item of items) {
      const k = this.key(item.lat, item.lng);
      let bucket = this.cells.get(k);
      if (!bucket) this.cells.set(k, (bucket = []));
      bucket.push(item);
    }
  }

  private key(lat: number, lng: number): string {
    return `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / CELL_DEG)}`;
  }

  /** Items within `radiusKm` of `center`, nearest first, with their distance. */
  within(center: LatLng, radiusKm: number, limit = Infinity): { item: T; km: number }[] {
    const dLat = radiusKm / 111;
    const dLng = radiusKm / (111 * Math.max(0.1, Math.cos((center.lat * Math.PI) / 180)));
    const out: { item: T; km: number }[] = [];
    for (
      let y = Math.floor((center.lat - dLat) / CELL_DEG);
      y <= Math.floor((center.lat + dLat) / CELL_DEG);
      y++
    ) {
      for (
        let x = Math.floor((center.lng - dLng) / CELL_DEG);
        x <= Math.floor((center.lng + dLng) / CELL_DEG);
        x++
      ) {
        for (const item of this.cells.get(`${y}:${x}`) ?? []) {
          const km = haversineKm(center, item);
          if (km <= radiusKm) out.push({ item, km });
        }
      }
    }
    return out.sort((a, b) => a.km - b.km).slice(0, limit);
  }
}
