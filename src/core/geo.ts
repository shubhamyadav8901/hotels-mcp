import type { LatLng } from "./types.js";

const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** The point `km` away from `from` along `bearingDeg` (0 = north), on a spherical Earth. */
export function offset(from: LatLng, km: number, bearingDeg: number): LatLng {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const d = km / EARTH_RADIUS_KM;
  const b = toRad(bearingDeg);
  const lat1 = toRad(from.lat);
  const lng1 = toRad(from.lng);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lng2 =
    lng1 +
    Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: roundTo(toDeg(lat2), 6), lng: roundTo(toDeg(lng2), 6) };
}

/**
 * Points that together cover a circle of `radiusKm` for a source that only searches ~2.5 km around a point:
 * the centre alone up to 3 km; a ring of 6 up to 6 km; two offset rings of 6 beyond (13 points at most).
 */
export function coverPoints(center: LatLng, radiusKm: number): LatLng[] {
  if (radiusKm <= 3) return [center];
  const ring = (km: number, start: number) =>
    [0, 60, 120, 180, 240, 300].map((b) => offset(center, km, b + start));
  if (radiusKm <= 6) return [center, ...ring(radiusKm * 0.55, 0)];
  return [center, ...ring(radiusKm * 0.4, 0), ...ring(radiusKm * 0.8, 30)];
}
