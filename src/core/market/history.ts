// Incremental candle history (pure): decide what to download given what's
// already stored, and merge the download in. Closed candles never change, so a
// chart only needs its newest stretch fetched — one API call instead of one per
// 90/360-day chunk of the whole range.

import type { DatedCandle } from "./aggregate";

export interface StoredHistory<T extends DatedCandle = DatedCandle> {
  /** Oldest time (ms) this history is complete from. */
  coveredFrom: number;
  candles: T[];
}

export type HistoryPlan = { kind: "full" } | { kind: "tail"; from: number };

/** Re-download everything when the overlap candle moved this much (split/bonus adjusts past prices). */
export const ADJUSTMENT_TOLERANCE = 0.01;

/**
 * What to download for candles from `from` to now. `overlapMs` reaches back over
 * the newest stored candle(s) so a still-forming candle is replaced and a past
 * price adjustment can be detected.
 */
export function planHistoryFetch(stored: StoredHistory | null, from: number, overlapMs: number): HistoryPlan {
  if (!stored || !stored.candles.length || stored.coveredFrom > from) return { kind: "full" };
  const last = Date.parse(stored.candles[stored.candles.length - 1].date);
  return { kind: "tail", from: last - overlapMs };
}

/**
 * Merge a tail download into stored candles. Returns null when an overlapping
 * candle's close changed by more than ADJUSTMENT_TOLERANCE (the history was
 * adjusted, e.g. a split): the caller should re-download in full.
 */
export function mergeTail<T extends DatedCandle>(stored: T[], tail: T[], keepFrom: number): T[] | null {
  if (!tail.length) return stored.filter((candle) => Date.parse(candle.date) >= keepFrom);
  const firstTail = Date.parse(tail[0].date);
  const byDate = new Map(stored.map((candle) => [candle.date, candle]));
  // Compare closed overlap candles (all but the newest stored one, which may still have been forming).
  const overlap = tail.filter((candle) => byDate.has(candle.date)).slice(0, -1);
  for (const candle of overlap) {
    const old = byDate.get(candle.date)!;
    if (old.close > 0 && Math.abs(candle.close / old.close - 1) > ADJUSTMENT_TOLERANCE) return null;
  }
  return [...stored.filter((candle) => Date.parse(candle.date) < firstTail), ...tail].filter((candle) => Date.parse(candle.date) >= keepFrom);
}
