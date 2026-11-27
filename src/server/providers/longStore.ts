import "server-only";

import { toHubSymbol } from "@/server/data/sources/hub";
import { HUB_REQUIRED } from "@/server/providers/dailyStore";
import { DEFAULT_ADJUST, hubClient, type HubCandlesBatch } from "@/server/providers/hub";
import { LongBars } from "@/server/providers/longBars";

// The app's one LongBars (./longBars.ts): daily bars for backtest and evidence
// periods older than the screener's 5-year store, read from the hub per run.

/** Batch candles from..to for app symbols: sent as hub tickers, answered back under the app's symbols. */
export async function longBatch(symbols: string[], from: number, to: number): Promise<HubCandlesBatch> {
  const hub = hubClient();
  if (!hub) throw new Error(HUB_REQUIRED);
  const appSymbols = new Map<string, string[]>();
  for (const symbol of symbols) {
    const ticker = toHubSymbol(symbol);
    if (ticker) appSymbols.set(ticker, [...(appSymbols.get(ticker) ?? []), symbol]);
  }
  const answer = await hub.candlesBatch([...appSymbols.keys()], "1d", from, to, { adjust: DEFAULT_ADJUST });
  const back = (tickers: string[]) => tickers.flatMap((ticker) => appSymbols.get(ticker.toUpperCase()) ?? []);
  const series: HubCandlesBatch["series"] = {};
  for (const [ticker, entry] of Object.entries(answer.series)) for (const symbol of appSymbols.get(ticker.toUpperCase()) ?? []) series[symbol] = entry;
  return { ...answer, series, queued: back(answer.queued), unknown: back(answer.unknown) };
}

const globalForLong = globalThis as unknown as { longBars?: LongBars; sectorLongBars?: LongBars };
if (!(globalForLong.longBars instanceof LongBars)) globalForLong.longBars = new LongBars({ batch: longBatch });
export const longBars: LongBars = globalForLong.longBars;

/** The sector indices and baskets a Signal Lab sector signal reads (its own memory, so they don't push out the stocks' set). */
if (!(globalForLong.sectorLongBars instanceof LongBars)) globalForLong.sectorLongBars = new LongBars({ batch: longBatch });
export const sectorLongBars: LongBars = globalForLong.sectorLongBars;
