import { haversineKm } from "./geo.js";
import type { LatLng } from "./types.js";

/** Approximate centres of India's most congested metros; points within METRO_RADIUS_KM count as metro. */
const METROS: { name: string; lat: number; lng: number }[] = [
  { name: "Delhi NCR", lat: 28.6139, lng: 77.209 },
  { name: "Mumbai", lat: 19.076, lng: 72.8777 },
  { name: "Bengaluru", lat: 12.9716, lng: 77.5946 },
  { name: "Kolkata", lat: 22.5726, lng: 88.3639 },
  { name: "Chennai", lat: 13.0827, lng: 80.2707 },
  { name: "Hyderabad", lat: 17.385, lng: 78.4867 },
  { name: "Pune", lat: 18.5204, lng: 73.8567 },
  { name: "Ahmedabad", lat: 23.0225, lng: 72.5714 },
];
const METRO_RADIUS_KM = 35;

export function metroOf(p: LatLng): string | null {
  return METROS.find((m) => haversineKm(p, m) <= METRO_RADIUS_KM)?.name ?? null;
}

/** Multiplier for free-flow drive minutes: the metro factor if either end is in a metro. */
export function trafficMultiplier(a: LatLng, b: LatLng, metro: number, other: number): number {
  return metroOf(a) || metroOf(b) ? metro : other;
}
