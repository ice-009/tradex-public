import { istParts, isWeekday, SESSION_CLOSE_MIN, SESSION_OPEN_MIN } from "@/core/market/session";
import type { DailyBar } from "@/core/types";
import { trailSessions, type EntryKind } from "./instructions";

// The trade coach (issue #42): what your own journal says about how you trade.
//
//   Per trade   MAE / MFE (how far it went against and for you, in R of the
//               planned risk), how much of the best price you kept, the
//               sessions you held against the plan's own exit, and your exit
//               against the exit the plan would have taken.
//   Rule breaks an entry outside the plan's window (or below its buy-stop), a
//               stop moved after entry, more lots than the plan sized, and
//               holding past the plan's exit. Each rule says how many trades
//               it could check and why the others couldn't be.
//   Findings    plain sentences ("you exit winners 0.4R short of the plan's
//               exit"), each with its sample and a 95% t interval; none is
//               stated below MIN_SAMPLE trades.
//
// Resolution. With intraday candles (the hub keeps a year of them) MAE / MFE
// are exact except inside the entry and exit candles. With daily bars they are
// bounds: `low` uses only what surely happened during the trade (the sessions
// strictly between entry and exit, plus the two fills), `high` also counts the
// whole entry and exit days, part of which was before the entry or after the
// exit. Every trade says which it used.
//
// Prices. Bars are the stock's, re-expressed as traded on the entry day (the
// caller applies the split/bonus scale). Your fills may be a future's price
// (a small basis over the stock): for the path, each fill is clamped into the
// stock's range in its own candle or day, so the basis doesn't count as an
// excursion. Your R and the plan's exit compare your fills with the stock's
// prices, as the journal's slippage does.
//
// No look-ahead: a report as of `now` sees only trades entered by then, counts
// a trade closed only when it was closed by then, and reads no bar or candle
// that hadn't finished by then. Pure.

/** The plan's buy window for close and BTST entries, IST minutes (src/core/plan/instructions.ts entryText: 3:15–3:25 PM). */
export const ENTRY_WINDOW = { from: 15 * 60 + 15, to: 15 * 60 + 25 } as const;
/** Fewest trades behind a finding; below it the coach says "too few trades". */
export const MIN_SAMPLE = 8;
/** Fewest trades on each side of a comparison (rule breaks vs clean trades). */
export const MIN_GROUP = 5;
/** A buy-stop fill this far below its level means it was bought before it triggered (0.1%: a few ticks). */
export const BUY_STOP_TOLERANCE = 0.001;
/** Exit efficiency is only shown when the best open profit was at least this many R (a share of nearly nothing is noise). */
export const MIN_MFE_FOR_EFFICIENCY = 0.5;
/** A fill this far outside the stock's range that day means the stored prices don't match it (a split since, another instrument). */
const PRICE_MISMATCH = 0.1;
const MINUTE_MS = 60_000;

export interface TradeChange {
  field: "stop" | "lots";
  from: number;
  to: number;
  /** Epoch ms. */
  at: number;
}

/** A journal trade as the coach reads it (Prisma `Trade` plus its `TradeChange` audit). */
export interface CoachTrade {
  id: string;
  symbol: string;
  screenId: string;
  status: "open" | "closed";
  plannedEntry: number;
  /** The current stop (it may have been moved: see `changes`). */
  stop: number;
  target: number | null;
  exitRule: string;
  holdSessions: number;
  /** How the plan said to buy; null for trades recorded before it was stored. */
  entryKind: EntryKind | null;
  entryPrice: number;
  /** Epoch ms. */
  entryAt: number;
  /** True: the time of day was given; false: only the date; null: recorded before this was asked. */
  entryTimed: boolean | null;
  lots: number;
  /** Lots the plan sized when you took it (0 = it sized none); null when not stored. */
  planLots: number | null;
  exitPrice: number | null;
  exitAt: number | null;
  /** Stop and lot changes are kept for this trade since it was recorded. */
  audited: boolean;
  changes: TradeChange[];
}

/** An intraday candle: `t` is its start, epoch ms. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** The stock's prices for one trade, on the entry day's price scale. */
export interface TradeBars {
  daily: DailyBar[];
  intraday: { minutes: number; candles: Candle[] } | null;
  /** Why there are no intraday candles (shown with a daily-bar trade). */
  intradayWhy: string | null;
  /** A split or bonus between entry and exit: no single price scale for the trade. */
  splitDuring?: boolean;
}

export interface Bounds {
  low: number;
  high: number;
}

export interface Excursion {
  resolution: "intraday" | "daily";
  /** Candle length for intraday. */
  minutes: number | null;
  /** How far it went against you, R (≥ 0). */
  mae: Bounds;
  /** How far it went for you, R (≥ 0). */
  mfe: Bounds;
  /** Your exit's move on the same path, R. */
  captured: number;
  /** captured ÷ MFE (1 = sold at the best price), when the MFE was at least MIN_MFE_FOR_EFFICIENCY. */
  efficiency: Bounds | null;
  note: string;
}

export type PlanExitReason = "stop" | "target" | "trail" | "time" | "open";

export interface PlanExit {
  /** Sessions after the entry session (BTST: 1, the next open). */
  session: number;
  day: number;
  price: number;
  /** (plan's exit − your entry) ÷ risk. */
  r: number;
  reason: PlanExitReason;
}

export type RuleId = "entry" | "stop-moved" | "oversized" | "held-past-exit";

export interface RuleBreak {
  rule: RuleId;
  text: string;
}

export interface TradeReview {
  id: string;
  symbol: string;
  screenId: string;
  status: "open" | "closed";
  entryDay: number;
  exitDay: number | null;
  /** Planned risk per share: planned entry − the stop when you took it. */
  risk: number;
  /** Your result, R before charges (closed only). */
  r: number | null;
  excursion: Excursion | null;
  excursionWhy: string | null;
  /** Sessions after the entry session to your exit. */
  held: number | null;
  holdSessions: number;
  planExit: PlanExit | null;
  planExitWhy: string | null;
  /** Your R − the plan's exit R (negative = the plan's exit would have done better). */
  vsPlanR: number | null;
  breaks: RuleBreak[];
  /** Rules that couldn't be checked on this trade (a trade is "clean" only when every rule was checked). */
  unchecked: RuleId[];
}

export interface RuleCheck {
  rule: RuleId;
  label: string;
  checked: number;
  broken: number;
  unchecked: number;
  /** Why the unchecked trades couldn't be checked (distinct reasons with counts). */
  why: Array<{ reason: string; trades: number }>;
}

export type FindingId = "winners-vs-plan" | "losers-vs-plan" | "give-back" | "rule-breaks";

export interface Finding {
  id: FindingId;
  label: string;
  /** Trades behind it, and the fewest needed. */
  n: number;
  needed: number;
  /** The effect, R; null when too few trades. */
  mean: number | null;
  /** 95% t interval for the mean, R. */
  ci: [number, number] | null;
  /** The interval excludes zero. */
  clear: boolean;
  text: string;
}

export interface CoachReport {
  asOf: number;
  closed: number;
  open: number;
  reviews: TradeReview[];
  rules: RuleCheck[];
  findings: Finding[];
  /** Closed trades by how MAE / MFE were measured. */
  resolution: { intraday: number; daily: number; none: number };
  /** Closed trades whose plan exit hasn't come yet in the stored bars (left out of the "vs plan" findings). */
  planPending: number;
  minSample: number;
}

// ------------------------------------------------------------------ statistics

/** Two-sided 97.5% quantiles of Student's t for 1–30 degrees of freedom. */
const T_975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];

/** t quantile for a 95% interval; fractional df (Welch) round down, which widens the interval. Above 30 a Cornish–Fisher expansion. */
export function tCritical95(df: number): number {
  if (!(df >= 1)) return Number.POSITIVE_INFINITY;
  const whole = Math.floor(df);
  if (whole <= 30) return T_975[whole - 1];
  const z = 1.959964;
  return z + (z ** 3 + z) / (4 * whole) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * whole ** 2);
}

export interface MeanInterval {
  n: number;
  mean: number;
  /** 95% t interval; null with fewer than 2 values. */
  ci: [number, number] | null;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const variance = (values: readonly number[], mean: number) => sum(values.map((value) => (value - mean) ** 2)) / (values.length - 1);

/** Mean with a 95% t interval. */
export function meanInterval(values: readonly number[]): MeanInterval | null {
  if (!values.length) return null;
  const mean = sum(values) / values.length;
  if (values.length < 2) return { n: 1, mean, ci: null };
  const half = tCritical95(values.length - 1) * Math.sqrt(variance(values, mean) / values.length);
  return { n: values.length, mean, ci: [mean - half, mean + half] };
}

/** Difference of means a − b with a Welch 95% interval. */
export function differenceInterval(a: readonly number[], b: readonly number[]): MeanInterval | null {
  if (a.length < 2 || b.length < 2) return null;
  const ma = sum(a) / a.length;
  const mb = sum(b) / b.length;
  const va = variance(a, ma) / a.length;
  const vb = variance(b, mb) / b.length;
  const se = Math.sqrt(va + vb);
  const diff = ma - mb;
  if (se === 0) return { n: a.length + b.length, mean: diff, ci: [diff, diff] };
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  const half = tCritical95(df) * se;
  return { n: a.length + b.length, mean: diff, ci: [diff - half, diff + half] };
}

// ------------------------------------------------------------------ one trade

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const price = (value: number) => value.toFixed(2);
const r2 = (value: number) => `${Math.abs(value).toFixed(2)}R`;
const clock = (time: number) => {
  const { minutes } = istParts(time);
  const hour = Math.floor(minutes / 60);
  return `${((hour + 11) % 12) + 1}:${String(minutes % 60).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
};
const dayText = (day: number) => new Date(day).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/** The stop when the trade was taken: the first recorded change's old value, else the stop as it is. */
export function stopAtEntry(trade: Pick<CoachTrade, "stop" | "changes">): number {
  const first = trade.changes.filter((change) => change.field === "stop").sort((a, b) => a.at - b.at)[0];
  return first ? first.from : trade.stop;
}

/** How the plan said to buy: as stored, else BTST from its exit rule, else unknown. */
export function entryKindOf(trade: Pick<CoachTrade, "entryKind" | "exitRule">): EntryKind | null {
  return trade.entryKind ?? (trade.exitRule === "next-open" ? "btst" : null);
}

type Check = { checked: false; why: string } | { checked: true; broken: RuleBreak | null };

const WINDOW_TEXT = "3:15–3:25 PM";

/** Entry: close and BTST entries inside the buy window on a weekday; buy-stops at or above their level, in the session. */
export function checkEntry(trade: CoachTrade): Check {
  const kind = entryKindOf(trade);
  if (!kind) return { checked: false, why: "how the plan said to buy (close or buy-stop) wasn't stored for trades recorded before the coach" };
  const { minutes, day } = istParts(trade.entryAt);
  if (kind === "buy-stop") {
    if (trade.entryPrice < trade.plannedEntry * (1 - BUY_STOP_TOLERANCE)) {
      return { checked: true, broken: { rule: "entry", text: `Filled at ${price(trade.entryPrice)}, below the buy-stop ${price(trade.plannedEntry)}: bought before it triggered` } };
    }
    if (trade.entryTimed === true && (!isWeekday(day) || minutes < SESSION_OPEN_MIN || minutes > SESSION_CLOSE_MIN)) {
      return { checked: true, broken: { rule: "entry", text: `Bought at ${clock(trade.entryAt)} on ${dayText(day)}, outside the session` } };
    }
    return { checked: true, broken: null };
  }
  if (trade.entryTimed !== true) return { checked: false, why: trade.entryTimed === false ? "only the date of the entry was given, not the time" : "the entry time wasn't asked for before the coach" };
  if (!isWeekday(day)) return { checked: true, broken: { rule: "entry", text: `Bought on a ${new Date(day).toLocaleDateString("en-IN", { weekday: "long", timeZone: "UTC" })}: no session` } };
  if (minutes < ENTRY_WINDOW.from || minutes > ENTRY_WINDOW.to) {
    return { checked: true, broken: { rule: "entry", text: `Bought at ${clock(trade.entryAt)}; the plan buys ${WINDOW_TEXT} (the screens were tested on closing prices)` } };
  }
  return { checked: true, broken: null };
}

/** Stop moved after entry (from the audit kept since the trade was recorded). */
export function checkStop(trade: CoachTrade): Check {
  if (!trade.audited) return { checked: false, why: "recorded before stop and lot changes were kept" };
  const moves = trade.changes.filter((change) => change.field === "stop" && change.to !== change.from).sort((a, b) => a.at - b.at);
  if (!moves.length) return { checked: true, broken: null };
  const steps = moves.map((move) => `${price(move.from)} → ${price(move.to)} (${move.to < move.from ? "wider" : "tighter"}, ${dayText(istParts(move.at).day)})`);
  return { checked: true, broken: { rule: "stop-moved", text: `Stop moved ${moves.length === 1 ? "once" : `${moves.length} times`}: ${steps.join(", ")}` } };
}

/** More lots than the plan sized (the largest size the trade had, from the audit). */
export function checkSize(trade: CoachTrade): Check {
  if (trade.planLots === null) return { checked: false, why: "the plan's size wasn't stored for trades recorded before the coach" };
  const most = Math.max(trade.lots, ...trade.changes.filter((change) => change.field === "lots").flatMap((change) => [change.from, change.to]));
  if (most <= trade.planLots) return { checked: true, broken: null };
  const text = trade.planLots === 0 ? `Took ${most} lot${most === 1 ? "" : "s"}; the plan sized none (one lot risked more than your budget, or no room under the leverage cap)` : `Took ${most} lots; the plan sized ${trade.planLots}`;
  return { checked: true, broken: { rule: "oversized", text } };
}

/**
 * The plan's own exit from your entry, on daily bars after the entry session
 * (as the tracker tells you each day): the stop as it was when you took the
 * trade (a gap through it fills at the open), the target, a close below the
 * trailing low, the close of the last session of the hold, or the next open
 * (BTST). A bar touching both the stop and the target counts as the stop.
 * Null when the stored bars don't reach it yet.
 */
export function planExit(trade: CoachTrade, daily: readonly DailyBar[], entryDay: number, risk: number): PlanExit | null {
  const stop = stopAtEntry(trade);
  const after = daily.filter((bar) => bar.t > entryDay);
  const exit = (session: number, bar: DailyBar, value: number, reason: PlanExitReason): PlanExit => ({ session, day: bar.t, price: value, r: (value - trade.entryPrice) / risk, reason });
  if (trade.exitRule === "next-open") return after[0] ? exit(1, after[0], after[0].o, "open") : null;
  const trail = trailSessions(trade.exitRule);
  for (let i = 0; i < after.length; i += 1) {
    const bar = after[i];
    if (bar.l <= stop) return exit(i + 1, bar, Math.min(stop, bar.o), "stop");
    if (trade.target !== null && bar.h >= trade.target) return exit(i + 1, bar, Math.max(trade.target, bar.o), "target");
    if (trail) {
      const before = daily.filter((entry) => entry.t < bar.t).slice(-trail);
      if (before.length === trail && bar.c < Math.min(...before.map((entry) => entry.l))) return exit(i + 1, bar, bar.c, "trail");
    }
    if (i + 1 >= trade.holdSessions) return exit(i + 1, bar, bar.c, "time");
  }
  return null;
}

const PLAN_STILL_HOLDING = "the plan would still be holding on the last stored bar";

const PLAN_EXIT_LABEL: Record<PlanExitReason, string> = { stop: "stop", target: "target", trail: "trailing exit", time: "time exit", open: "next-open exit" };

/** Held into a later session than the plan's exit. */
export function checkHold(held: number | null, exit: PlanExit | null, closed: boolean): Check {
  if (!closed) return { checked: false, why: "still open" };
  if (held === null) return { checked: false, why: "the stored daily bars don't reach the exit" };
  if (!exit) return { checked: true, broken: null }; // the plan would still hold: you were out first
  if (held <= exit.session) return { checked: true, broken: null };
  return { checked: true, broken: { rule: "held-past-exit", text: `Sold in session ${held}; the plan's ${PLAN_EXIT_LABEL[exit.reason]} came in session ${exit.session} (${dayText(exit.day)})` } };
}

/** MAE / MFE on intraday candles when they cover every session of the trade, else bounds from daily bars. */
export function measureExcursion(trade: CoachTrade, bars: TradeBars, risk: number, now: number): { excursion: Excursion | null; why: string | null } {
  if (trade.exitAt === null || trade.exitPrice === null) return { excursion: null, why: "still open" };
  if (bars.splitDuring) return { excursion: null, why: "a split or bonus during the trade: no one price scale to measure it on" };
  const entryDay = istParts(trade.entryAt).day;
  const exitDay = istParts(trade.exitAt).day;
  const sessions = bars.daily.filter((bar) => bar.t >= entryDay && bar.t <= exitDay);
  const entryBar = sessions.find((bar) => bar.t === entryDay);
  if (!entryBar) return { excursion: null, why: "no stored daily bar for the entry day" };
  if (!sessions.some((bar) => bar.t === exitDay)) return { excursion: null, why: "the stored daily bars don't reach the exit day" };
  if (trade.entryPrice > entryBar.h * (1 + PRICE_MISMATCH) || trade.entryPrice < entryBar.l * (1 - PRICE_MISMATCH)) {
    return { excursion: null, why: `your fill ${price(trade.entryPrice)} is far outside the stock's range that day (${price(entryBar.l)}–${price(entryBar.h)}): a split or bonus the factors don't cover, or a wrong price` };
  }

  type Range = { l: number; h: number };
  let inner: Range[];
  let entryRange: Range | null;
  let exitRange: Range | null;
  let resolution: Excursion["resolution"] = "daily";
  let minutes: number | null = null;
  const intraday = bars.intraday;
  const usable = (() => {
    if (!intraday?.candles.length) return null;
    const span = intraday.minutes * MINUTE_MS;
    const done = intraday.candles.filter((candle) => candle.t + span <= now);
    const days = new Set(done.map((candle) => istParts(candle.t).day));
    return sessions.every((bar) => days.has(bar.t)) ? { span, done } : null;
  })();
  if (intraday && usable) {
    const { span, done } = usable;
    const inTrade = done.filter((candle) => candle.t + span > trade.entryAt && candle.t <= trade.exitAt!);
    const holds = (time: number) => (candle: Candle) => candle.t <= time && time < candle.t + span;
    entryRange = inTrade.find(holds(trade.entryAt)) ?? null;
    exitRange = inTrade.find(holds(trade.exitAt)) ?? null;
    inner = inTrade.filter((candle) => candle.t >= trade.entryAt && candle.t + span <= trade.exitAt!);
    resolution = "intraday";
    minutes = intraday.minutes;
  } else {
    inner = sessions.filter((bar) => bar.t > entryDay && bar.t < exitDay);
    entryRange = entryBar;
    exitRange = sessions.find((bar) => bar.t === exitDay) ?? null;
  }

  // Fills on the stock's path: clamped into their own candle or day (a future's basis isn't an excursion).
  const entryRef = entryRange ? clamp(trade.entryPrice, entryRange.l, entryRange.h) : trade.entryPrice;
  const exitRef = exitRange ? clamp(trade.exitPrice, exitRange.l, exitRange.h) : trade.exitPrice;
  const lowIn = Math.min(entryRef, exitRef, ...inner.map((bar) => bar.l));
  const highIn = Math.max(entryRef, exitRef, ...inner.map((bar) => bar.h));
  const edges = [entryRange, exitRange].filter((range): range is Range => range !== null);
  const lowOut = Math.min(lowIn, ...edges.map((bar) => bar.l));
  const highOut = Math.max(highIn, ...edges.map((bar) => bar.h));
  const mae = { low: Math.max(0, (entryRef - lowIn) / risk), high: Math.max(0, (entryRef - lowOut) / risk) };
  const mfe = { low: Math.max(0, (highIn - entryRef) / risk), high: Math.max(0, (highOut - entryRef) / risk) };
  const captured = (exitRef - entryRef) / risk;
  let efficiency: Bounds | null = null;
  if (mfe.low >= MIN_MFE_FOR_EFFICIENCY) {
    const a = captured / mfe.low;
    const b = captured / mfe.high;
    efficiency = { low: Math.min(a, b), high: Math.max(a, b) };
  }
  const note =
    resolution === "intraday"
      ? `${minutes}-minute candles: exact except inside the entry and exit candles`
      : `Daily bars${bars.intradayWhy ? ` (${bars.intradayWhy})` : ""}: the first figure counts only the sessions between entry and exit and the two fills; the second also counts the whole entry and exit days`;
  return { excursion: { resolution, minutes, mae, mfe, captured, efficiency, note }, why: null };
}

/** Everything the coach says about one trade, as of `now`. */
export function reviewTrade(trade: CoachTrade, bars: TradeBars | null, now: number): TradeReview {
  const closed = trade.status === "closed" && trade.exitAt !== null && trade.exitPrice !== null && trade.exitAt <= now;
  const today = istParts(now).day;
  const daily = (bars?.daily ?? []).filter((bar) => bar.t < today || (bar.t === today && istParts(now).minutes > SESSION_CLOSE_MIN));
  const scoped: TradeBars = { daily, intraday: bars?.intraday ?? null, intradayWhy: bars?.intradayWhy ?? null, splitDuring: bars?.splitDuring };
  const entryDay = istParts(trade.entryAt).day;
  const exitDay = closed ? istParts(trade.exitAt!).day : null;
  const risk = trade.plannedEntry - stopAtEntry(trade);
  const r = closed && risk > 0 ? (trade.exitPrice! - trade.entryPrice) / risk : null;

  const measured = closed && risk > 0 ? measureExcursion(trade, scoped, risk, now) : { excursion: null, why: closed ? "no planned risk (the stop isn't below the entry)" : "still open" };
  const held = closed && daily.some((bar) => bar.t >= exitDay!) ? daily.filter((bar) => bar.t > entryDay && bar.t <= exitDay!).length : null;
  const exit = closed && risk > 0 && daily.length ? planExit(trade, daily, entryDay, risk) : null;
  const planExitWhy = !closed ? "still open" : !daily.length ? "no stored daily bars" : exit ? null : PLAN_STILL_HOLDING;
  const checks: Array<[RuleId, Check]> = [
    ["entry", checkEntry(trade)],
    ["stop-moved", checkStop(trade)],
    ["oversized", checkSize(trade)],
    ["held-past-exit", checkHold(held, exit, closed)],
  ];
  return {
    id: trade.id,
    symbol: trade.symbol,
    screenId: trade.screenId,
    status: closed ? "closed" : "open",
    entryDay,
    exitDay,
    risk,
    r,
    excursion: measured.excursion,
    excursionWhy: measured.why,
    held,
    holdSessions: trade.holdSessions,
    planExit: exit,
    planExitWhy,
    vsPlanR: r !== null && exit ? r - exit.r : null,
    breaks: checks.flatMap(([, check]) => (check.checked && check.broken ? [check.broken] : [])),
    unchecked: checks.flatMap(([rule, check]) => (check.checked ? [] : [rule])),
  };
}

// ------------------------------------------------------------------ the report

const RULE_LABELS: Record<RuleId, string> = {
  entry: `Entry outside the plan (${WINDOW_TEXT}, or below a buy-stop)`,
  "stop-moved": "Stop moved after entry",
  oversized: "More lots than the plan sized",
  "held-past-exit": "Held past the plan's exit",
};

const FINDING_LABELS: Record<FindingId, string> = {
  "winners-vs-plan": "Winners: your exit vs the plan's",
  "losers-vs-plan": "Losers: your exit vs the plan's",
  "give-back": "Profit given back before the exit",
  "rule-breaks": "Rule breaks vs clean trades",
};

const intervalText = (ci: [number, number] | null) => (ci ? `95% interval ${ci[0] >= 0 ? "+" : "−"}${r2(ci[0])} to ${ci[1] >= 0 ? "+" : "−"}${r2(ci[1])}` : "");
const chance = (clear: boolean) => (clear ? "" : "; the interval includes zero, so this could be chance");

function finding(id: FindingId, values: readonly number[], needed: number, sentence: (mean: number) => string, unit = "trades"): Finding {
  const label = FINDING_LABELS[id];
  if (values.length < needed) return { id, label, n: values.length, needed, mean: null, ci: null, clear: false, text: `Too few trades: ${values.length} of the ${needed} ${unit} needed.` };
  const stat = meanInterval(values)!;
  const clear = stat.ci !== null && (stat.ci[0] > 0 || stat.ci[1] < 0);
  return { id, label, n: stat.n, needed, mean: stat.mean, ci: stat.ci, clear, text: `${sentence(stat.mean)} (${stat.n} ${unit}, ${intervalText(stat.ci)}${chance(clear)}).` };
}

/** The coach's report on a journal as of `now`. `bars` per trade id (missing: none stored). */
export function coachReport(trades: readonly CoachTrade[], bars: Readonly<Record<string, TradeBars>>, now: number): CoachReport {
  const known = trades.filter((trade) => trade.entryAt <= now);
  const reviews = known.map((trade) => reviewTrade(trade, bars[trade.id] ?? null, now)).sort((a, b) => (b.exitDay ?? Infinity) - (a.exitDay ?? Infinity) || b.entryDay - a.entryDay);
  const closed = reviews.filter((review) => review.status === "closed");

  // Rule checks over every trade they apply to.
  const tally = new Map<RuleId, RuleCheck>();
  for (const rule of Object.keys(RULE_LABELS) as RuleId[]) tally.set(rule, { rule, label: RULE_LABELS[rule], checked: 0, broken: 0, unchecked: 0, why: [] });
  known.forEach((trade) => {
    const review = reviews.find((entry) => entry.id === trade.id)!;
    const isClosed = review.status === "closed";
    const checks: Array<[RuleId, Check]> = [
      ["entry", checkEntry(trade)],
      ["stop-moved", checkStop(trade)],
      ["oversized", checkSize(trade)],
    ];
    if (isClosed) checks.push(["held-past-exit", checkHold(review.held, review.planExit, true)]);
    for (const [rule, check] of checks) {
      const entry = tally.get(rule)!;
      if (check.checked) {
        entry.checked += 1;
        if (check.broken) entry.broken += 1;
      } else {
        entry.unchecked += 1;
        const reason = entry.why.find((item) => item.reason === check.why);
        if (reason) reason.trades += 1;
        else entry.why.push({ reason: check.why, trades: 1 });
      }
    }
  });

  // Findings.
  const vsPlan = closed.filter((review) => review.r !== null && review.vsPlanR !== null);
  const winners = vsPlan.filter((review) => review.r! > 0).map((review) => review.vsPlanR!);
  const losers = vsPlan.filter((review) => review.r! <= 0).map((review) => review.vsPlanR!);
  const giveBack = closed.flatMap((review) => (review.excursion ? [review.excursion.mfe.low - review.excursion.captured] : []));
  const rated = closed.filter((review) => review.r !== null);
  const broke = rated.filter((review) => review.breaks.length).map((review) => review.r!);
  const clean = rated.filter((review) => !review.breaks.length && !review.unchecked.length).map((review) => review.r!);

  const findings: Finding[] = [
    finding("winners-vs-plan", winners, MIN_SAMPLE, (mean) => (mean < 0 ? `You exit winners ${r2(mean)} short of the plan's own exit on average` : `Your winners made ${r2(mean)} more than the plan's own exit would have, on average`), "winners"),
    finding("losers-vs-plan", losers, MIN_SAMPLE, (mean) => (mean < 0 ? `On losing trades you lose ${r2(mean)} more than the plan's exit would have, on average` : `On losing trades you lose ${r2(mean)} less than the plan's exit would have (you cut them sooner), on average`), "losers"),
    finding("give-back", giveBack, MIN_SAMPLE, (mean) => `You give back at least ${r2(mean)} from the best price of the trade before you exit, on average`),
    breakFinding(broke, clean),
  ];

  return {
    asOf: now,
    closed: closed.length,
    open: reviews.length - closed.length,
    reviews,
    rules: [...tally.values()],
    findings,
    resolution: {
      intraday: closed.filter((review) => review.excursion?.resolution === "intraday").length,
      daily: closed.filter((review) => review.excursion?.resolution === "daily").length,
      none: closed.filter((review) => !review.excursion).length,
    },
    planPending: closed.filter((review) => review.planExitWhy === PLAN_STILL_HOLDING).length,
    minSample: MIN_SAMPLE,
  };
}

function breakFinding(broke: number[], clean: number[]): Finding {
  const id: FindingId = "rule-breaks";
  const label = FINDING_LABELS[id];
  const n = broke.length + clean.length;
  if (broke.length < MIN_GROUP || clean.length < MIN_GROUP || n < MIN_SAMPLE) {
    return { id, label, n, needed: Math.max(MIN_SAMPLE, 2 * MIN_GROUP), mean: null, ci: null, clear: false, text: `Too few trades: ${broke.length} with a rule break and ${clean.length} checked on every rule without one (${MIN_GROUP} of each needed).` };
  }
  const stat = differenceInterval(broke, clean)!;
  const clear = stat.ci !== null && (stat.ci[0] > 0 || stat.ci[1] < 0);
  const mean = (values: number[]) => sum(values) / values.length;
  const signed = (value: number) => `${value >= 0 ? "+" : "−"}${r2(value)}`;
  return {
    id,
    label,
    n,
    needed: Math.max(MIN_SAMPLE, 2 * MIN_GROUP),
    mean: stat.mean,
    ci: stat.ci,
    clear,
    text: `Trades where you broke a rule made ${r2(stat.mean)} ${stat.mean < 0 ? "less" : "more"} per trade than those checked on every rule without one (${signed(mean(broke))} on ${broke.length} vs ${signed(mean(clean))} on ${clean.length}, ${intervalText(stat.ci)}${chance(clear)}).`,
  };
}
