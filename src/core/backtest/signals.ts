import type { DailyBar } from "@/core/types";
import { computeFeatures, rankRelativeStrength, type Features } from "@/core/screener/features";
import { SCREENS, type ScreenDef } from "@/core/screener/screens";

// Step 1 of a backtest: replay the screens over history and record every
// signal, session by session. This is the expensive part (features for every
// stock on every session), and it doesn't depend on the portfolio settings, so
// the service caches one scan per universe and last session and runs any number
// of portfolio simulations (portfolio.ts) on it.
//
// No look-ahead: a session's features are computed from that stock's bars up to
// and including that session only (`bars.slice(.., i + 1)`), and relative
// strength is ranked across stocks on the same session. Nothing about later
// sessions can change an earlier signal — signals.test.ts checks this.

/** Sessions of history a stock needs before its features are trusted (same as the track record). */
export const WARMUP_SESSIONS = 60;
/** Bars handed to computeFeatures per session (52 weeks + a little, as the live screener uses). */
const FEATURE_WINDOW = 260;

export interface Signal {
  symbol: string;
  screenId: string;
  /** Session the screen matched (its close is the decision point). */
  date: number;
  /** Index of that session in the symbol's bars. */
  index: number;
  score: number;
  close: number;
  entry: number;
  stop: number;
  target: number | null;
}

export interface Series {
  bars: DailyBar[];
  index: Map<number, number>;
}

export interface SignalScan {
  /** Trading calendar: the union of every stock's sessions, oldest first. */
  dates: number[];
  /** First session on which any stock had enough history for a signal. */
  firstSignalDate: number | null;
  /** First session each screen fired (screens needing a 200-day average or a 52-week high fire later). */
  firstByScreen: Record<string, number>;
  /** Signals per session (key = session), in screen order. */
  byDate: Map<number, Signal[]>;
  series: Map<string, Series>;
  benchmark: DailyBar[];
  symbols: number;
  signals: number;
}

export interface ScanInput {
  symbols: string[];
  getBars: (symbol: string) => DailyBar[];
  benchmark: DailyBar[];
  /** Screens to replay (default: all). */
  screens?: ScreenDef[];
  /** Called between sessions — the service passes a setImmediate so a long scan doesn't block the server. */
  pause?: () => Promise<void>;
}

export function seriesOf(bars: DailyBar[]): Series {
  return { bars, index: new Map(bars.map((bar, i) => [bar.t, i])) };
}

export async function scanSignals({ symbols, getBars, benchmark, screens = SCREENS, pause }: ScanInput): Promise<SignalScan> {
  const series = new Map<string, Series>();
  for (const symbol of symbols) {
    const bars = getBars(symbol);
    if (bars.length < WARMUP_SESSIONS) continue;
    series.set(symbol, seriesOf(bars));
  }
  const bench = seriesOf(benchmark);
  const dates = [...new Set([...series.values()].flatMap((entry) => entry.bars.map((bar) => bar.t)))].sort((a, b) => a - b);
  const byDate = new Map<number, Signal[]>();
  let firstSignalDate: number | null = null;
  let count = 0;
  const firstByScreen: Record<string, number> = {};

  for (const date of dates) {
    if (pause) await pause();
    const day: Features[] = [];
    const where = new Map<string, { bars: DailyBar[]; i: number }>();
    for (const [symbol, entry] of series) {
      const i = entry.index.get(date);
      if (i === undefined || i < WARMUP_SESSIONS - 1) continue;
      // Only bars up to and including this session: the screen can't see the future.
      day.push(computeFeatures(symbol, entry.bars.slice(Math.max(0, i - FEATURE_WINDOW + 1), i + 1), false));
      where.set(symbol, { bars: entry.bars, i });
    }
    if (!day.length) continue;
    firstSignalDate ??= date;
    rankRelativeStrength(day);
    const bi = bench.index.get(date);
    const niftyRet126 = bi !== undefined && bi >= 126 ? (benchmark[bi].c / benchmark[bi - 126].c - 1) * 100 : NaN;
    const ctx = { niftyRet126 };

    const found: Signal[] = [];
    for (const screen of screens) {
      for (const f of day) {
        const { bars, i } = where.get(f.symbol)!;
        // End-of-day screens read delivery %, which only exists for completed sessions.
        if (screen.basis === "eod" && bars[i].dp === undefined) continue;
        if (!screen.rules.every((rule) => rule.test(f, ctx))) continue;
        const plan = screen.plan(f);
        if (!(plan.entry - plan.stop > 0)) continue;
        const score = screen.score(f);
        firstByScreen[screen.id] ??= date;
        found.push({
          symbol: f.symbol,
          screenId: screen.id,
          date,
          index: i,
          score: Number.isFinite(score) ? score : 0,
          close: bars[i].c,
          entry: plan.entry,
          stop: plan.stop,
          target: plan.target,
        });
      }
    }
    if (found.length) {
      byDate.set(date, found);
      count += found.length;
    }
  }
  return { dates, firstSignalDate, firstByScreen, byDate, series, benchmark, symbols: series.size, signals: count };
}
