import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SESSION_CLOSE_MIN, isWeekday, istParts } from "@/core/market/session";
import { sweepIntervalMs } from "@/core/ratelimit/budget";
import type { DailyBar } from "@/core/types";
import { dataEngine, marketStream } from "@/server/data";
import { toHubSymbol } from "@/server/data/sources/hub";
import { DailyBarStore, type StoredSeries } from "@/server/providers/dailyBars";
import { hubClient, type HubCandlesBatch } from "@/server/providers/hub";
import { budgetFor, planLimits } from "@/server/providers/hub/budget";

export type { DailyBar };

// The screener's daily bars: a DailyBarStore (./dailyBars.ts) filled from the
// Market Data Hub's batch candles and kept in .cache/screener/daily, plus the
// live overlay — today's forming bar from the hub's quotes and stream — during
// the session.

const DAILY_DIR = path.join(process.cwd(), ".cache", "screener", "daily");
/** Fastest the screener's live quotes refresh, however much budget is left. */
const MIN_LIVE_PACE_MS = 15 * 1000;

export const HUB_REQUIRED = "Connect a Market Data Hub (HUB_URL and HUB_KEY in .env): Tradex gets its market data from it. See github.com/ice-009/market-data-hub.";

const symbolFile = (symbol: string) => path.join(DAILY_DIR, `${encodeURIComponent(symbol)}.json`);
type Row = [number, number, number, number, number, number, number | null];

async function read(symbol: string): Promise<StoredSeries | null> {
  const saved = JSON.parse(await readFile(symbolFile(symbol), "utf8")) as Row[] | { coveredFrom: number | null; rows: Row[] };
  // Files from earlier versions are a bare array with no coverage: read in full from the hub once.
  const rows = Array.isArray(saved) ? saved : saved.rows;
  return { coveredFrom: Array.isArray(saved) ? null : saved.coveredFrom, bars: rows.map(([t, o, h, l, c, v, dp]) => ({ t, o, h, l, c, v, dp: dp ?? undefined })) };
}

async function write(symbol: string, series: StoredSeries) {
  await mkdir(DAILY_DIR, { recursive: true });
  const rows: Row[] = series.bars.map((bar) => [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v, bar.dp ?? null]);
  await writeFile(symbolFile(symbol), JSON.stringify({ coveredFrom: series.coveredFrom, rows }));
}

/**
 * How often to refresh live quotes for `count` symbols so that, at "refresh"
 * priority, the hub's broker budget lasts until the close (≈ 1 min for the F&O
 * list on Standard, the 15 s floor on Prime). Ticks fill in between.
 */
function livePaceMs(count: number, minutes: number): number {
  const refresh = budgetFor("refresh");
  const interval = sweepIntervalMs({
    requestsPerSweep: Math.ceil(count / planLimits().limits.quoteBatch),
    remainingToday: refresh.remainingToday,
    minutesLeft: Math.max(1, SESSION_CLOSE_MIN - minutes),
    backgroundPerMinute: refresh.perMinute,
    shareOfBackground: 0.4,
    minMs: MIN_LIVE_PACE_MS,
  });
  return interval ?? 10 * 60 * 1000; // budget spent: every 10 minutes, ticks in between
}

class ScreenerStore extends DailyBarStore {
  private readonly quoteCache = new Map<string, { at: number; bars: Map<string, DailyBar> }>();

  /**
   * Today's forming bar per symbol, for symbols whose stored history doesn't
   * include today yet. Empty outside trading days/hours.
   *
   * Two layers, so screens can change during the day instead of sticking to the
   * morning's picture:
   *   1. Live quotes from the hub for all of them, refreshed at a pace the hub's
   *      broker budget can keep up for the rest of the session.
   *   2. On top, any newer tick from the market stream (charts, watchlist,
   *      visible screener rows) — instant and free.
   */
  async liveSnapshot(symbols: string[]): Promise<{ bars: Map<string, DailyBar>; quotesAt: number | null; paceMs: number | null; fromTicks: number }> {
    const { day: today, minutes } = istParts();
    const empty = { bars: new Map<string, DailyBar>(), quotesAt: null, paceMs: null, fromTicks: 0 };
    if (!isWeekday(today) || minutes < 9 * 60 + 15) return empty;
    const wanted = symbols.filter((symbol) => {
      const series = this.getBars(symbol);
      return series.length && series[series.length - 1].t < today;
    });
    if (!wanted.length) return empty;

    const paceMs = livePaceMs(wanted.length, minutes);
    const key = wanted.join(",");
    let cached = this.quoteCache.get(key);
    if (!cached || Date.now() - cached.at >= paceMs) {
      // Live quotes only: a stored last price (delayed) isn't today's bar.
      const fetchedAt = Date.now();
      const quotes = await dataEngine().quotes(wanted, { maxAgeMs: paceMs, kinds: ["broker"] });
      const bars = new Map<string, DailyBar>();
      for (const quote of quotes) {
        if (quote.delayed) continue;
        const bar = this.todayBar(quote.symbol, today, quote);
        if (bar) bars.set(quote.symbol, bar);
      }
      // Keep the last good snapshot when this round got nothing (budget pause, hub hiccup).
      if (bars.size || !cached) cached = { at: bars.size ? fetchedAt : (cached?.at ?? 0), bars };
      this.quoteCache.set(key, cached);
    }

    // Newer ticks win: they're what the chart and watchlist already show.
    const bars = new Map(cached.bars);
    let fromTicks = 0;
    for (const tick of marketStream().getLatest(wanted)) {
      if (tick.ts < cached.at) continue;
      const bar = this.todayBar(tick.symbol, today, { open: tick.open, high: tick.high, low: tick.low, ltp: tick.ltp, volume: tick.volume });
      if (bar) {
        bars.set(tick.symbol, bar);
        fromTicks += 1;
      }
    }
    return { bars, quotesAt: cached.at || null, paceMs, fromTicks };
  }

  async getLiveBars(symbols: string[]): Promise<Map<string, DailyBar>> {
    return (await this.liveSnapshot(symbols)).bars;
  }

  /** Today's bar from a quote or tick; null when unusable or when it's really the previous session (exchange holiday). */
  private todayBar(symbol: string, today: number, quote: { open: number; high: number; low: number; ltp: number; volume: number }): DailyBar | null {
    if (!quote.ltp || !quote.open || !quote.high || !quote.low) return null;
    const last = this.getBars(symbol).at(-1);
    if (last && quote.open === last.o && quote.high === last.h && quote.low === last.l) return null;
    return { t: today, o: quote.open, h: quote.high, l: quote.low, c: quote.ltp, v: quote.volume };
  }
}

/** Batch candles for app symbols: sent as plain hub tickers, answered back under the app's symbols. */
async function batch(symbols: string[], from: number): Promise<HubCandlesBatch> {
  const hub = hubClient();
  if (!hub) throw new Error(HUB_REQUIRED);
  const appSymbols = new Map<string, string[]>();
  const unsupported: string[] = [];
  for (const symbol of symbols) {
    const ticker = toHubSymbol(symbol);
    if (ticker) appSymbols.set(ticker, [...(appSymbols.get(ticker) ?? []), symbol]);
    else unsupported.push(symbol);
  }
  const answer = await hub.candlesBatch([...appSymbols.keys()], "1d", from);
  const back = (tickers: string[]) => tickers.flatMap((ticker) => appSymbols.get(ticker.toUpperCase()) ?? []);
  const series: HubCandlesBatch["series"] = {};
  for (const [ticker, entry] of Object.entries(answer.series)) for (const symbol of appSymbols.get(ticker.toUpperCase()) ?? []) series[symbol] = entry;
  return { ...answer, series, queued: back(answer.queued), unknown: [...back(answer.unknown), ...unsupported] };
}

function createStore() {
  return new ScreenerStore({
    batch,
    read,
    write,
    log: (message) => console.warn(message),
  });
}

// Singleton across requests. A hot reload that changes the class replaces the
// instance (state is cheap to rebuild from the disk cache).
const globalForScreener = globalThis as unknown as { screenerStore?: ScreenerStore };
if (!(globalForScreener.screenerStore instanceof ScreenerStore)) globalForScreener.screenerStore = createStore();
export const screenerStore: ScreenerStore = globalForScreener.screenerStore;
