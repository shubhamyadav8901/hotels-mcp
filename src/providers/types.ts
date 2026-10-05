import type { HotelCandidate, HotelSearchQuery } from "../core/types.js";

/** Where a value came from and when. Attached to every price, distance and time we return. */
export interface Provenance {
  source: string;
  fetched_at: string;
}

export type ProviderKind = "hotel-prices" | "hotel-locations" | "geocoding" | "routing" | "fx" | "dataset";

export interface ProviderInfo {
  id: string;
  name: string;
  kind: ProviderKind;
  /** Official API, or unofficial/third-party endpoint with no SLA. */
  official: boolean;
  needsKey: boolean;
  limitations: string[];
}

export interface ProviderStatus extends ProviderInfo {
  enabled: boolean;
  disabled_reason: string | null;
  last_success_at: string | null;
  last_error: { at: string; code: string; message: string } | null;
  quota_remaining: number | null;
}

export interface SnapshotInfo {
  id: string;
  description: string;
  rows: number;
  built_at: string | null;
  source: string;
  licence: string;
}

/** A source of hotels (and usually live prices) around a point. */
export interface HotelSearchProvider {
  info: ProviderInfo;
  search(query: HotelSearchQuery): Promise<HotelCandidate[]>;
}
