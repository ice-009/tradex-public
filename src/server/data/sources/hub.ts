import { resampleIntraday } from "@/core/market/aggregate";
import type { PricePoint } from "@/contracts/api";
import { INDEX_INSTRUMENTS, historySeriesKey } from "@/server/data/seriesKey";
import { SourceSkip, type BaseInterval, type DataSource, type SourceQuote, type SourceTick, type StreamCapability } from "@/server/data/types";
import { HUB_MAX_SYMBOLS, type HubCandles, type HubClient, type HubQuote, type HubTimeframe } from "@/server/providers/hub/client";
import type { HubStream } from "@/server/providers/hub/stream";

// Market Data Hub (github.com/ice-009/market-data-hub): Tradex's market data —
// history, quotes and a live stream — from a separate service that owns the
// broker connection, its request budget and the NSE files. Tradex makes no
// broker or exchange calls of its own.
//
// It is a "broker" source: the broker's data, relayed. Candles are kept in the
// local market database (./../seriesKey.ts), so a chart opened before asks the
// hub only for its newest candles.
//
// Symbols: the app's "SBIN" / "NIFTY" / "SBIN26NOVFUT" (a stock future) are the
// hub's tickers; "NSE:SBIN-EQ", "NSE:NIFTY50-INDEX" and "NSE:SBIN26NOVFUT" (the
// names older layouts saved) are mapped to them. BSE symbols aren't served.
//
// No server-only import: built from injected parts so it can be unit-tested.

/** Most symbols the hub streams on one connection. */
export const HUB_STREAM_SYMBOLS = HUB_MAX_SYMBOLS;

const TICKER = /^[A-Z0-9][A-Z0-9&_-]{0,19}$/;
/** A stock-futures contract ticker: underlying + YY + MMM + FUT (SBIN26NOVFUT). */
const FUTURE = /^([A-Z0-9&_-]+)\d{2}[A-Z]{3}FUT$/;
/** Indices the hub serves (its ticker = the app's symbol). */
const HUB_INDICES = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "NIFTYIT", "INDIAVIX"]);
const INDEX_BY_INSTRUMENT = new Map(Object.entries(INDEX_INSTRUMENTS).map(([symbol, instrument]) => [instrument, symbol]));
const BSE_ONLY = new Set(["SENSEX"]);

/** True for a stock-futures ticker (SBIN26NOVFUT or NSE:SBIN26NOVFUT). */
export const isFutureTicker = (symbol: string) => FUTURE.test(symbol.trim().toUpperCase().replace(/^NSE:/, ""));

/** The hub's ticker for an app symbol, or null when the hub doesn't serve it (BSE). */
export function toHubSymbol(symbol: string): string | null {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized.includes(":")) return TICKER.test(normalized) && !BSE_ONLY.has(normalized) ? normalized : null;
  const index = INDEX_BY_INSTRUMENT.get(normalized);
  if (index) return HUB_INDICES.has(index) ? index : null;
  const future = /^NSE:(.+)$/.exec(normalized)?.[1];
  if (future && FUTURE.test(future) && TICKER.test(future)) return future;
  const equity = /^NSE:(.+)-EQ$/.exec(normalized)?.[1];
  return equity && TICKER.test(equity) ? equity : null;
}

/** Which hub timeframe serves a Tradex interval, and the bucket size to resample it to (null = as served). */
const TIMEFRAMES: Partial<Record<BaseInterval, { tf: HubTimeframe; resampleMinutes: number | null }>> = {
  "1m": { tf: "1m", resampleMinutes: null },
  "3m": { tf: "1m", resampleMinutes: 3 },
  "5m": { tf: "5m", resampleMinutes: null },
  "10m": { tf: "5m", resampleMinutes: 10 },
  "15m": { tf: "15m", resampleMinutes: null },
  "30m": { tf: "15m", resampleMinutes: 30 },
  "1h": { tf: "1h", resampleMinutes: null },
  "2h": { tf: "1h", resampleMinutes: 120 },
  "4h": { tf: "1h", resampleMinutes: 240 },
  "1d": { tf: "1d", resampleMinutes: null },
};

/** The hub timeframe for an interval (3m is built from 1m, 10m from 5m, 30m from 15m, 2h/4h from 1h); null when none serves it. */
export function hubTimeframe(interval: BaseInterval): { tf: HubTimeframe; resampleMinutes: number | null } | null {
  return TIMEFRAMES[interval] ?? null;
}

/** The hub serves ~5 years of daily and 1 year of intraday history (the broker's limits), and the last 30 days of 1-minute bars. */
export function hubWindowDays(interval: BaseInterval): number {
  if (interval === "1d") return 5 * 365 - 3;
  if (interval === "1m" || interval === "3m") return 30;
  return 365;
}

/** Hub candles → the app's candles at `interval`. */
export function toPricePoints(answer: Pick<HubCandles, "candles">, interval: BaseInterval): PricePoint[] {
  const points = answer.candles.map((candle) => ({ date: new Date(candle.t).toISOString(), open: candle.o, high: candle.h, low: candle.l, close: candle.c, volume: candle.v }));
  const resample = hubTimeframe(interval)?.resampleMinutes;
  return resample ? resampleIntraday(points, resample) : points;
}

const toSourceQuote = (symbol: string, quote: HubQuote): SourceQuote => ({
  symbol,
  ltp: quote.ltp,
  ch: quote.ch,
  chp: quote.chp,
  open: quote.open,
  high: quote.high,
  low: quote.low,
  prevClose: quote.prevClose,
  volume: quote.volume,
});

/** App symbols grouped by the hub ticker they map to (several app spellings can name one stock). */
function byHubSymbol(symbols: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const raw of symbols) {
    const symbol = raw.trim().toUpperCase();
    const hub = toHubSymbol(symbol);
    if (!hub) continue;
    groups.set(hub, [...(groups.get(hub) ?? []), symbol]);
  }
  return groups;
}

/**
 * The live feed over the hub's SSE stream, shaped as the market stream expects
 * a broker socket: subscribe/unsubscribe count consumers per symbol, and the
 * connection is reopened with the new symbol list when it changes.
 */
export class HubLiveFeed implements StreamCapability {
  readonly maxSymbols = HUB_STREAM_SYMBOLS;
  /** Consumers per app symbol. */
  private readonly counts = new Map<string, number>();

  constructor(private readonly stream: () => HubStream) {}

  async start(): Promise<boolean> {
    const stream = this.stream();
    stream.start();
    return stream.healthy();
  }

  isConnected(): boolean {
    return this.stream().healthy();
  }

  async subscribe(symbols: string[]): Promise<string[]> {
    const accepted: string[] = [];
    for (const raw of symbols) {
      const symbol = raw.trim().toUpperCase();
      const hub = toHubSymbol(symbol);
      if (!hub) continue; // not on the hub: the market stream polls it instead
      const count = this.counts.get(symbol) ?? 0;
      if (count === 0 && !this.hubSymbols().has(hub) && this.hubSymbols().size >= this.maxSymbols) continue;
      this.counts.set(symbol, count + 1);
      accepted.push(symbol);
    }
    this.stream().setSymbols([...this.hubSymbols()]);
    return accepted;
  }

  unsubscribe(symbols: string[]): void {
    for (const raw of symbols) {
      const symbol = raw.trim().toUpperCase();
      const count = (this.counts.get(symbol) ?? 0) - 1;
      if (count > 0) this.counts.set(symbol, count);
      else this.counts.delete(symbol);
    }
    this.stream().setSymbols([...this.hubSymbols()]);
  }

  onTick(listener: (tick: SourceTick) => void): () => void {
    return this.stream().on({
      tick: (quote) => {
        for (const symbol of byHubSymbol([...this.counts.keys()]).get(quote.symbol) ?? []) {
          listener({ ...toSourceQuote(symbol, quote), ltt: quote.ltt, ts: quote.ts });
        }
      },
    });
  }

  async restart(reason: string): Promise<boolean> {
    const stream = this.stream();
    stream.restart(reason);
    return stream.healthy();
  }

  private hubSymbols(): Set<string> {
    return new Set(byHubSymbol([...this.counts.keys()]).keys());
  }
}

export interface HubSourceDeps {
  client: () => Pick<HubClient, "candles" | "quotes">;
  stream: () => HubStream;
}

export function createHubSource(deps: HubSourceDeps): DataSource {
  return {
    id: "hub",
    label: "Market Data Hub",
    kind: "broker",

    // Only built when HUB_URL and HUB_KEY are set; a hub that's down fails its
    // requests and the engine rests it (sample data, labelled, answers meanwhile).
    unavailable: async () => null,

    history: {
      supports: (interval) => hubTimeframe(interval) !== null,
      windowDays: hubWindowDays,
      // Kept in the local database, so a chart opened before asks the hub only for the newest candles.
      cacheable: true,
      cacheKey: historySeriesKey,
      async fetch(request) {
        const symbol = toHubSymbol(request.symbol);
        if (!symbol) throw new SourceSkip(`the hub doesn't serve ${request.symbol}`);
        const answer = await deps.client().candles(symbol, hubTimeframe(request.interval)!.tf, request.from);
        const candles = toPricePoints(answer, request.interval);
        if (answer.partial) {
          // 503 with what the hub has stored: show it, but don't record it as complete.
          if (!candles.length) throw new SourceSkip(`hub: ${answer.partial.message}`);
          return { candles, complete: false };
        }
        return { candles, complete: true };
      },
    },

    quotes: {
      delayed: false,
      async fetch(symbols) {
        const groups = byHubSymbol(symbols);
        if (!groups.size) return [];
        const answer = await deps.client().quotes([...groups.keys()]);
        // A stale quote is the hub's last stored price (its broker couldn't answer, or
        // the market is closed): passed on marked delayed, so it's shown but never
        // cached as live, fires no alert and makes no intraday bar.
        return answer.quotes.flatMap((quote) => (groups.get(quote.symbol) ?? []).map((symbol) => ({ ...toSourceQuote(symbol, quote), ...(quote.stale ? { delayed: true } : {}) })));
      },
    },

    stream: new HubLiveFeed(deps.stream),
  };
}
