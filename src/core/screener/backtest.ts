import type { DailyBar } from "@/core/types";
import { computeFeatures, rankRelativeStrength, type Features } from "@/core/screener/features";
import { SCREENS, type ScreenDef, type ScreenGroup } from "@/core/screener/screens";

// Track record: replay every screen's rules over the cached daily history and
// walk each past signal's plan forward, bar by bar, to see whether the target
// or the stop came first. The idea comes from the Day Trader skill's Time
// Machine ("every past time the setup fired"), adapted to daily bars:
//   - A bar that touches both the stop and the target counts as the stop.
//   - A gap through a level fills at the open (worse than the level), not at it.
//   - A buy-stop entry (NR7, bull flag) must trade through next session or the
//     signal is skipped — no fill, no trade.
//   - Still open at the holding horizon: R is the close's distance from entry.
// It is what these rules did on these stocks, not a prediction.

/** Sessions a plan is held before it is marked to the close. */
export const HOLD_BARS: Record<ScreenGroup, number> = { btst: 1, swing: 10, positional: 25, results: 10 };
/** How far back signals are replayed. */
const LOOKBACK_SESSIONS = 160;
const MIN_HISTORY = 60;
const MIN_SIGNALS_FOR_VERDICT = 20;

export interface Outcome {
  signals: number;
  target: number;
  stop: number;
  open: number;
  /** Sum of R over all signals (mean = sumR / signals). */
  sumR: number;
}

export interface TrackRecord extends Outcome {
  screenId: string;
  /** Target R of the plan when it is fixed (1.5, 2, 3); null for trailing plans. */
  planR: number | null;
  avgR: number | null;
  /** Of the signals that hit a side, the share that hit the target first. */
  winShare: number | null;
  /** Win share a fixed-R plan needs to break even: 1 / (1 + R). */
  breakEven: number | null;
  verdict: string;
  tone: "good" | "bad" | "flat" | "none";
}

/** Result of replaying every screen over past sessions. */
export interface TrackReplay {
  sessions: number;
  from: number;
  to: number;
  screens: Record<string, TrackRecord>;
  /** Per screen, per symbol: that stock's own record with the setup. */
  bySymbol: Record<string, Record<string, Outcome>>;
}

const emptyOutcome = (): Outcome => ({ signals: 0, target: 0, stop: 0, open: 0, sumR: 0 });

function add(outcome: Outcome, kind: "target" | "stop" | "open", r: number) {
  outcome.signals += 1;
  outcome[kind] += 1;
  outcome.sumR += r;
}

/** Walk a plan forward from the signal bar. Returns null when a buy-stop entry never fills. */
export function simulatePlan(
  bars: DailyBar[],
  signalIndex: number,
  plan: { entry: number; stop: number; target: number | null },
  holdBars: number,
): { kind: "target" | "stop" | "open"; r: number } | null {
  const risk = plan.entry - plan.stop;
  if (!(risk > 0)) return null;
  const { stop, target } = plan;
  let entry = plan.entry;
  let fillBar = -1; // bar on which a buy-stop entry filled (no gap logic on that bar)

  // An entry above the signal close is a buy-stop for the next session.
  if (plan.entry > bars[signalIndex].c * 1.0005) {
    const next = bars[signalIndex + 1];
    if (!next || next.h < plan.entry) return null;
    entry = Math.max(next.o, plan.entry);
    fillBar = signalIndex + 1;
  }
  const R = (price: number) => (price - entry) / (entry - stop);

  const last = Math.min(bars.length - 1, signalIndex + holdBars);
  for (let i = signalIndex + 1; i <= last; i += 1) {
    const bar = bars[i];
    const gaps = i !== fillBar;
    if (bar.l <= stop) return { kind: "stop", r: R(gaps ? Math.min(stop, bar.o) : stop) };
    if (target !== null && bar.h >= target) return { kind: "target", r: R(gaps ? Math.max(target, bar.o) : target) };
  }
  return { kind: "open", r: R(bars[last].c) };
}

function planMultiple(screen: ScreenDef, f: Features): number | null {
  const plan = screen.plan(f);
  const risk = plan.entry - plan.stop;
  if (plan.target === null || !(risk > 0)) return null;
  return Math.round(((plan.target - plan.entry) / risk) * 10) / 10;
}

export function verdictFor(record: Outcome, planR: number | null): Pick<TrackRecord, "avgR" | "winShare" | "breakEven" | "verdict" | "tone"> {
  const avgR = record.signals ? record.sumR / record.signals : null;
  const sided = record.target + record.stop;
  const winShare = sided ? record.target / sided : null;
  const breakEven = planR ? 1 / (1 + planR) : null;
  if (record.signals < MIN_SIGNALS_FOR_VERDICT || avgR === null) {
    return { avgR, winShare, breakEven, verdict: `Too few signals to judge (${record.signals}).`, tone: "none" };
  }
  // Fixed-R plans: compare the win share with break-even, like the Time Machine — but only when most
  // trades actually reached a side. If most were still open at the horizon, the close decided them.
  const mostlyOpen = record.open / record.signals > 0.4;
  if (winShare !== null && breakEven !== null && !mostlyOpen && sided >= MIN_SIGNALS_FOR_VERDICT / 2) {
    const gap = (winShare - breakEven) * 100;
    const side = gap >= 0 ? "the target" : "the stop";
    if (Math.abs(gap) < 5) return { avgR, winShare, breakEven, verdict: "Close to break-even.", tone: "flat" };
    if (Math.abs(gap) < 15) return { avgR, winShare, breakEven, verdict: `Leans toward ${side}.`, tone: gap > 0 ? "good" : "bad" };
    return { avgR, winShare, breakEven, verdict: `Strongly toward ${side}.`, tone: gap > 0 ? "good" : "bad" };
  }
  const note = mostlyOpen && planR ? " Most were still open at the horizon." : "";
  if (Math.abs(avgR) < 0.1) return { avgR, winShare, breakEven, verdict: `Close to break-even.${note}`, tone: "flat" };
  return avgR > 0
    ? { avgR, winShare, breakEven, verdict: `${avgR >= 0.3 ? "Strongly positive" : "Positive"} average R.${note}`, tone: "good" }
    : { avgR, winShare, breakEven, verdict: `${avgR <= -0.3 ? "Strongly negative" : "Negative"} average R.${note}`, tone: "bad" };
}
/**
 * Replay all screens over the last LOOKBACK_SESSIONS sessions of the given
 * history. `getBars` returns stored (EOD) daily bars, oldest first.
 */
export async function runTrackRecord(
  symbols: string[],
  getBars: (symbol: string) => DailyBar[],
  benchmark: string,
): Promise<TrackReplay> {
  const benchBars = getBars(benchmark);
  const series = new Map<string, { bars: DailyBar[]; index: Map<number, number> }>();
  for (const symbol of symbols) {
    const bars = getBars(symbol);
    if (bars.length < MIN_HISTORY) continue;
    series.set(symbol, { bars, index: new Map(bars.map((bar, i) => [bar.t, i])) });
  }
  const benchIndex = new Map(benchBars.map((bar, i) => [bar.t, i]));
  // Calendar of sessions: the union of everyone's dates, newest last.
  const dates = [...new Set([...series.values()].flatMap((entry) => entry.bars.map((bar) => bar.t)))].sort((a, b) => a - b);
  const replayDates = dates.slice(Math.max(MIN_HISTORY, dates.length - LOOKBACK_SESSIONS));

  const screens: Record<string, Outcome> = Object.fromEntries(SCREENS.map((screen) => [screen.id, emptyOutcome()]));
  const planR: Record<string, number | null> = {};
  const bySymbol: Record<string, Record<string, Outcome>> = Object.fromEntries(SCREENS.map((screen) => [screen.id, {}]));

  for (const date of replayDates) {
    // Yield between sessions so a long replay doesn't stall chart and quote requests.
    await new Promise((resolve) => setImmediate(resolve));
    const day: Array<{ f: Features; bars: DailyBar[]; i: number }> = [];
    for (const [symbol, entry] of series) {
      const i = entry.index.get(date);
      if (i === undefined || i < MIN_HISTORY - 1) continue;
      const slice = entry.bars.slice(Math.max(0, i - 259), i + 1);
      day.push({ f: computeFeatures(symbol, slice, false), bars: entry.bars, i });
    }
    if (!day.length) continue;
    rankRelativeStrength(day.map((item) => item.f));
    const bi = benchIndex.get(date);
    const niftyRet126 = bi !== undefined && bi >= 126 ? (benchBars[bi].c / benchBars[bi - 126].c - 1) * 100 : NaN;
    const ctx = { niftyRet126 };

    for (const screen of SCREENS) {
      const hold = HOLD_BARS[screen.group];
      for (const { f, bars, i } of day) {
        if (i + hold > bars.length - 1) continue; // needs the full holding period after the signal
        if (screen.basis === "eod" && bars[i].dp === undefined) continue;
        if (!screen.rules.every((rule) => rule.test(f, ctx))) continue;
        const plan = screen.plan(f);
        const result = simulatePlan(bars, i, plan, hold);
        if (!result) continue;
        if (planR[screen.id] === undefined) planR[screen.id] = planMultiple(screen, f);
        add(screens[screen.id], result.kind, result.r);
        const mine = (bySymbol[screen.id][f.symbol] ??= emptyOutcome());
        add(mine, result.kind, result.r);
      }
    }
  }

  const records: Record<string, TrackRecord> = {};
  for (const screen of SCREENS) {
    const outcome = screens[screen.id];
    const r = planR[screen.id] ?? null;
    records[screen.id] = { screenId: screen.id, planR: r, ...outcome, ...verdictFor(outcome, r) };
  }
  return {
    sessions: replayDates.length,
    from: replayDates[0],
    to: replayDates[replayDates.length - 1],
    screens: records,
    bySymbol,
  };
}
