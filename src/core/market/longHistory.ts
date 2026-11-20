// Checks and joins for daily history that reaches back decades (pure).
//
// The Market Data Hub serves one continuous series per company across its
// ticker renames (INFY includes INFOSYSTCH before June 2011; market-data-hub
// #22 and #35). `historyGaps` is how Tradex checks that what it holds really is
// continuous: a session the market traded, inside the stock's own span, that
// the series lacks — across a rename that is the join failing
// (ice-009/tradex-public#16).
//
// NIFTY's daily history comes from NSE's index file, which starts in 2012;
// before that the hub has a synthetic equal-weight NIFTY 50 basket built from
// the cash archive. `spliceBenchmark` puts the basket in front of NIFTY,
// scaled to meet it, so a backtest of 2008 still has a market state — and
// says up to when the stand-in was used.

import type { DailyBar } from "@/core/types";

/**
 * Sessions of `calendar` (day keys, any order) between the series' first and
 * last bar that the series lacks, oldest first.
 */
export function historyGaps(bars: readonly DailyBar[], calendar: Iterable<number>): number[] {
  if (bars.length < 2) return [];
  const first = bars[0].t;
  const last = bars[bars.length - 1].t;
  const held = new Set(bars.map((bar) => bar.t));
  return [...new Set(calendar)].filter((day) => day > first && day < last && !held.has(day)).sort((a, b) => a - b);
}

export interface SplicedBenchmark {
  bars: DailyBar[];
  /** Last session that came from the stand-in (null: none was needed or available). */
  standInUntil: number | null;
}

/**
 * The index where it has bars; before its first bar, the stand-in scaled so
 * the two meet on the index's first session (the stand-in's close that day, or
 * its last close before it). Both oldest first.
 */
export function spliceBenchmark(index: readonly DailyBar[], standIn: readonly DailyBar[]): SplicedBenchmark {
  if (!index.length) return standIn.length ? { bars: [...standIn], standInUntil: standIn[standIn.length - 1].t } : { bars: [], standInUntil: null };
  const start = index[0].t;
  const before = standIn.filter((bar) => bar.t < start);
  if (!before.length) return { bars: [...index], standInUntil: null };
  const meet = standIn.find((bar) => bar.t === start) ?? before[before.length - 1];
  const scale = index[0].c / meet.c;
  const round = (value: number) => Math.round(value * scale * 100) / 100;
  const scaled = before.map((bar) => ({ t: bar.t, o: round(bar.o), h: round(bar.h), l: round(bar.l), c: round(bar.c), v: bar.v }));
  return { bars: [...scaled, ...index], standInUntil: before[before.length - 1].t };
}
