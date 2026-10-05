import { z } from "zod";
import { AppError } from "../core/errors.js";

const MAX_GUESTS = 8;

/** Who shares the single room every search is for. */
export const occupancyFields = {
  adults: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(2)
    .describe("Adults (18+) sharing the one room searched for."),
  children_ages: z
    .array(z.number().int().min(0).max(17))
    .max(4)
    .default([])
    .describe(
      "Ages (0–17) of children sharing that room, one entry per child, e.g. [6, 9]; empty for adults only.",
    ),
};

export function validateOccupancy(adults: number, childrenAges: readonly number[]): void {
  if (adults + childrenAges.length > MAX_GUESTS) {
    throw new AppError("INVALID_INPUT", `At most ${MAX_GUESTS} guests fit one room search.`);
  }
}

export function occupancyNote(adults: number, childrenAges: readonly number[]): string {
  const kids = childrenAges.length
    ? ` and ${childrenAges.length} child${childrenAges.length > 1 ? "ren" : ""} (ages ${childrenAges.join(", ")})`
    : "";
  const xotelo = childrenAges.length
    ? ` Xotelo cannot price children, so its prices are for ${adults + childrenAges.length} adults.`
    : "";
  return `Prices are for one room for ${adults} adult${adults > 1 ? "s" : ""}${kids}, as quoted by each source for that occupancy.${xotelo}`;
}
