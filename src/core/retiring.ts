import { STATION_CODE_ALIASES } from "../data/aliases.js";
import type { RetiringRoomRow } from "../data/datasets.js";
import { roundTo } from "./geo.js";
import { GridIndex } from "./grid.js";
import type { LatLng } from "./types.js";

export const RETIRING_ROOM_PORTAL = "https://www.rr.irctc.co.in/";

/** Booking rules from the IRCTC retiring-room portal FAQ and terms (checked 2026-10-05). */
export const RETIRING_ROOM_RULES = [
  "Needs a Confirmed or RAC train PNR for a journey to or from the station; waitlisted tickets are refused.",
  "Stay length 3 h minimum, 48 h maximum; hourly slots only at some stations.",
  "Room types: single, double or dormitory, AC or non-AC, depending on the station.",
  "Check-in allowed up to 1 h after the train's actual arrival; cancelling the ticket cancels the room.",
  "Live availability is only shown on the IRCTC portal after entering the PNR.",
];

/** Indicative prices reported by secondary sources; they vary by station and are not live. */
export const RETIRING_ROOM_INDICATIVE_PRICES =
  "Reported by secondary sources, not live, varies by station: dormitory about ₹150–400 and AC double about " +
  "₹1,200–2,500 per 24 h. Example: Sealdah tariff (Aug 2025) dorm ₹572/12 h or ₹908/24 h, suites ₹1,704–3,384 incl. GST.";

export const RETIRING_MIN_HOURS = 3;
export const RETIRING_MAX_HOURS = 48;

export interface RetiringRoomStation {
  station_code: string;
  station_name: string;
  managed_by: string;
  lat: number | null;
  lng: number | null;
  distance_km: number | null;
}

export class RetiringRooms {
  private readonly byCode: Map<string, RetiringRoomRow>;
  private readonly index: GridIndex<RetiringRoomRow & LatLng>;

  constructor(rows: RetiringRoomRow[]) {
    this.byCode = new Map(rows.map((r) => [r.station_code, r]));
    this.index = new GridIndex(
      rows.filter((r): r is RetiringRoomRow & LatLng => r.lat !== null && r.lng !== null),
    );
  }

  get size(): number {
    return this.byCode.size;
  }

  atStation(code: string): RetiringRoomStation | null {
    const c = code.trim().toUpperCase();
    const alias = Object.entries(STATION_CODE_ALIASES).find(([, osm]) => osm === c)?.[0];
    const row =
      this.byCode.get(c) ??
      this.byCode.get(STATION_CODE_ALIASES[c] ?? "") ??
      (alias ? this.byCode.get(alias) : undefined);
    return row ? { ...row, distance_km: 0 } : null;
  }

  near(p: LatLng, radiusKm: number, limit = 5): RetiringRoomStation[] {
    return this.index
      .within(p, radiusKm, limit)
      .map(({ item, km }) => ({ ...item, distance_km: roundTo(km, 2) }));
  }
}
