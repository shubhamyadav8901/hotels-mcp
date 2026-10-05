import { z } from "zod";

/**
 * `min_rating_pct` with the server's default (DEFAULT_MIN_RATING_PCT). The default shows in the tool schema, so
 * the agent can see it and override it per request; 0 turns the filter off.
 */
export function minRatingField(defaultPct: number) {
  return z
    .number()
    .min(0)
    .max(100)
    .default(defaultPct)
    .describe(
      `Minimum guest rating in percent, e.g. 60 = 6.0/10 = 3.0/5. Default ${defaultPct} (server setting); ` +
        "0 turns the filter off. While on, hotels with no guest rating are left out.",
    );
}

/** Percent guest rating to the 0–10 scale used internally; 0 means no filter. */
export const pctTo10 = (pct: number | undefined) => (pct === undefined || pct <= 0 ? undefined : pct / 10);
