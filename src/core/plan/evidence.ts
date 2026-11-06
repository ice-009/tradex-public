import { roundTripCosts, slipped, type CostModel } from "@/core/backtest/costs";
import { isBuyStop } from "@/core/backtest/portfolio";
import type { SignalScan } from "@/core/backtest/signals";
import { HOLD_BARS, simulatePlan } from "@/core/screener/backtest";
import { tradeQty } from "@/core/screener/liveRecord";
import { SCREENS, SCREEN_MAP } from "@/core/screener/screens";
import type { DailyBar } from "@/core/types";

// Strategy evidence: which screens have earned a place in the daily plan.
//
// Every screen is replayed over the stored daily history (scanSignals, no
// look-ahead) and every signal's plan is walked forward with the same rules as
// the track record (simulatePlan): bought at the signal close (the screens are
// run at 3:15–3:25 PM) or, for a buy-stop, on the next session if it trades
// through; out at the stop, the target, the next open (BTST) or the close after
// the holding period. Each trade's outcome is in R of the PLANNED risk (entry −
// stop, what the position is sized on), net of slippage and charges.
//
// Results are split by market state on the signal day: NIFTY's close above or
// below its 200-day average. Long breakouts and trend screens tend to work only
// when the index is in an uptrend; a screen has to prove itself in each state
// separately. The rule for a place in the plan (per state):
//
//   PASS = mean net R > 0 in the first 60% of its signals AND in the last 40%
//          (in date order, so the later part is the recent market), AND a
//          t-stat over days > 2.
//
// The split is made per bucket, by its own signals: NIFTY spent most of
// 2022–24 above its 200-day average and most of 2025–26 below it, so a
// calendar split would leave one part of each state nearly empty.
//
// The t-stat weights each signal DAY equally (the mean of that day's trades),
// because signals on the same day are not independent: one market move decides
// them all. Counting trades would overstate the evidence on busy days.
//
// Whether a screen's score picks better trades is checked too: top third vs
// bottom third of its signals by score. When it doesn't, the plan doesn't rank
// that screen's signals by score. Pure.

export type MarketState = "up" | "down";

/** Signals a bucket needs before its verdict means anything. */
export const MIN_TRADES = 30;
/** First share of the history; the rest is the "last 40%" check. */
export const SPLIT_FRACTION = 0.6;
/** t-stat a screen must clear (over days). */
export const MIN_T = 2;
const RECENT_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/** NIFTY above (up) or below (down) its 200-day average on each of its sessions; no entry before 200 sessions exist. */
export function marketStates(nifty: DailyBar[], period = 200): Map<number, MarketState> {
  const out = new Map<number, MarketState>();
  let sum = 0;
  for (let i = 0; i < nifty.length; i += 1) {
    sum += nifty[i].c;
    if (i >= period) sum -= nifty[i - period].c;
    if (i >= period - 1) out.set(nifty[i].t, nifty[i].c > sum / period ? "up" : "down");
  }
  return out;
}

/** The state on a day: that day's, else the last known one before it (a stock session NIFTY's file lacks). */
export function stateOn(states: Map<number, MarketState>, sortedDays: number[], day: number): MarketState | null {
  const direct = states.get(day);
  if (direct) return direct;
  let lo = 0;
  let hi = sortedDays.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedDays[mid] <= day) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 ? (states.get(sortedDays[found]) ?? null) : null;
}

export interface EvidenceTrade {
  screenId: string;
  symbol: string;
  /** Signal session (day key). */
  date: number;
  score: number;
  state: MarketState | null;
  /** Fill before slippage and the exit price. */
  entry: number;
  exit: number;
  kind: "target" | "stop" | "open";
  /** Price move ÷ planned risk, before costs. */
  grossR: number;
  /** After slippage on both legs and the round trip's charges (one lot, or ~₹5 lakh of shares without a lot size). */
  netR: number;
}

/** Net R of one round trip, in units of the planned risk per share. */
export function netRMultiple(params: { entry: number; exit: number; risk: number; qty: number; costs: CostModel }): number {
  const { entry, exit, risk, qty, costs } = params;
  const entryFill = slipped("buy", entry, costs);
  const exitFill = slipped("sell", exit, costs);
  const charges = roundTripCosts(entryFill, exitFill, qty, costs).total;
  return ((exitFill - entryFill) * qty - charges) / (qty * risk);
}

/** A round trip's slippage + charges as % of the position, for a typical ₹5 lakh lot. */
export function roundTripPct(costs: CostModel, price = 1000, qty = 500): number {
  const entryFill = slipped("buy", price, costs);
  const exitFill = slipped("sell", price, costs);
  const charges = roundTripCosts(entryFill, exitFill, qty, costs).total;
  return (((entryFill - exitFill) * qty + charges) / (price * qty)) * 100;
}

/**
 * Walk every scanned signal forward (needs its full holding period after the
 * signal). Buy-stops that never trade through are not trades.
 */
export function replaySignals(scan: SignalScan, options: { costs: CostModel; lots: Record<string, number>; states: Map<number, MarketState> }): EvidenceTrade[] {
  const { costs, lots, states } = options;
  const stateDays = [...states.keys()].sort((a, b) => a - b);
  const out: EvidenceTrade[] = [];
  for (const [date, signals] of scan.byDate) {
    const state = stateOn(states, stateDays, date);
    for (const signal of signals) {
      const screen = SCREEN_MAP[signal.screenId];
      const series = scan.series.get(signal.symbol);
      if (!screen || !series) continue;
      const hold = HOLD_BARS[screen.group];
      const { bars } = series;
      if (signal.index + hold > bars.length - 1) continue;
      const plan = { entry: signal.entry, stop: signal.stop, target: signal.target };
      const result = simulatePlan(bars, signal.index, plan, hold, screen.exit);
      if (!result) continue;
      // simulatePlan reports R on the fill's own risk; recover the prices, then use the planned risk.
      const entry = isBuyStop(signal) ? Math.max(bars[signal.index + 1].o, signal.entry) : signal.entry;
      const exit = entry + result.r * (entry - signal.stop);
      const risk = signal.entry - signal.stop;
      out.push({
        screenId: signal.screenId,
        symbol: signal.symbol,
        date,
        score: signal.score,
        state,
        entry,
        exit,
        kind: result.kind,
        grossR: (exit - entry) / risk,
        netR: netRMultiple({ entry, exit, risk, qty: tradeQty(entry, lots[signal.symbol]), costs }),
      });
    }
  }
  return out.sort((a, b) => a.date - b.date || a.screenId.localeCompare(b.screenId) || a.symbol.localeCompare(b.symbol));
}

// ------------------------------------------------------------------ statistics

interface Part {
  n: number;
  mean: number | null;
}

/** First signal day of the last 40% of a bucket's signals (whole days stay together); null with < 2 days. */
export function splitDay(trades: Array<{ date: number }>, fraction = SPLIT_FRACTION): number | null {
  const days = [...new Set(trades.map((trade) => trade.date))].sort((a, b) => a - b);
  if (days.length < 2) return null;
  const sorted = trades.map((trade) => trade.date).sort((a, b) => a - b);
  const at = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction))];
  // Never put every trade in the first part.
  return at > days[0] ? at : days[1];
}

export interface ScoreCheck {
  /** Mean net R of the top, middle and bottom third of signals by the screen's score. */
  top: number;
  mid: number;
  bottom: number;
  /** Welch t of top vs bottom. */
  t: number;
  /** The score picks better trades: top beats bottom with t ≥ 2. */
  ranks: boolean;
}

export interface EvidenceBucket {
  /** Trades and distinct signal days. */
  n: number;
  days: number;
  mean: number | null;
  /** t-stat of the mean over days (each day's trades averaged first). */
  t: number | null;
  /** First 60% / last 40% of the bucket's signals in date order, split at `splitDate`. */
  first: Part;
  last: Part;
  splitDate: number | null;
  /** Signals in the last 12 months of the history. */
  recent: Part;
  /** Average cost of a round trip, in R. */
  costR: number | null;
  score: ScoreCheck | null;
  /** Mean > 0 in both parts and t > 2 (and at least MIN_TRADES). */
  eligible: boolean;
}

/** any = passes in both market states; uptrend / downtrend = only in that one; none = in neither; few = too few signals to judge. */
export type EvidenceVerdict = "any" | "uptrend" | "downtrend" | "none" | "few";

export interface ScreenEvidence {
  screenId: string;
  all: EvidenceBucket;
  up: EvidenceBucket;
  down: EvidenceBucket;
  verdict: EvidenceVerdict;
}

export interface EvidenceTable {
  /** Signal sessions covered (first to last) and where "last 12 months" starts. */
  from: number;
  to: number;
  sessions: number;
  recentFrom: number;
  /** Stocks replayed. */
  symbols: number;
  trades: number;
  screens: Record<string, ScreenEvidence>;
  /** NIFTY vs its 200-day average on the last stored session (the live state comes from the screener). */
  lastState: MarketState | null;
}

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

function variance(values: number[], m: number) {
  return values.length > 1 ? values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1) : NaN;
}

/** t-stat of a mean over days: each day's trades are averaged first, so a busy day counts once. */
export function tOverDays(trades: Array<{ date: number; netR: number }>): { t: number | null; days: number } {
  const byDay = new Map<number, number[]>();
  for (const trade of trades) byDay.set(trade.date, [...(byDay.get(trade.date) ?? []), trade.netR]);
  const daily = [...byDay.values()].map((values) => mean(values)!);
  const m = mean(daily);
  if (m === null || daily.length < 2) return { t: null, days: daily.length };
  const sd = Math.sqrt(variance(daily, m));
  return { t: sd > 0 ? m / (sd / Math.sqrt(daily.length)) : null, days: daily.length };
}

/** Top vs bottom third of trades by score (null with fewer than 3 × 10 trades). */
export function scoreCheck(trades: Array<{ score: number; netR: number }>): ScoreCheck | null {
  if (trades.length < 30) return null;
  const sorted = [...trades].sort((a, b) => a.score - b.score);
  const third = Math.floor(sorted.length / 3);
  const bottom = sorted.slice(0, third).map((trade) => trade.netR);
  const mid = sorted.slice(third, sorted.length - third).map((trade) => trade.netR);
  const top = sorted.slice(sorted.length - third).map((trade) => trade.netR);
  const mt = mean(top)!;
  const mb = mean(bottom)!;
  const se = Math.sqrt(variance(top, mt) / top.length + variance(bottom, mb) / bottom.length);
  const t = se > 0 ? (mt - mb) / se : 0;
  return { top: mt, mid: mean(mid)!, bottom: mb, t, ranks: mt > mb && t >= MIN_T };
}

export function bucketOf(trades: EvidenceTrade[], recentFrom: number): EvidenceBucket {
  const part = (list: EvidenceTrade[]): Part => ({ n: list.length, mean: mean(list.map((trade) => trade.netR)) });
  const splitDate = splitDay(trades);
  const first = part(splitDate === null ? trades : trades.filter((trade) => trade.date < splitDate));
  const last = part(splitDate === null ? [] : trades.filter((trade) => trade.date >= splitDate));
  const { t, days } = tOverDays(trades);
  const m = mean(trades.map((trade) => trade.netR));
  const eligible = trades.length >= MIN_TRADES && (first.mean ?? 0) > 0 && (last.mean ?? 0) > 0 && t !== null && t > MIN_T;
  return {
    n: trades.length,
    days,
    mean: m,
    t,
    first,
    last,
    splitDate,
    recent: part(trades.filter((trade) => trade.date >= recentFrom)),
    costR: mean(trades.map((trade) => trade.grossR - trade.netR)),
    score: scoreCheck(trades),
    eligible,
  };
}

export function verdictOf(up: EvidenceBucket, down: EvidenceBucket, all: EvidenceBucket): EvidenceVerdict {
  if (up.eligible && down.eligible) return "any";
  if (up.eligible) return "uptrend";
  if (down.eligible) return "downtrend";
  return all.n < MIN_TRADES ? "few" : "none";
}

/**
 * Per screen and market state. `dates` is the trading calendar the signals came
 * from (oldest first, from the first session a signal was possible); its last
 * 365 days are "recent".
 */
export function summarizeEvidence(trades: EvidenceTrade[], params: { dates: number[]; symbols: number; lastState: MarketState | null }): EvidenceTable {
  const { dates } = params;
  const from = dates[0] ?? 0;
  const to = dates.at(-1) ?? 0;
  const recentFrom = to - RECENT_DAYS * DAY_MS;
  const screens: Record<string, ScreenEvidence> = {};
  for (const screen of SCREENS) {
    const mine = trades.filter((trade) => trade.screenId === screen.id);
    const all = bucketOf(mine, recentFrom);
    const up = bucketOf(
      mine.filter((trade) => trade.state === "up"),
      recentFrom,
    );
    const down = bucketOf(
      mine.filter((trade) => trade.state === "down"),
      recentFrom,
    );
    screens[screen.id] = { screenId: screen.id, all, up, down, verdict: verdictOf(up, down, all) };
  }
  return { from, to, sessions: dates.length, recentFrom, symbols: params.symbols, trades: trades.length, screens, lastState: params.lastState };
}

/** Is a screen allowed into the plan in this market state? Unknown state: only screens that pass in both. */
export function eligibleIn(evidence: ScreenEvidence | undefined, state: MarketState | null): boolean {
  if (!evidence) return false;
  return state ? evidence[state].eligible : evidence.up.eligible && evidence.down.eligible;
}

/** The bucket that describes a screen in a state (the overall one when the state is unknown). */
export function bucketFor(evidence: ScreenEvidence, state: MarketState | null): EvidenceBucket {
  return state ? evidence[state] : evidence.all;
}

export const VERDICT_LABEL: Record<EvidenceVerdict, string> = {
  any: "Works in any market",
  uptrend: "Uptrends only",
  downtrend: "Downtrends only",
  none: "No edge in 5-year test",
  few: "Too few signals to judge",
};

export const signedR = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}R`;
