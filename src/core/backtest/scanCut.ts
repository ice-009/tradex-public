import type { DailyBar } from "@/core/types";
import { FEATURE_WINDOW, WARMUP_SESSIONS, seriesOf, type ScanInput, type Series, type Signal, type SignalScan } from "./signals";

// One scan, cut at each day (issue #32, Time Machine replay). Stepping a
// replay day by day used to replay every screen over five years for each day
// (~8 s); now one scan over the replay block — the look-back of its first day
// through its last day — is cut at each day instead.
//
// `cutScan` returns exactly what `scanSignals` would return for that day's own
// input (its bars from its own look-back to its close, its F&O membership)
// for every session from `from` — the first session the day's table counts —
// to the day: the same calendar, the same first signal session, the same
// signals, and each stock's bars up to the day. That holds because a
// session's features read only the 260 bars ending on it, relative strength
// is ranked across the stocks with features that session, and NIFTY's
// 126-session return reads its own bars — all of which the cut checks are the
// same in both, together with each stock's membership on every session
// counted. When any check fails (a stock with a gap that makes its 260-bar
// window reach before the day's look-back, a list that differs, NIFTY's
// history spliced differently) it returns null and the caller scans from
// scratch. evidenceReplay.test.ts proves the tables equal end to end.

/** What a block scan was computed with: its scan, and the membership it used. */
export interface BlockScan {
  scan: SignalScan;
  isMember?: (symbol: string, date: number) => boolean;
}

const NIFTY_RETURN_SESSIONS = 126;

/** Index of the bar at `time` in a series, or −1. */
const indexAt = (series: Series, time: number) => series.index.get(time) ?? -1;

/**
 * The block's scan cut to `input` (one day's own scan input), counting from
 * `from` up to `day`; null when it can't be shown to equal a scan of `input`.
 */
export function cutScan(block: BlockScan, input: ScanInput, day: number, from: number): SignalScan | null {
  const member = input.isMember ?? (() => true);
  const blockMember = block.isMember ?? (() => true);

  // The stocks the day's own scan would replay, and its calendar.
  const own = new Map<string, DailyBar[]>();
  for (const symbol of input.symbols) {
    const bars = input.getBars(symbol);
    if (bars.length >= WARMUP_SESSIONS) own.set(symbol, bars);
  }
  const dates = [...new Set([...own.values()].flatMap((bars) => bars.map((bar) => bar.t)))].sort((a, b) => a - b);
  if (dates.length && dates.at(-1)! > day) return null;

  // The first session any member stock had enough history for a signal.
  let firstSignalDate: number | null = null;
  for (const [symbol, bars] of own) {
    for (let i = WARMUP_SESSIONS - 1; i < bars.length; i += 1) {
      if (firstSignalDate !== null && bars[i].t >= firstSignalDate) break;
      if (member(symbol, bars[i].t)) {
        firstSignalDate = bars[i].t;
        break;
      }
    }
  }
  const first = Math.max(firstSignalDate ?? 0, from);

  // Every stock of the block: the same bars as the day's own, the same 260-bar windows and the same membership on every counted session.
  const offsets = new Map<string, number>();
  for (const [symbol, series] of block.scan.series) {
    const bars = series.bars;
    const mine = own.get(symbol);
    if (!mine) {
      // Not in the day's scan: it must have had no features on a counted session.
      for (let i = WARMUP_SESSIONS - 1; i < bars.length && bars[i].t <= day; i += 1) if (bars[i].t >= first && blockMember(symbol, bars[i].t)) return null;
      continue;
    }
    const off = indexAt(series, mine[0].t);
    if (off < 0 || off + mine.length > bars.length) return null;
    for (let j = 0; j < mine.length; j += 1) {
      const a = bars[off + j];
      const b = mine[j];
      if (a.t !== b.t || a.c !== b.c || a.o !== b.o || a.h !== b.h || a.l !== b.l || a.v !== b.v || a.dp !== b.dp) return null;
    }
    const j0 = mine.findIndex((bar) => bar.t >= first);
    if (j0 < 0) {
      offsets.set(symbol, off);
      continue;
    }
    for (let j = j0; j < mine.length; j += 1) {
      const t = mine[j].t;
      const isIn = member(symbol, t);
      if (isIn !== blockMember(symbol, t)) return null;
      // A longer look-back must not reach into the 260-bar window of a counted session with features.
      if (isIn && off > 0 && j < FEATURE_WINDOW - 1 && off + j >= WARMUP_SESSIONS - 1) return null;
    }
    offsets.set(symbol, off);
  }
  for (const [symbol, mine] of own) {
    if (block.scan.series.has(symbol)) continue;
    for (let j = WARMUP_SESSIONS - 1; j < mine.length; j += 1) if (mine[j].t >= first && member(symbol, mine[j].t)) return null;
  }

  // NIFTY: the same bars, and its 126-session return the same on every counted session.
  const bench = input.benchmark;
  const blockBench = block.scan.benchmark;
  if (!bench.length) {
    if (blockBench.some((bar) => bar.t <= day)) return null;
  } else {
    const o = blockBench.findIndex((bar) => bar.t === bench[0].t);
    if (o < 0 || o + bench.length > blockBench.length) return null;
    for (let k = 0; k < bench.length; k += 1) if (blockBench[o + k].t !== bench[k].t || blockBench[o + k].c !== bench[k].c) return null;
    const k0 = bench.findIndex((bar) => bar.t >= first);
    if (o > 0 && k0 >= 0 && k0 < NIFTY_RETURN_SESSIONS) return null;
  }

  const byDate = new Map<number, Signal[]>();
  const firstByScreen: Record<string, number> = {};
  let signals = 0;
  for (const date of dates) {
    if (date < first) continue;
    const list = block.scan.byDate.get(date);
    if (!list?.length) continue;
    byDate.set(date, list);
    signals += list.length;
    for (const signal of list) firstByScreen[signal.screenId] ??= date;
  }
  // Each stock's bars up to the day, indexed as the block's (its signals carry the block's indices).
  const series = new Map<string, Series>();
  for (const [symbol, mine] of own) {
    const whole = block.scan.series.get(symbol);
    const off = offsets.get(symbol);
    series.set(symbol, whole && off !== undefined ? { bars: whole.bars.slice(0, off + mine.length), index: whole.index } : seriesOf(mine));
  }
  return { dates, firstSignalDate, firstByScreen, byDate, series, benchmark: bench, symbols: own.size, signals };
}
