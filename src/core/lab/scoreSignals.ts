import { FEATURE_WINDOW, WARMUP_SESSIONS, scanSignals, type Signal, type SignalScan } from "@/core/backtest/signals";
import { HOLD_BARS, LOOKBACK_SESSIONS, simulatePlan } from "@/core/screener/backtest";
import { featureCursor, type FeatureCursor } from "@/core/screener/featureCursor";
import {
  accumulationPart,
  extensionPart,
  factsFrom,
  patternPart,
  rrPart,
  stopPart,
  trackPart,
  trendPart,
  type StockFacts,
} from "@/core/screener/score";
import { SCREEN_MAP } from "@/core/screener/screens";
import type { DailyBar } from "@/core/types";
import type { SignalValues } from "./engine";
import type { LabSignal, SignalContext } from "./signals";

// The setup score's factors as Signal Lab signals (#29), so each factor has a
// report card and the score can leave out the ones that don't pass. Kept out of
// signals.ts (which imports this list; this file imports only its types, so
// there is no import cycle). Pure.
//
// Each signal values a stock exactly as the score's factor function awards it
// (src/core/screener/score.ts): the same features (featureCursor on the 260
// bars ending at the session, as the screens and the backtester see them), the
// same points. Relative strength is score-rs (./momentumSignals.ts).
//
//   score-trend, score-accumulation, score-pattern, score-extension
//       every stock, every session (after the backtester's 60-session warm-up)
//   score-rr, score-stop
//       depend on a trade plan, so they are valued on the sessions a screen
//       matched the stock (the screens' signal scan, as screen-score:<id>):
//       the factor's points for that match's plan; a stock matching several
//       screens gets its best. Only matched stocks are ranked that day.
//   score-track
//       the screen's track record as the score reads it — avg R of its signals
//       over the last 160 sessions with at least 20 of them (screener/backtest.ts
//       runTrackRecord), POINT IN TIME: only signals whose holding period had
//       ended by that session count. On matched sessions, like score-rr.
//
// A day with fewer matched stocks than the Lab's minimum (20) isn't ranked, so
// the plan-based factors have fewer days than the others: their cards say so.

interface Cursor {
  cursor: FeatureCursor;
  index: Map<number, number>;
}

/** Each stock's feature cursor and bar index, built on first use. */
function cursors(ctx: SignalContext) {
  const cache = new Map<string, Cursor | null>();
  return (symbol: string): Cursor | null => {
    let entry = cache.get(symbol);
    if (entry === undefined) {
      const bars = ctx.bars.get(symbol);
      entry = bars && bars.length >= WARMUP_SESSIONS ? { cursor: featureCursor(symbol, bars as DailyBar[]), index: new Map(bars.map((bar, i) => [bar.t, i])) } : null;
      cache.set(symbol, entry);
    }
    return entry;
  };
}

/** The stock's facts at bar i, from the FEATURE_WINDOW bars ending there (relative strength isn't ranked: no factor here reads it). */
const factsAt = (entry: Cursor, i: number): StockFacts => factsFrom(entry.cursor.at(i, Math.max(0, i - FEATURE_WINDOW + 1)));

/** A factor that needs only the stock's own bars: its points every session after the warm-up. */
export function factValues(ctx: SignalContext, points: (facts: StockFacts) => number): SignalValues {
  const cursorOf = cursors(ctx);
  return (day, symbol) => {
    const entry = cursorOf(symbol);
    const i = entry?.index.get(day);
    if (!entry || i === undefined || i < WARMUP_SESSIONS - 1) return null;
    const value = points(factsAt(entry, i));
    return Number.isFinite(value) ? value : null;
  };
}

/** The screens' signal scan: the service's cached one, else a scan of every screen. */
async function scanOf(ctx: SignalContext): Promise<SignalScan> {
  return (
    ctx.scan ??
    (await scanSignals({
      symbols: [...ctx.symbols],
      getBars: (symbol) => (ctx.bars.get(symbol) ?? []) as DailyBar[],
      benchmark: ctx.benchmark as DailyBar[],
      pause: ctx.pause,
      isMember: ctx.isMember,
    }))
  );
}

/** The best of a value over each stock's matches on each session. */
function bestPerMatch(scan: SignalScan, value: (signal: Signal) => number | null): SignalValues {
  const best = new Map<number, Map<string, number>>();
  for (const [day, signals] of scan.byDate) {
    for (const signal of signals) {
      const v = value(signal);
      if (v === null || !Number.isFinite(v)) continue;
      let row = best.get(day);
      if (!row) best.set(day, (row = new Map()));
      const seen = row.get(signal.symbol);
      if (seen === undefined || v > seen) row.set(signal.symbol, v);
    }
  }
  return (day, symbol) => best.get(day)?.get(symbol) ?? null;
}

/** A plan-based factor's points on each match (facts at the signal's bar). */
async function planValues(ctx: SignalContext, points: (facts: StockFacts, signal: Signal) => number): Promise<SignalValues> {
  const scan = await scanOf(ctx);
  const cursorOf = cursors(ctx);
  return bestPerMatch(scan, (signal) => {
    const entry = cursorOf(signal.symbol);
    const i = entry?.index.get(signal.date);
    return entry && i !== undefined ? points(factsAt(entry, i), signal) : null;
  });
}

interface Outcome {
  /** Calendar position of the signal and of the session its holding period ends. */
  at: number;
  done: number;
  r: number;
}

/**
 * Each screen's track record as it stood at every session: avg R (simulatePlan,
 * as runTrackRecord) of its signals from the last `lookback` sessions whose
 * holding period had ended by then. Returns (screen, calendar position) → record.
 */
export function pointInTimeTrack(scan: SignalScan, lookback = LOOKBACK_SESSIONS): (screenId: string, at: number) => { avgR: number | null; signals: number } {
  const position = new Map(scan.dates.map((day, d) => [day, d]));
  const byScreen = new Map<string, Outcome[]>();
  for (const [day, signals] of scan.byDate) {
    const at = position.get(day);
    if (at === undefined) continue;
    for (const signal of signals) {
      const screen = SCREEN_MAP[signal.screenId];
      const bars = scan.series.get(signal.symbol)?.bars;
      if (!screen || !bars) continue;
      const hold = HOLD_BARS[screen.group];
      if (signal.index + hold > bars.length - 1) continue; // never completes in the data
      const result = simulatePlan(bars, signal.index, { entry: signal.entry, stop: signal.stop, target: signal.target }, hold, screen.exit);
      const done = position.get(bars[signal.index + hold].t);
      if (!result || done === undefined || !Number.isFinite(result.r)) continue;
      let list = byScreen.get(signal.screenId);
      if (!list) byScreen.set(signal.screenId, (list = []));
      list.push({ at, done, r: result.r });
    }
  }
  const memo = new Map<string, { avgR: number | null; signals: number }>();
  return (screenId, at) => {
    const key = `${screenId}:${at}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const list = byScreen.get(screenId) ?? [];
    // Signals are in date order: find the window's first one, then walk to `at`.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].at < at - lookback + 1) lo = mid + 1;
      else hi = mid;
    }
    let sum = 0;
    let n = 0;
    for (let k = lo; k < list.length && list[k].at <= at; k += 1) {
      if (list[k].done > at) continue;
      sum += list[k].r;
      n += 1;
    }
    const record = { avgR: n ? sum / n : null, signals: n };
    memo.set(key, record);
    return record;
  };
}

const NOTE = "The setup score's factor as it awards it (src/core/screener/score.ts), so the factor has a report card: a factor without a passing card is left out of the score (#29).";

const factSignal = (id: string, name: string, summary: string, points: (facts: StockFacts) => number): LabSignal => ({
  id,
  name,
  group: "built-in",
  kind: "numeric",
  summary: `${summary} ${NOTE}`,
  params: [],
  build: (ctx) => factValues(ctx, points),
});

export const SCORE_SIGNALS: LabSignal[] = [
  factSignal(
    "score-trend",
    "Score: trend (15 pts)",
    "Minervini's trend template in points: close above the 50-day SMA (4), 50 above 200-day SMA (4), 200-day SMA rising over a month (3), close above the 20-day EMA (4).",
    (facts) => trendPart(facts).points,
  ),
  factSignal(
    "score-accumulation",
    "Score: accumulation (10 pts)",
    "Up-day ÷ down-day volume over 20 sessions (0–6 points from 0.8× to 1.8×) plus delivery % ÷ its 20-day average (0–4 from 0.8× to 1.5×; 2 when delivery is unknown).",
    (facts) => accumulationPart(facts).points,
  ),
  factSignal(
    "score-pattern",
    "Score: chart pattern (15 pts)",
    "Quality (0–100) of the best bullish chart pattern × 15 on a breakout, 12 while forming, 4 otherwise; 0 with none.",
    (facts) => patternPart(facts).points,
  ),
  factSignal(
    "score-extension",
    "Score: not extended (10 pts)",
    "Distance of the close above its 20-day EMA in ATRs: 10 points up to 1.5, 6 to 2.5, 3 to 3.5, 0 beyond (chasing).",
    (facts) => extensionPart(facts).points,
  ),
  {
    id: "score-rr",
    name: "Score: reward : risk (15 pts)",
    group: "built-in",
    kind: "numeric",
    summary: `On the sessions a screen matched the stock: reward ÷ risk of the match's plan to the nearer of its target and resistance in the way, 0 points at 1R to 15 at 3R (7 for a trailing exit); a stock matching several screens gets its best. Only matched stocks are ranked. ${NOTE}`,
    params: [],
    usesScan: true,
    build: (ctx) => planValues(ctx, (facts, signal) => rrPart(facts, signal).part.points),
  },
  {
    id: "score-stop",
    name: "Score: stop distance (10 pts)",
    group: "built-in",
    kind: "numeric",
    summary: `On the sessions a screen matched the stock: the plan's stop distance in points — 10 for 2–6% below the entry, less when tighter (noise) or wider than 8%; a stock matching several screens gets its best. Only matched stocks are ranked. ${NOTE}`,
    params: [],
    usesScan: true,
    build: (ctx) => planValues(ctx, (_facts, signal) => stopPart(signal).points),
  },
  {
    id: "score-track",
    name: "Score: track record (10 pts)",
    group: "built-in",
    kind: "numeric",
    summary: `On the sessions a screen matched the stock: the screen's track record as it stood then — avg R of its signals in the previous 160 sessions whose holding period had ended (10 points at +0.3R, 7.5 at +0.1R, 4 near zero, 0 below −0.1R, a neutral 5 with under 20 signals); a stock matching several screens gets its best. ${NOTE}`,
    params: [],
    usesScan: true,
    build: async (ctx) => {
      const scan = await scanOf(ctx);
      const position = new Map(scan.dates.map((day, d) => [day, d]));
      const record = pointInTimeTrack(scan);
      return bestPerMatch(scan, (signal) => {
        const at = position.get(signal.date);
        return at === undefined ? null : trackPart(record(signal.screenId, at)).points;
      });
    },
  },
];
