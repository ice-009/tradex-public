// The contract every market-data source implements. The data engine
// (./engine.ts) and the market stream (./stream.ts) only talk to sources
// through this interface, so adding a source — another broker, an exchange
// file, a vendor API — is one adapter in ./sources, with nothing else in the
// app changing.
//
// Symbols are the app's own: "RELIANCE", "NIFTY", or a full exchange symbol
// such as "NSE:SBIN26NOVFUT" for a futures contract. Each adapter maps them to
// its source's naming.
//
// No server-only imports here: the engine and these types are unit-tested.

import type { ChartInterval } from "@/core/market/intervals";
import type { PricePoint, Quote, SourceKind, Tick } from "@/contracts/api";

export type { SourceKind };

/** Intervals a source is asked for. Weekly/monthly candles are built by the engine from daily ones. */
export type BaseInterval = Exclude<ChartInterval, "1w" | "1mo">;

export interface HistoryRequest {
  symbol: string;
  interval: BaseInterval;
  /** Oldest candle wanted, epoch ms (already clamped to the source's window). */
  from: number;
  /** Signed-in user, for sources that use a per-user login. */
  email?: string | null;
}

export interface HistoryResult {
  candles: PricePoint[];
  /** False when the download stopped early (rate limit, network): the rest is fetched next time. */
  complete: boolean;
}

/** A quote as a source returns it; the engine adds `source` and `delayed`. */
export type SourceQuote = Omit<Quote, "source" | "delayed">;

/** A tick as a source emits it; the engine adds `source`. */
export type SourceTick = Omit<Tick, "source" | "polled">;

export interface HistoryCapability {
  supports(interval: BaseInterval): boolean;
  /** How far back the source serves this interval (days); requests are clamped to it. */
  windowDays?(interval: BaseInterval): number;
  /** Keep downloads on disk and fetch only the newest candles next time (for sources that cost API calls). */
  cacheable: boolean;
  /** Disk-cache key; defaults to `${source id}:${symbol}:${interval}`. */
  cacheKey?(symbol: string, interval: BaseInterval): string;
  fetch(request: HistoryRequest): Promise<HistoryResult>;
}

export interface QuoteCapability {
  /** Not live prices (e.g. last end-of-day close). Delayed quotes are never cached as fresh. */
  delayed: boolean;
  /** Quotes for these symbols; symbols it doesn't know are simply left out. */
  fetch(symbols: string[]): Promise<SourceQuote[]>;
}

export interface StreamCapability {
  /** Symbols the source can stream at once (across all consumers). */
  maxSymbols: number;
  /** Connect if needed; false when it can't. */
  start(): Promise<boolean>;
  isConnected(): boolean;
  /** Subscribe in priority order; returns the symbols actually subscribed. */
  subscribe(symbols: string[]): Promise<string[]>;
  unsubscribe(symbols: string[]): void;
  /** Register for ticks; returns an unsubscribe function. */
  onTick(listener: (tick: SourceTick) => void): () => void;
  /** Drop the connection and open a fresh one (subscriptions kept). Used when ticks stop arriving. */
  restart?(reason: string): Promise<boolean>;
}

export interface DataSource {
  id: string;
  label: string;
  kind: SourceKind;
  /** Null when ready; otherwise a short reason it can't serve right now (not configured, logged out). */
  unavailable(context?: { email?: string | null }): Promise<string | null>;
  history?: HistoryCapability;
  quotes?: QuoteCapability;
  stream?: StreamCapability;
}

/**
 * Thrown by a source to say "not now, try the next source" without counting as a
 * failure (e.g. its API budget for today is spent). Anything else a source throws
 * rests it for a while.
 */
export class SourceSkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceSkip";
  }
}
