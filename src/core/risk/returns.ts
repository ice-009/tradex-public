import type { DailyBar } from "@/core/types";

// Daily log returns of several stocks lined up on one calendar (NIFTY's
// sessions), for the risk model (./model.ts). Pure.
//
// The bars are the hub's split/bonus-adjusted closes. Returns don't depend on
// how far a series was adjusted (a constant factor cancels), so today-adjusted
// bars give the same returns as bars adjusted only up to a Time Machine day;
// what matters is that no bar after the day is used (`through`).

/** Sessions of returns the model looks back over (≈ 6 months): see model.ts for why. */
export const RISK_LOOKBACK = 120;
/** A daily log return beyond ±this is clipped (a bad print or an unadjusted corporate action shouldn't own the covariance). */
export const MAX_ABS_RETURN = 0.2;

export interface ReturnSeries {
  /** Day keys of the sessions, oldest first: return i is close(i) ÷ close(session before i). */
  sessions: number[];
  /** The calendar's own returns (NIFTY), null where it has no bar. */
  benchmark: Array<number | null>;
  /** Per stock, null where it or the session before has no bar. */
  returns: Record<string, Array<number | null>>;
}

const clip = (value: number) => Math.max(-MAX_ABS_RETURN, Math.min(MAX_ABS_RETURN, value));

function returnsOn(sessions: readonly number[], previous: number, closes: ReadonlyMap<number, number>): Array<number | null> {
  const out: Array<number | null> = [];
  let before = closes.get(previous);
  for (let i = 0; i < sessions.length; i += 1) {
    const close = closes.get(sessions[i]);
    out.push(close && before && close > 0 && before > 0 ? clip(Math.log(close / before)) : null);
    before = close;
  }
  return out;
}

/**
 * The last `lookback` sessions' returns up to `through` (a day key; every bar
 * after it is ignored), on the benchmark's sessions — or, without benchmark
 * bars, on every session any of the stocks traded.
 */
export function alignedReturns(
  bySymbol: ReadonlyMap<string, readonly DailyBar[]> | Record<string, readonly DailyBar[]>,
  benchmark: readonly DailyBar[],
  options: { lookback?: number; through?: number } = {},
): ReturnSeries {
  const lookback = Math.max(1, Math.round(options.lookback ?? RISK_LOOKBACK));
  const through = options.through ?? Number.POSITIVE_INFINITY;
  const entries: Array<[string, readonly DailyBar[]]> = bySymbol instanceof Map ? [...bySymbol.entries()] : Object.entries(bySymbol);
  const days = benchmark.length ? benchmark.map((bar) => bar.t) : [...new Set(entries.flatMap(([, bars]) => bars.map((bar) => bar.t)))];
  const calendar = [...new Set(days.filter((t) => t <= through))].sort((a, b) => a - b).slice(-(lookback + 1));
  if (calendar.length < 2) return { sessions: [], benchmark: [], returns: Object.fromEntries(entries.map(([symbol]) => [symbol, []])) };
  const [previous, ...sessions] = calendar;
  const closesOf = (bars: readonly DailyBar[]) => new Map(bars.filter((bar) => bar.t <= through).map((bar) => [bar.t, bar.c] as const));
  return {
    sessions,
    benchmark: returnsOn(sessions, previous, closesOf(benchmark)),
    returns: Object.fromEntries(entries.map(([symbol, bars]) => [symbol, returnsOn(sessions, previous, closesOf(bars))])),
  };
}
