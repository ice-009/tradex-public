import { legCosts, slipped, type CostModel } from "@/core/backtest/costs";
import { istParts } from "@/core/market/session";
import type { DailyBar } from "@/core/types";
import { inBtstWindow } from "./btstAlerts";
import type { ScreenDef, ScreenerRow } from "./screens";

// The BTST live record: what the BTST alerts would have earned, written down as
// it happens instead of replayed afterwards. The backtested edge is thin
// (~0.1% a trade after costs), so the track record alone can't vouch for a
// screen; this forward record has no hindsight in it.
//
//   Record: every live match of a "next-open" screen seen in the alert window
//   (3:10–3:25 PM IST), keyed by trade day + screen + symbol. The first
//   sighting is kept; the entry is the LAST price seen in the window — about
//   where you'd really have bought — and keeps following the stock even if it
//   stops matching later in the window (the alert had already flashed).
//   Settle: at the next session's open (first daily bar after the trade day),
//   gross and net of the cost model, like the backtester's fills. Pure.

/** One recorded setup: one screen, one stock, one trade day. */
export interface LiveEntry {
  screenId: string;
  symbol: string;
  /** IST trade day (UTC midnight of the IST date, like DailyBar.t). */
  day: number;
  firstSeenAt: number;
  firstPrice: number;
  /** Last sighting inside the window and its price: the entry. */
  entryAt: number;
  entryPrice: number;
  /** The plan's stop when the setup last matched. */
  stop: number;
}

export interface LiveSettlement {
  /** Day of the session whose open closed the trade. */
  exitDay: number;
  /** That session's open (before slippage). */
  exitPrice: number;
  /** Entry → open, % of entry. */
  grossPct: number;
  /** After slippage on both legs and the round trip's charges, % of the entry fill. */
  netPct: number;
  /** The open was at or below the plan's stop: the stop could not have saved it. */
  gapStop: boolean;
}

export interface LiveTrade extends LiveEntry {
  settled: LiveSettlement | null;
}

/** A match (with its stop) or, without a stop, just a later price for a recorded setup. */
export interface Sighting {
  screenId: string;
  symbol: string;
  price: number;
  stop?: number;
}

export const liveKey = (day: number, screenId: string, symbol: string) => `${day}:${screenId}:${symbol}`;

/** Live, unbanned matches of the overnight screens — only inside the alert window. */
export function liveSightings(params: { screens: ScreenDef[]; results: Record<string, ScreenerRow[]>; banned: Set<string>; now: number }): Sighting[] {
  const { screens, results, banned, now } = params;
  if (!inBtstWindow(now)) return [];
  const out: Sighting[] = [];
  for (const screen of screens) {
    if (screen.exit !== "next-open") continue;
    for (const row of results[screen.id] ?? []) {
      // Only today's live bar: an EOD row is yesterday's setup.
      if (!row.live || banned.has(row.symbol) || !(row.close > 0)) continue;
      out.push({ screenId: screen.id, symbol: row.symbol, price: row.close, stop: row.plan.stop });
    }
  }
  return out;
}

/**
 * Fold one sighting into today's entry. Null when nothing should be written:
 * outside the window, a price-only sighting of a setup never matched, or a
 * sighting older than what's already recorded.
 */
export function upsertEntry(existing: LiveEntry | undefined, sighting: Sighting, now: number): LiveEntry | null {
  if (!inBtstWindow(now) || !(sighting.price > 0)) return null;
  const day = istParts(now).day;
  if (!existing || existing.day !== day) {
    if (sighting.stop === undefined) return null;
    return { screenId: sighting.screenId, symbol: sighting.symbol, day, firstSeenAt: now, firstPrice: sighting.price, entryAt: now, entryPrice: sighting.price, stop: sighting.stop };
  }
  if (now < existing.entryAt) return null;
  return { ...existing, entryAt: now, entryPrice: sighting.price, stop: sighting.stop ?? existing.stop };
}

/**
 * One screener run's worth of updates: new and continuing matches, plus the
 * latest price for today's setups that no longer match. Returns the entries to write.
 */
export function applySightings(today: LiveEntry[], sightings: Sighting[], prices: Map<string, number>, now: number): LiveEntry[] {
  const byKey = new Map(today.map((entry) => [liveKey(entry.day, entry.screenId, entry.symbol), entry]));
  const day = istParts(now).day;
  const changed = new Map<string, LiveEntry>();
  for (const sighting of sightings) {
    const key = liveKey(day, sighting.screenId, sighting.symbol);
    const next = upsertEntry(changed.get(key) ?? byKey.get(key), sighting, now);
    if (next) changed.set(key, next);
  }
  for (const [key, entry] of byKey) {
    const price = prices.get(entry.symbol);
    if (changed.has(key) || price === undefined) continue;
    const next = upsertEntry(entry, { screenId: entry.screenId, symbol: entry.symbol, price }, now);
    if (next) changed.set(key, next);
  }
  return [...changed.values()];
}

/** Below this, a stock without a known lot is sized as ~₹5 lakh of shares (only the ₹20 brokerage depends on size). */
const NOTIONAL = 500_000;

/** Quantity the net return is worked out for: one lot when known. */
export function tradeQty(price: number, lot: number | null | undefined): number {
  if (lot && lot > 0) return lot;
  return price > 0 ? Math.max(1, Math.round(NOTIONAL / price)) : 1;
}

/** Close the trade at the first session's open after the trade day; null until that bar exists. */
export function settleEntry(entry: LiveEntry, bars: DailyBar[], model: CostModel, qty: number): LiveSettlement | null {
  const next = bars.find((bar) => bar.t > entry.day && bar.o > 0);
  if (!next || !(entry.entryPrice > 0) || !(qty > 0)) return null;
  const entryFill = slipped("buy", entry.entryPrice, model);
  const exitFill = slipped("sell", next.o, model);
  const charges = legCosts("buy", entryFill, qty, model).total + legCosts("sell", exitFill, qty, model).total;
  return {
    exitDay: next.t,
    exitPrice: next.o,
    grossPct: (next.o / entry.entryPrice - 1) * 100,
    netPct: (((exitFill - entryFill) * qty - charges) / (entryFill * qty)) * 100,
    gapStop: next.o <= entry.stop,
  };
}

/** One screen's live record. Averages are over settled trades; null before the first one. */
export interface LiveScreenRecord {
  screenId: string;
  /** First trade day the recorder watched (or this screen's first trade, if earlier). */
  since: number | null;
  trades: number;
  pending: number;
  avgNetPct: number | null;
  avgGrossPct: number | null;
  /** Share of settled trades with a positive net return, 0–1. */
  winShare: number | null;
  gapStops: number;
}

/** Per screen, for every overnight screen (empty records included, so "0 trades since…" can show). */
export function summarizeLive(trades: LiveTrade[], screens: ScreenDef[], watchedSince: number | null): Record<string, LiveScreenRecord> {
  const out: Record<string, LiveScreenRecord> = {};
  for (const screen of screens) {
    if (screen.exit !== "next-open") continue;
    const mine = trades.filter((trade) => trade.screenId === screen.id);
    const settled = mine.flatMap((trade) => (trade.settled ? [trade.settled] : []));
    const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
    const firstDay = mine.length ? Math.min(...mine.map((trade) => trade.day)) : null;
    out[screen.id] = {
      screenId: screen.id,
      since: watchedSince === null ? firstDay : firstDay === null ? watchedSince : Math.min(watchedSince, firstDay),
      trades: settled.length,
      pending: mine.length - settled.length,
      avgNetPct: mean(settled.map((trade) => trade.netPct)),
      avgGrossPct: mean(settled.map((trade) => trade.grossPct)),
      winShare: settled.length ? settled.filter((trade) => trade.netPct > 0).length / settled.length : null,
      gapStops: settled.filter((trade) => trade.gapStop).length,
    };
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "6 Nov" for a day key. */
export const dayLabel = (day: number) => `${new Date(day).getUTCDate()} ${MONTHS[new Date(day).getUTCMonth()]}`;
export const signedPct = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

/** "Live since 6 Nov: 12 trades, avg net +0.08%, win 58%" — one line for tooltips and the info panel. */
export function liveRecordLine(record: LiveScreenRecord | undefined): string {
  if (!record || record.since === null) return "Live record: nothing recorded yet (it starts at the next 3:10–3:25 PM window)";
  const head = `Live since ${dayLabel(record.since)}: ${record.trades} trade${record.trades === 1 ? "" : "s"}`;
  const waiting = record.pending ? ` (+${record.pending} waiting for the next open)` : "";
  if (!record.trades || record.avgNetPct === null || record.winShare === null) return `${head}${waiting}`;
  return `${head}, avg net ${signedPct(record.avgNetPct)}, win ${Math.round(record.winShare * 100)}%${waiting}`;
}
