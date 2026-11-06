import type { CostModel } from "@/core/backtest/costs";
import { netRMultiple } from "./evidence";

// The trade journal's summary: what the trades you actually took made, in R,
// and how far your fills were from the plan. Slippage is the honest check on
// the evidence: the 5-year replay assumes a fill at the signal close (or the
// buy-stop) and exits at the planned levels; if real fills are consistently
// worse, the expected R per trade is lower by about that much. Pure.

export type ExitReason = "target" | "stop" | "time" | "open" | "trail" | "manual";

export const EXIT_REASONS: Array<{ id: ExitReason; label: string }> = [
  { id: "open", label: "Next open (BTST)" },
  { id: "stop", label: "Stop" },
  { id: "target", label: "Target" },
  { id: "trail", label: "Trailing exit" },
  { id: "time", label: "Time exit" },
  { id: "manual", label: "My call" },
];

export interface ClosedTrade {
  screenId: string;
  plannedEntry: number;
  stop: number;
  entryPrice: number;
  exitPrice: number;
  /** What the plan said the exit price would be (the stop, the target, that session's open or close); null when it had no level. */
  plannedExit: number | null;
  quantity: number;
}

/** Gross R: the price move ÷ the planned risk per share. */
export function realisedR(trade: Pick<ClosedTrade, "plannedEntry" | "stop" | "entryPrice" | "exitPrice">): number {
  const risk = trade.plannedEntry - trade.stop;
  return risk > 0 ? (trade.exitPrice - trade.entryPrice) / risk : 0;
}

/**
 * Slippage in R against the plan (positive = worse for you): paying more than
 * the planned entry, or getting less than the planned exit.
 */
export function slippageR(trade: ClosedTrade): { entry: number; exit: number | null } {
  const risk = trade.plannedEntry - trade.stop;
  if (!(risk > 0)) return { entry: 0, exit: null };
  return {
    entry: (trade.entryPrice - trade.plannedEntry) / risk,
    exit: trade.plannedExit === null ? null : (trade.plannedExit - trade.exitPrice) / risk,
  };
}

export interface JournalSummary {
  trades: number;
  wins: number;
  /** Mean gross R and mean R after charges (fills already include your slippage). */
  avgR: number | null;
  avgNetR: number | null;
  totalNetR: number;
  /** Gross ₹ profit or loss. */
  pnl: number;
  /** Mean slippage against the plan, R (positive = worse). */
  entrySlipR: number | null;
  exitSlipR: number | null;
  /** Trades with a planned exit level to compare against. */
  exitCompared: number;
  /** Per screen: trades and wins (the "you n/m" line on plan ideas). */
  byScreen: Record<string, { trades: number; wins: number; avgNetR: number }>;
}

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

/** Net R of a closed trade: fills as given (slippage is already in them), plus the round trip's charges. */
export function netRealisedR(trade: ClosedTrade, costs: CostModel): number {
  const risk = trade.plannedEntry - trade.stop;
  if (!(risk > 0) || !(trade.quantity > 0)) return 0;
  const chargesOnly = { ...costs, slippage: { mode: "pct" as const, value: 0 } };
  return netRMultiple({ entry: trade.entryPrice, exit: trade.exitPrice, risk, qty: trade.quantity, costs: chargesOnly });
}

export function journalSummary(trades: ClosedTrade[], costs: CostModel): JournalSummary {
  const net = trades.map((trade) => netRealisedR(trade, costs));
  const slips = trades.map(slippageR);
  const exitSlips = slips.flatMap((slip) => (slip.exit === null ? [] : [slip.exit]));
  const byScreen: JournalSummary["byScreen"] = {};
  trades.forEach((trade, i) => {
    const entry = (byScreen[trade.screenId] ??= { trades: 0, wins: 0, avgNetR: 0 });
    entry.avgNetR = (entry.avgNetR * entry.trades + net[i]) / (entry.trades + 1);
    entry.trades += 1;
    if (net[i] > 0) entry.wins += 1;
  });
  return {
    trades: trades.length,
    wins: net.filter((value) => value > 0).length,
    avgR: mean(trades.map(realisedR)),
    avgNetR: mean(net),
    totalNetR: net.reduce((sum, value) => sum + value, 0),
    pnl: trades.reduce((sum, trade) => sum + (trade.exitPrice - trade.entryPrice) * trade.quantity, 0),
    entrySlipR: mean(slips.map((slip) => slip.entry)),
    exitSlipR: mean(exitSlips),
    exitCompared: exitSlips.length,
    byScreen,
  };
}

/** The price the plan would have exited at for a reason, given that session's bar when stored. */
export function plannedExitPrice(reason: ExitReason, plan: { stop: number; target: number | null }, bar: { o: number; c: number } | null): number | null {
  if (reason === "stop") return plan.stop;
  if (reason === "target") return plan.target;
  if (reason === "open") return bar?.o ?? null;
  if (reason === "time") return bar?.c ?? null;
  return null;
}
