import { roundTripCosts, slipped, type CostModel } from "@/core/backtest/costs";
import type { DailyBar } from "@/core/types";
import type { EntryKind } from "./instructions";
import { trailSessions } from "./instructions";

// Paper trading inside a Time Machine replay (issue #32): a plan idea "paper
// taken" on a past day, filled and exited at the replayed prices with the
// plan's own rules — the rules the evidence tested (src/core/plan/evidence.ts,
// simulatePlan in src/core/screener/backtest.ts) — and graded as the replay
// moves on. Pure, and graded from scratch on every ask: grading as of day d
// reads only the bars up to d (`gradePaper` drops the rest first), so stepping
// back un-does an exit and nothing after the day shown can move a fill.
//
// Entry (on the day the idea was taken, its "signal day"):
//   close     bought at that session's close (the plan's 3:15–3:25 PM buy)
//   buy-stop  an order for the next session only: filled if that session
//             trades up to it, at the stop price or at the open when it opens
//             above it; otherwise it isn't a trade ("not filled")
//   btst      bought at that close, sold at the next session's open
// Exit (from the session after the signal day, first level reached wins; a
// session touching both the stop and the target counts as the stop):
//   stop      at the stop, or at the open when the session opens below it (a gap)
//   target    at the target, or at the open when it opens above it
//   trail     trail-low:N rules: a close below the lowest low of the N sessions
//             before it sells at that close
//   time      at the close of the holding period's last session
// On the session a buy-stop filled, the stop and target fill at their levels
// (the bar's open was before the fill). Charges and slippage come from
// src/core/backtest/costs.ts, on both legs, as in the evidence.

export type PaperStatus = "later" | "pending" | "unfilled" | "open" | "closed";
export type PaperExitReason = "stop" | "target" | "trail" | "time" | "open";

export interface PaperOrder {
  symbol: string;
  screenId: string;
  entryKind: EntryKind;
  /** The plan's entry (the signal close, or the buy-stop level). */
  plannedEntry: number;
  stop: number;
  target: number | null;
  /** "next-open", "stop-target", "time" or "trail-low:N" (src/core/plan/instructions.ts). */
  exitRule: string;
  holdSessions: number;
  /** The session the idea was taken on (day key). */
  signalDay: number;
  quantity: number;
}

export interface PaperGrade {
  status: PaperStatus;
  /** Fill before slippage; null until filled. */
  entryPrice: number | null;
  entryDay: number | null;
  exitPrice: number | null;
  exitDay: number | null;
  exitReason: PaperExitReason | null;
  /** The exit filled at a session's open beyond its level (a gap through the stop or target). */
  gap: boolean;
  /** Sessions after the signal day so far (to the exit, or to the day graded). */
  sessions: number;
  /** Last close of an open trade (mark to market). */
  mark: number | null;
  /** Price move ÷ planned risk (entry − stop), at the exit or the mark. */
  grossR: number | null;
  /** After slippage on both legs and the round trip's charges (closed trades only). */
  netR: number | null;
  /** ₹: closed — net of slippage and charges; open — the move at the mark, before costs. */
  pnl: number | null;
  /** Charges of the round trip, ₹ (closed trades). */
  charges: number | null;
  /** What happened, in a line. */
  text: string;
}

const fmt = (value: number) => value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Bars up to and including `day`, oldest first: what grading on `day` may read. */
export function barsUpTo(bars: readonly DailyBar[], day: number): DailyBar[] {
  return bars.filter((bar) => bar.t <= day).sort((a, b) => a.t - b.t);
}

/** Net R and ₹ of a round trip at these fill prices (before slippage), as the evidence counts it. */
export function paperCosts(order: Pick<PaperOrder, "plannedEntry" | "stop" | "quantity">, entry: number, exit: number, costs: CostModel) {
  const entryFill = slipped("buy", entry, costs);
  const exitFill = slipped("sell", exit, costs);
  const qty = order.quantity;
  const charges = roundTripCosts(entryFill, exitFill, qty, costs).total;
  const pnl = (exitFill - entryFill) * qty - charges;
  const risk = order.plannedEntry - order.stop;
  return { pnl, charges, netR: risk > 0 && qty > 0 ? pnl / (qty * risk) : 0 };
}

/**
 * Grade a paper trade as of `asOfDay`'s close from the symbol's daily bars
 * (any span: those after `asOfDay` are dropped before anything is read).
 */
export function gradePaper(order: PaperOrder, allBars: readonly DailyBar[], asOfDay: number, costs: CostModel): PaperGrade {
  const empty: PaperGrade = { status: "pending", entryPrice: null, entryDay: null, exitPrice: null, exitDay: null, exitReason: null, gap: false, sessions: 0, mark: null, grossR: null, netR: null, pnl: null, charges: null, text: "" };
  if (asOfDay < order.signalDay) return { ...empty, status: "later", text: "Taken on a later day than the one shown" };
  const bars = barsUpTo(allBars, asOfDay);
  const signalIndex = bars.findIndex((bar) => bar.t === order.signalDay);
  if (signalIndex < 0) return { ...empty, status: "unfilled", text: "No session for this stock on the day it was taken" };
  const risk = order.plannedEntry - order.stop;
  if (!(risk > 0)) return { ...empty, status: "unfilled", text: "The stop isn't below the entry" };
  const after = bars.length - 1 - signalIndex;
  const R = (entry: number, price: number) => (price - entry) / risk;
  const closed = (entry: number, entryDay: number, exitIndex: number, price: number, reason: PaperExitReason, gap: boolean): PaperGrade => {
    const { pnl, charges, netR } = paperCosts(order, entry, price, costs);
    const why =
      reason === "stop" ? (gap ? `Opened below the stop at ${fmt(price)}` : `Stopped at ${fmt(price)}`)
      : reason === "target" ? (gap ? `Opened above the target at ${fmt(price)}` : `Target ${fmt(price)} hit`)
      : reason === "trail" ? `Closed below the trailing low: out at ${fmt(price)}`
      : reason === "open" ? `Sold at the open, ${fmt(price)}`
      : `Time exit at the close, ${fmt(price)}`;
    return { ...empty, status: "closed", entryPrice: entry, entryDay, exitPrice: price, exitDay: bars[exitIndex].t, exitReason: reason, gap, sessions: exitIndex - signalIndex, grossR: R(entry, price), netR, pnl, charges, text: why };
  };
  const open = (entry: number, entryDay: number, text: string): PaperGrade => {
    const mark = bars.at(-1)!.c;
    return { ...empty, status: "open", entryPrice: entry, entryDay, sessions: after, mark, grossR: R(entry, mark), pnl: (mark - entry) * order.quantity, text };
  };
  const { stop, target } = order;
  const hold = Math.max(1, order.holdSessions);

  // BTST: bought at the signal close, sold at the open `hold` sessions later; a stop or target
  // in between counts only from a session's open through it (as the evidence's replay).
  if (order.entryKind === "btst" || order.exitRule === "next-open") {
    const entry = bars[signalIndex].c;
    for (let i = signalIndex + 1; i < signalIndex + hold && i < bars.length; i += 1) {
      const bar = bars[i];
      if (bar.l <= stop) return closed(entry, order.signalDay, i, Math.min(stop, bar.o), "stop", bar.o < stop);
      if (target !== null && bar.h >= target) return closed(entry, order.signalDay, i, Math.max(target, bar.o), "target", bar.o > target);
    }
    const exitIndex = signalIndex + hold;
    if (exitIndex >= bars.length) return open(entry, order.signalDay, "Holding overnight: sold at the next open");
    const price = bars[exitIndex].o;
    if (price <= stop) return closed(entry, order.signalDay, exitIndex, price, "stop", price < stop);
    if (target !== null && price >= target) return closed(entry, order.signalDay, exitIndex, price, "target", price > target);
    return closed(entry, order.signalDay, exitIndex, price, "open", false);
  }

  let entry = bars[signalIndex].c;
  let entryDay = order.signalDay;
  let fillIndex = -1;
  if (order.entryKind === "buy-stop") {
    const next = bars[signalIndex + 1];
    if (!next) return { ...empty, status: "pending", text: `Buy-stop at ${fmt(order.plannedEntry)} for the next session` };
    if (next.h < order.plannedEntry) return { ...empty, status: "unfilled", sessions: 1, text: `Not filled: the next session's high ${fmt(next.h)} stayed below the buy-stop` };
    entry = Math.max(next.o, order.plannedEntry);
    entryDay = next.t;
    fillIndex = signalIndex + 1;
  }

  const trail = trailSessions(order.exitRule);
  const last = signalIndex + hold;
  for (let i = signalIndex + 1; i <= last && i < bars.length; i += 1) {
    const bar = bars[i];
    const gaps = i !== fillIndex;
    if (bar.l <= stop) return closed(entry, entryDay, i, gaps ? Math.min(stop, bar.o) : stop, "stop", gaps && bar.o < stop);
    if (target !== null && bar.h >= target) return closed(entry, entryDay, i, gaps ? Math.max(target, bar.o) : target, "target", gaps && bar.o > target);
    if (trail && i - trail >= 0) {
      const level = Math.min(...bars.slice(i - trail, i).map((prior) => prior.l));
      if (bar.c < level) return closed(entry, entryDay, i, bar.c, "trail", false);
    }
    if (i === last) return closed(entry, entryDay, i, bar.c, "time", false);
  }
  return open(entry, entryDay, `Holding: session ${after} of ${hold}`);
}

// ------------------------------------------------------------------ the session's summary

export interface PaperTradeRow extends PaperOrder {
  id: string;
  /** The evidence's expected net R per trade for this setup when it was taken (null when unknown). */
  expectedR: number | null;
  grade: PaperGrade;
}

export interface PaperSummary {
  /** Trades taken on or before the day graded. */
  taken: number;
  closed: number;
  open: number;
  /** Buy-stops waiting for the next session. */
  pending: number;
  unfilled: number;
  wins: number;
  /** Wins ÷ closed trades (null with none closed). */
  hitRate: number | null;
  /** Sum and mean of closed trades' net R. */
  netR: number;
  avgNetR: number | null;
  /** Net ₹ P&L of closed trades (after slippage and charges), and the charges in it. */
  pnl: number;
  charges: number;
  /** Largest peak-to-trough fall of the closed trades' cumulative net ₹ P&L (in exit order), and in R. */
  maxDrawdown: number;
  maxDrawdownR: number;
  /** Open trades' move at their marks, ₹ (before costs). */
  openPnl: number;
  /** What the plan expected of the closed trades (sum of the evidence's net R per trade), to set beside `netR`. */
  expectedR: number | null;
  byReason: Partial<Record<PaperExitReason, number>>;
}

/** The closed trades in the order they closed (exit day, then entry, then symbol). */
export function closedInOrder<T extends { symbol: string; signalDay: number; grade: PaperGrade }>(trades: readonly T[]): T[] {
  return trades
    .filter((trade) => trade.grade.status === "closed")
    .sort((a, b) => a.grade.exitDay! - b.grade.exitDay! || a.signalDay - b.signalDay || a.symbol.localeCompare(b.symbol));
}

export function summarizePaper(trades: readonly PaperTradeRow[]): PaperSummary {
  const current = trades.filter((trade) => trade.grade.status !== "later");
  const closed = closedInOrder(current);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let equityR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  for (const trade of closed) {
    equity += trade.grade.pnl!;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    equityR += trade.grade.netR!;
    peakR = Math.max(peakR, equityR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - equityR);
  }
  const wins = closed.filter((trade) => trade.grade.netR! > 0).length;
  const netR = closed.reduce((sum, trade) => sum + trade.grade.netR!, 0);
  const expected = closed.map((trade) => trade.expectedR);
  const byReason: PaperSummary["byReason"] = {};
  for (const trade of closed) byReason[trade.grade.exitReason!] = (byReason[trade.grade.exitReason!] ?? 0) + 1;
  return {
    taken: current.length,
    closed: closed.length,
    open: current.filter((trade) => trade.grade.status === "open").length,
    pending: current.filter((trade) => trade.grade.status === "pending").length,
    unfilled: current.filter((trade) => trade.grade.status === "unfilled").length,
    wins,
    hitRate: closed.length ? wins / closed.length : null,
    netR,
    avgNetR: closed.length ? netR / closed.length : null,
    pnl: closed.reduce((sum, trade) => sum + trade.grade.pnl!, 0),
    charges: closed.reduce((sum, trade) => sum + trade.grade.charges!, 0),
    maxDrawdown,
    maxDrawdownR,
    openPnl: current.filter((trade) => trade.grade.status === "open").reduce((sum, trade) => sum + (trade.grade.pnl ?? 0), 0),
    expectedR: closed.length && expected.every((value) => value !== null) ? expected.reduce((sum, value) => sum! + value!, 0) : null,
    byReason,
  };
}

// ------------------------------------------------------------------ export

const isoDay = (day: number | null) => (day === null ? "" : new Date(day).toISOString().slice(0, 10));
const num = (value: number | null, digits = 2) => (value === null || !Number.isFinite(value) ? "" : value.toFixed(digits));
const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export const PAPER_CSV_COLUMNS = [
  "symbol", "setup", "taken", "entry_kind", "planned_entry", "stop", "target", "exit_rule", "hold_sessions", "quantity",
  "status", "entry_day", "entry_price", "exit_day", "exit_price", "exit_reason", "gap", "gross_r", "net_r", "pnl_inr", "charges_inr", "expected_r",
] as const;

/** The session's trades as CSV (one row per trade, graded as of the day shown), for a spreadsheet. */
export function paperCsv(trades: readonly PaperTradeRow[]): string {
  const rows = [...trades]
    .sort((a, b) => a.signalDay - b.signalDay || a.symbol.localeCompare(b.symbol))
    .map((trade) => {
      const g = trade.grade;
      return [
        trade.symbol, trade.screenId, isoDay(trade.signalDay), trade.entryKind, num(trade.plannedEntry), num(trade.stop), num(trade.target), trade.exitRule, String(trade.holdSessions), String(trade.quantity),
        g.status, isoDay(g.entryDay), num(g.entryPrice), isoDay(g.exitDay), num(g.exitPrice), g.exitReason ?? "", g.gap ? "yes" : "", num(g.grossR, 3), num(g.netR, 3), num(g.pnl), num(g.charges), num(trade.expectedR, 3),
      ].map(cell).join(",");
    });
  return [PAPER_CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
}
