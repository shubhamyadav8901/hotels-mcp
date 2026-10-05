import { z } from "zod";
import { AppError } from "../core/errors.js";
import { TtlCache } from "../lib/cache.js";
import { getJson, type HttpOptions } from "../lib/http.js";
import { parseUpstream } from "./shared.js";
import type { ProviderInfo } from "./types.js";

export const FX_INFO: ProviderInfo = {
  id: "frankfurter",
  name: "Frankfurter (ECB reference rates)",
  kind: "fx",
  official: true,
  needsKey: false,
  limitations: ["Daily ECB reference rates, not card or booking-site exchange rates."],
};

const FX_URL = "https://api.frankfurter.dev/v1/latest?base=INR";
const TTL_MS = 12 * 60 * 60 * 1000;

const Payload = z.object({ date: z.string(), rates: z.record(z.string(), z.number()) });

export interface FxRates {
  /** INR per one unit of the currency. */
  toInr: Record<string, number>;
  date: string;
  source: string;
}

export function createFx(http: HttpOptions) {
  const cache = new TtlCache<FxRates>(1);
  return {
    info: FX_INFO,
    async rates(): Promise<FxRates> {
      return cache.getOrSet("rates", TTL_MS, async () => {
        const data = parseUpstream("frankfurter", Payload, await getJson(FX_URL, http));
        const toInr: Record<string, number> = { INR: 1 };
        for (const [cur, perInr] of Object.entries(data.rates)) {
          if (perInr > 0) toInr[cur] = 1 / perInr;
        }
        return { toInr, date: data.date, source: "frankfurter" };
      });
    },
  };
}

export function convertToInr(amount: number, currency: string, fx: FxRates): number {
  const rate = fx.toInr[currency.toUpperCase()];
  if (rate === undefined) throw new AppError("NOT_FOUND", `No exchange rate for ${currency}`);
  return Math.round(amount * rate);
}
