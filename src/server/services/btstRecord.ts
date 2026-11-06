import "server-only";

import type { LiveRecordResponse } from "@/contracts/api";
import { COST_PRESETS, type CostPresetId } from "@/core/backtest/costs";
import { istParts } from "@/core/market/session";
import { inBtstWindow } from "@/core/screener/btstAlerts";
import { applySightings, liveSightings, settleEntry, summarizeLive, tradeQty, type LiveEntry, type LiveSettlement } from "@/core/screener/liveRecord";
import { SCREENS, type ScreenerRow } from "@/core/screener/screens";
import type { DailyBar } from "@/core/types";
import { readDay, readTrades, readUnsettled, watchedDays, writeEntries, writeSettlements } from "@/server/providers/btstRecord";
import { screenerStore } from "@/server/providers/dailyStore";
import { getLotSizes } from "@/server/providers/lotSizes";

// The BTST live record (src/core/screener/liveRecord.ts): written from the
// screener's own live runs, so it costs no extra API calls and doesn't depend on
// the browser's alert toggle — any screener refresh in the window records. It
// settles from data the app already has: the screener's stored daily bars
// (NSE bhavcopy, ~6 PM) or, sooner, the next morning's live bar.

/** Same charges and slippage the backtester defaults to. */
const COST_PRESET: CostPresetId = "futures-2026";
const RECENT_TRADES = 30;

/** Called on every live screener run: records matches while the window is open, then settles what it can. */
export function updateBtstRecord(params: { results: Record<string, ScreenerRow[]>; live: Map<string, DailyBar>; banned: Set<string>; now: number }) {
  const { results, live, banned, now } = params;
  try {
    if (live.size && inBtstWindow(now)) {
      const day = istParts(now).day;
      const sightings = liveSightings({ screens: SCREENS, results, banned, now });
      const prices = new Map([...live].map(([symbol, bar]) => [symbol, bar.c]));
      writeEntries(day, now, applySightings(readDay(day), sightings, prices, now));
    }
  } catch (error) {
    // The record is a side note; never let it break the screener.
    console.error("BTST live record: recording failed", error);
  }
  void settleBtstRecord(now, live).catch((error) => console.error("BTST live record: settling failed", error));
}

let settling: Promise<void> | null = null;

/** Settle every earlier trade whose next session has opened. Reads stored data only; never calls the broker. */
export function settleBtstRecord(now: number, live?: Map<string, DailyBar>): Promise<void> {
  settling ??= settle(now, live).finally(() => {
    settling = null;
  });
  return settling;
}

async function settle(now: number, live?: Map<string, DailyBar>) {
  const open = readUnsettled(istParts(now).day);
  if (!open.length) return;
  const symbols = [...new Set(open.map((entry) => entry.symbol))];
  await screenerStore.hasData(symbols);
  const barsFor = (symbol: string) => {
    const stored = screenerStore.getBars(symbol);
    const today = live?.get(symbol);
    return today && today.t > (stored.at(-1)?.t ?? 0) ? [...stored, today] : stored;
  };
  const { model } = COST_PRESETS[COST_PRESET];
  // Lot sizes only when something can settle (the first call may download NSE's lot file).
  const ready = open.filter((entry) => barsFor(entry.symbol).some((bar) => bar.t > entry.day));
  if (!ready.length) return;
  const { lots } = await getLotSizes();
  const settled: Array<{ entry: LiveEntry; settled: LiveSettlement; qty: number; costPreset: string }> = [];
  for (const entry of ready) {
    const qty = tradeQty(entry.entryPrice, lots[entry.symbol]);
    const result = settleEntry(entry, barsFor(entry.symbol), model, qty);
    if (result) settled.push({ entry, settled: result, qty, costPreset: COST_PRESET });
  }
  writeSettlements(settled);
}

export async function liveRecord(): Promise<LiveRecordResponse> {
  await settleBtstRecord(Date.now());
  const trades = readTrades();
  const { since, days } = watchedDays();
  const recent = trades
    .filter((trade) => trade.settled)
    .sort((a, b) => b.day - a.day || b.entryAt - a.entryAt)
    .slice(0, RECENT_TRADES);
  return { screens: summarizeLive(trades, SCREENS, since), recent, days, costs: { preset: COST_PRESET, label: COST_PRESETS[COST_PRESET].label } };
}
