import type { Anchor } from "./anchors.js";
import { toAppError } from "./errors.js";
import type { HotelMemory } from "./hotel-memory.js";
import { haversineKm, roundTo } from "./geo.js";
import { searchHotels, type HotelSearchDeps, type RankedHotel, type SourceFailure } from "./hotel-search.js";
import {
  RETIRING_MAX_HOURS,
  RETIRING_MIN_HOURS,
  type RetiringRooms,
  type RetiringRoomStation,
} from "./retiring.js";
import { effectivePrice, type OccupancyLevel } from "./occupancy.js";
import { addDays, istClock, istDate, istIso } from "./time.js";
import { travelMatrix, type TravelDeps } from "./travel.js";

export interface StayRequest {
  arrive: Anchor & { label: string; search_name?: { name: string; area: boolean } | undefined };
  arrive_at: Date;
  depart: Anchor & { label: string; search_name?: { name: string; area: boolean } | undefined };
  depart_at: Date;
}

export interface PlanOptions {
  adults: number;
  children_ages: number[];
  radius_km: number;
  max_price_inr?: number | undefined;
  min_stars?: number | undefined;
  min_rating_10?: number | undefined;
  candidates: number;
  /** How many rupees an hour of transfer time is worth when trading time against price. */
  value_of_time_inr_per_hour: number;
  train_buffer_min: number;
  flight_buffer_min: number;
}

export interface StayCandidate {
  hotel_id: string;
  name: string;
  lat: number;
  lng: number;
  stars: number | null;
  rating_10: number | null;
  per_night_inr: number | null;
  seller: string | null;
  /** How far per_night_inr is known to be one room for the party (see search_hotels). */
  occupancy: OccupancyLevel | null;
  /** A cheaper price that is unverified as one room (possibly two rooms), when there is one. */
  cheaper_unverified_per_night_inr: number | null;
  minutes_from_arrival: number | null;
  minutes_to_departure: number | null;
  /** Latest time to leave the hotel to make the departure with the buffer. */
  leave_by: string | null;
  /** Price for the stay + transfer time valued at value_of_time_inr_per_hour; lower is better. */
  score_inr: number | null;
}

export interface StayPlan {
  stay: number;
  arrive: { label: string; name: string; code: string | null; kind: string; at: string };
  depart: { label: string; name: string; code: string | null; kind: string; at: string };
  check_in: string;
  check_out: string;
  nights: number;
  stay_hours: number;
  searched_around: string[];
  candidates: StayCandidate[];
  retiring_rooms: RetiringRoomStation[];
  warnings: string[];
  sources_failed: SourceFailure[];
}

export interface PlanDeps {
  hotels: HotelSearchDeps;
  travel: TravelDeps;
  retiring: RetiringRooms;
  memory: HotelMemory;
}

const SAME_AREA_KM = 3;
/** Stays shorter than this get a warning that a full hotel night may not be the best option. */
const SHORT_STAY_HOURS = 6;

/** Works out dates, searches hotels near the arrival and departure points, and ranks them by price + transfer time. */
export async function planStay(
  deps: PlanDeps,
  req: StayRequest,
  opts: PlanOptions,
  index: number,
): Promise<StayPlan> {
  const warnings: string[] = [];
  const stayHours = roundTo((req.depart_at.getTime() - req.arrive_at.getTime()) / 3_600_000, 1);
  if (stayHours <= 0) throw new Error(`Stay ${index}: departure must be after arrival.`);

  const arriveClock = istClock(req.arrive_at);
  const departClock = istClock(req.depart_at);
  // Arriving before 06:00 needs the room from the previous night to check in on arrival.
  let checkIn = istDate(req.arrive_at);
  if (arriveClock.hour < 6) {
    checkIn = addDays(checkIn, -1);
    warnings.push(
      `Arrival at ${arriveClock.text} is before normal check-in: dates start the previous night (${checkIn}) so the room is ready on arrival. Ask the hotel about early check-in instead if cheaper.`,
    );
  }
  let checkOut = istDate(req.depart_at);
  if (checkOut <= checkIn) {
    checkOut = addDays(checkIn, 1);
    warnings.push(
      `Same-day stay of ${stayHours} h: hotels sell full nights, so prices are for one night. A retiring room or day-use room may suit better.`,
    );
  }
  if (stayHours < SHORT_STAY_HOURS) {
    const options = [
      req.arrive.kind === "station" || req.depart.kind === "station" ? "a station retiring room" : null,
      req.arrive.kind === "airport" || req.depart.kind === "airport" ? "an airport hotel or lounge" : null,
      "a day-use room",
    ].filter(Boolean);
    warnings.push(
      `Short ${stayHours} h stay: hotel prices are for a full night and transfers take a large share of the time; consider ${options.join(" or ")}.`,
    );
  }
  if (departClock.hour >= 13 && istDate(req.depart_at) === checkOut) {
    warnings.push(
      `Departure at ${departClock.text} is after typical 11:00–12:00 check-out; ask for late check-out or luggage storage.`,
    );
  }
  if (arriveClock.hour >= 22 || arriveClock.hour < 6) {
    warnings.push(
      `Late arrival (${arriveClock.text}): prefer hotels with 24-hour reception and confirm the booking won't be released.`,
    );
  }
  const nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000);

  // Search around the arrival point, and also the departure point when it is elsewhere.
  const centres = [req.arrive];
  if (haversineKm(req.arrive, req.depart) > SAME_AREA_KM) centres.push(req.depart);
  const sources_failed: SourceFailure[] = [];
  const found = new Map<string, RankedHotel>();
  // Both searches run in parallel; each already queries its sources in parallel.
  const results = await Promise.all(
    centres.map((c) =>
      searchHotels(
        deps.hotels,
        {
          lat: c.lat,
          lng: c.lng,
          radius_km: opts.radius_km,
          check_in: checkIn,
          check_out: checkOut,
          adults: opts.adults,
          children_ages: opts.children_ages,
          place: c.search_name?.name,
          place_is_area: c.search_name?.area,
          prefer: {
            sort: "price",
            min_stars: opts.min_stars,
            max_price_inr: opts.max_price_inr,
            min_rating_10: opts.min_rating_10,
          },
        },
        {
          sort: "price",
          max_price_inr: opts.max_price_inr,
          min_stars: opts.min_stars,
          min_rating_10: opts.min_rating_10,
        },
      ),
    ),
  );
  const seenIds = new Set<string>();
  const unrated = Math.max(0, ...results.map((r) => r.unrated_hidden));
  if (unrated > 0)
    warnings.push(`${unrated} hotels were left out by min_rating_pct because no source rates them.`);
  for (const r of results) {
    for (const f of r.sources_failed) {
      if (!sources_failed.some((x) => x.source === f.source)) sources_failed.push(f);
    }
    for (const h of r.hotels) {
      const ids = [h.hotel_id, ...h.also_ids];
      if (!h.cheapest || ids.some((id) => seenIds.has(id))) continue;
      ids.forEach((id) => seenIds.add(id));
      found.set(h.hotel_id, h);
    }
  }
  deps.memory.remember([...found.values()], {
    check_in: checkIn,
    check_out: checkOut,
    adults: opts.adults,
    children_ages: opts.children_ages,
  });
  // Route a shortlist rather than every hotel: the cheapest, plus the nearest to the arrival and to the
  // departure point, so a slightly dearer hotel next to the station still gets scored on time + price.
  const all = [...found.values()];
  const priceOf = (h: RankedHotel) => effectivePrice(h)!.per_night_inr!;
  const byPrice = [...all].sort((a, b) => priceOf(a) - priceOf(b));
  const nearest = (p: StayRequest["arrive"]) =>
    [...all].sort((a, b) => haversineKm(p, a) - haversineKm(p, b));
  const pool = [
    ...new Set([
      ...byPrice.slice(0, 13),
      ...nearest(req.arrive).slice(0, 6),
      ...nearest(req.depart).slice(0, 6),
    ]),
  ];

  const departBuffer =
    req.depart.kind === "airport"
      ? opts.flight_buffer_min
      : req.depart.kind === "station"
        ? opts.train_buffer_min
        : 0;
  let candidates: StayCandidate[] = pool.map((h) => toCandidate(h, null, null, null, null));
  if (pool.length > 0) {
    try {
      const points = pool.map((h) => ({ lat: h.lat, lng: h.lng, label: h.hotel_id }));
      const fromArrival = await travelMatrix(deps.travel, [req.arrive], points, "drive");
      const toDeparture = await travelMatrix(deps.travel, points, [req.depart], "drive");
      candidates = pool.map((h, i) => {
        const inMin = fromArrival[0]![i]!.minutes;
        const outMin = toDeparture[i]![0]!.minutes;
        const leaveBy =
          outMin === null
            ? null
            : istIso(new Date(req.depart_at.getTime() - (outMin + departBuffer) * 60_000));
        const score =
          inMin === null || outMin === null
            ? null
            : Math.round(priceOf(h) * nights + ((inMin + outMin) / 60) * opts.value_of_time_inr_per_hour);
        return toCandidate(h, inMin, outMin, leaveBy, score);
      });
    } catch (err) {
      const e = toAppError(err);
      sources_failed.push({
        source: "osrm",
        code: e.code,
        message: `${e.message}; candidates ranked by price only`,
      });
    }
  }
  candidates.sort(
    (a, b) =>
      (a.score_inr ?? Infinity) - (b.score_inr ?? Infinity) ||
      (a.per_night_inr ?? Infinity) - (b.per_night_inr ?? Infinity),
  );
  candidates = candidates.slice(0, opts.candidates);

  const best = candidates[0];
  if (best?.leave_by) {
    const leave = istClock(new Date(best.leave_by));
    if (leave.hour < 6) {
      warnings.push(
        `Early start: to make the ${departClock.text} departure with a ${departBuffer}-minute buffer, leave the top hotel by ${leave.text}; book a cab in advance.`,
      );
    }
  }
  if (found.size === 0)
    warnings.push("No priced hotels found near these points; widen radius_km or relax filters.");

  // Retiring rooms at the arrival or departure station, when the stay length fits their 3–48 h slots.
  const retiring: RetiringRoomStation[] = [];
  if (stayHours >= RETIRING_MIN_HOURS && stayHours <= RETIRING_MAX_HOURS) {
    for (const a of [req.arrive, req.depart]) {
      if (a.kind !== "station" || !a.code) continue;
      const rr = deps.retiring.atStation(a.code);
      if (rr && !retiring.some((x) => x.station_code === rr.station_code)) retiring.push(rr);
    }
    if (retiring.length && stayHours < 8) {
      warnings.push(
        `Station${retiring.length > 1 ? "s" : ""} ${retiring.map((r) => r.station_code).join(", ")} ha${retiring.length > 1 ? "ve" : "s"} retiring rooms, which fit a ${stayHours} h stay (they need a Confirmed/RAC PNR).`,
      );
    }
  }

  const point = (p: StayRequest["arrive"], at: Date) => ({
    label: p.label,
    name: p.name,
    code: p.code,
    kind: p.kind,
    at: istIso(at),
  });
  return {
    stay: index,
    arrive: point(req.arrive, req.arrive_at),
    depart: point(req.depart, req.depart_at),
    check_in: checkIn,
    check_out: checkOut,
    nights,
    stay_hours: stayHours,
    searched_around: centres.map((c) => c.label),
    candidates,
    retiring_rooms: retiring,
    warnings,
    sources_failed,
  };
}

function toCandidate(
  h: RankedHotel,
  inMin: number | null,
  outMin: number | null,
  leaveBy: string | null,
  score: number | null,
): StayCandidate {
  return {
    hotel_id: h.hotel_id,
    name: h.name,
    lat: h.lat,
    lng: h.lng,
    stars: h.stars,
    rating_10: h.rating_10,
    per_night_inr: effectivePrice(h)?.per_night_inr ?? null,
    occupancy: effectivePrice(h)?.occupancy ?? null,
    cheaper_unverified_per_night_inr:
      h.cheapest && h.cheapest !== effectivePrice(h) ? h.cheapest.per_night_inr : null,
    seller: effectivePrice(h) ? (effectivePrice(h)!.seller ?? effectivePrice(h)!.source) : null,
    minutes_from_arrival: inMin,
    minutes_to_departure: outMin,
    leave_by: leaveBy,
    score_inr: score,
  };
}
