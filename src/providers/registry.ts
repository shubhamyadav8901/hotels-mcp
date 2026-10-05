import { AppError, toAppError } from "../core/errors.js";
import type { ProviderInfo, ProviderStatus } from "./types.js";

interface Entry {
  info: ProviderInfo;
  enabled: boolean;
  disabledReason: string | null;
  lastSuccessAt: string | null;
  lastError: ProviderStatus["last_error"];
  quotaRemaining: () => number | null;
}

/** Tracks which providers are enabled and how their recent calls went. */
export class ProviderRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly disabledIds: readonly string[] = [],
    private readonly now: () => Date = () => new Date(),
    private readonly allowUnofficial = true,
  ) {}

  register(
    info: ProviderInfo,
    opts: { missingKey?: boolean; quotaRemaining?: () => number | null } = {},
  ): void {
    let disabledReason: string | null = null;
    if (this.disabledIds.includes(info.id)) disabledReason = "disabled by PROVIDERS_DISABLED";
    else if (!info.official && !this.allowUnofficial) {
      disabledReason = opts.missingKey
        ? "unofficial source and API key not configured; set ENABLE_UNOFFICIAL_SOURCES=true and the key to use it"
        : "unofficial source; set ENABLE_UNOFFICIAL_SOURCES=true to use it";
    } else if (opts.missingKey) disabledReason = "API key not configured";
    this.entries.set(info.id, {
      info,
      enabled: disabledReason === null,
      disabledReason,
      lastSuccessAt: null,
      lastError: null,
      quotaRemaining: opts.quotaRemaining ?? (() => null),
    });
  }

  isEnabled(id: string): boolean {
    return this.entries.get(id)?.enabled ?? false;
  }

  /**
   * Runs a provider call, recording success or failure. Throws DISABLED if the provider is off, and
   * TIMEOUT if `deadlineMs` passes first (the call's own result is then ignored).
   */
  async run<T>(id: string, call: () => Promise<T>, deadlineMs?: number): Promise<T> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown provider: ${id}`);
    if (!entry.enabled) {
      throw new AppError("DISABLED", `${entry.info.name} is disabled (${entry.disabledReason})`);
    }
    try {
      const result =
        deadlineMs === undefined ? await call() : await withDeadline(call(), deadlineMs, entry.info.name);
      entry.lastSuccessAt = this.now().toISOString();
      return result;
    } catch (err) {
      const appErr = toAppError(err);
      entry.lastError = { at: this.now().toISOString(), code: appErr.code, message: appErr.message };
      throw appErr;
    }
  }

  status(): ProviderStatus[] {
    return [...this.entries.values()].map((e) => ({
      ...e.info,
      enabled: e.enabled,
      disabled_reason: e.disabledReason,
      last_success_at: e.lastSuccessAt,
      last_error: e.lastError,
      quota_remaining: e.quotaRemaining(),
    }));
  }
}

function withDeadline<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AppError("TIMEOUT", `${name} did not answer within ${Math.round(ms / 1000)} s`)),
      ms,
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
