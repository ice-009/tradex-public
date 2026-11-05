// Planning the "Download F&O history" job (pure): which series still need
// downloading into the market-data database, and roughly what it will cost.

export type PrefetchKind = "daily" | "m15";

export interface PrefetchSpec {
  kind: PrefetchKind;
  interval: "1d" | "15m";
  label: string;
  /** How far back to fetch (days); the broker's own window may clamp it. */
  days: number;
  /** Broker calls one symbol takes (history comes in ≤ 365-day daily / ≤ 91-day intraday chunks). */
  callsPerSymbol: number;
}

export const PREFETCH_SPECS: Record<PrefetchKind, PrefetchSpec> = {
  daily: { kind: "daily", interval: "1d", label: "Daily · 5 years", days: 5 * 365 - 3, callsPerSymbol: 5 },
  m15: { kind: "m15", interval: "15m", label: "15-minute · 1 year", days: 365 - 3, callsPerSymbol: 4 },
};

/** Indices downloaded along with the F&O stocks (charts and the BTST layout use them). */
export const PREFETCH_INDICES = ["NIFTY", "BANKNIFTY", "FINNIFTY"];

/** A gap this small at the start doesn't count as missing (weekends, holidays, window rounding). */
export const COVERAGE_SLACK_MS = 5 * 24 * 60 * 60 * 1000;

/** Does a stored series (complete back to `coveredFrom`) reach back to `target`? */
export function isCovered(coveredFrom: number | null | undefined, target: number): boolean {
  return coveredFrom !== null && coveredFrom !== undefined && coveredFrom <= target + COVERAGE_SLACK_MS;
}

export interface PrefetchJob {
  symbol: string;
  spec: PrefetchSpec;
}

/** Jobs still to run, all daily series first (screener and backtests need them most), then 15-minute. */
export function planPrefetch(symbols: string[], kinds: PrefetchKind[], covered: (symbol: string, spec: PrefetchSpec) => boolean): PrefetchJob[] {
  const order: PrefetchKind[] = ["daily", "m15"];
  return order
    .filter((kind) => kinds.includes(kind))
    .flatMap((kind) => symbols.filter((symbol) => !covered(symbol, PREFETCH_SPECS[kind])).map((symbol) => ({ symbol, spec: PREFETCH_SPECS[kind] })));
}

/** Estimated broker calls for a set of jobs. */
export const estimateCalls = (jobs: PrefetchJob[]) => jobs.reduce((sum, job) => sum + job.spec.callsPerSymbol, 0);
