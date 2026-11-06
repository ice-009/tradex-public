import "server-only";

import { istDayKey, istParts } from "@/core/market/session";
import type { DailyBar } from "@/core/types";
import { readCandles, readSeriesMany } from "@/server/data/candleDb";
import { fyersHistoryCacheKey } from "@/server/providers/fyers/client";

// Several years of daily bars for the strategy evidence, read from what is
// already on disk — never downloaded.
//
// The screener's own store (dailyStore.ts) keeps about one year per stock, plus
// NSE delivery % for recent sessions. "Download F&O history" puts five years of
// daily candles in the market database (.cache/market.db, series keys like
// "NSE:SBIN-EQ:D"). Here the two are merged per session: the screener store's
// bar wins where both have one (it is bhavcopy-checked and carries delivery %),
// the database fills in everything older.

/** The market database's key for a stock's or index's daily series (the broker's naming). */
export const dailySeriesKey = (symbol: string) => fyersHistoryCacheKey(symbol, "1d");

/** Day key of the newest session whose daily bar is final: today only after 16:00 IST (like the screener's backfill). */
export function lastFinalDay(now = Date.now()): number {
  const { day, minutes } = istParts(now);
  return minutes >= 16 * 60 ? day : day - 1;
}

/** Stored daily bars of one symbol, oldest first, up to `lastDay`: the market database merged with the screener store. */
export function deepDailyBars(symbol: string, storeBars: DailyBar[], lastDay: number): DailyBar[] {
  const byDay = new Map<number, DailyBar>();
  for (const candle of readCandles(dailySeriesKey(symbol))) {
    const t = istDayKey(candle.date);
    byDay.set(t, { t, o: candle.open, h: candle.high, l: candle.low, c: candle.close, v: candle.volume });
  }
  for (const bar of storeBars) byDay.set(bar.t, bar);
  return [...byDay.values()].filter((bar) => bar.t <= lastDay && bar.o > 0 && bar.c > 0).sort((a, b) => a.t - b.t);
}

/** Newest final session stored for any of the symbols, in either place (cheap: series metadata only). */
export function lastStoredDay(symbols: string[], storeLast: (symbol: string) => number, lastDay: number): number {
  const meta = readSeriesMany(symbols.map(dailySeriesKey));
  let last = 0;
  for (const symbol of symbols) {
    const fromDb = meta.get(dailySeriesKey(symbol))?.lastT;
    for (const t of [fromDb ? istDayKey(fromDb) : 0, storeLast(symbol)]) if (t <= lastDay && t > last) last = t;
  }
  return last;
}
