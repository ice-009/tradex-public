// The data engine: one pipeline for candle history and quotes, whatever the
// source. Callers ask for data; the engine
//   - tries the configured sources in order, skipping ones that can't serve
//     (not connected, not supporting the interval) or are resting after errors,
//     and falls back to the next on failure;
//   - keeps history on disk per source and fetches only the newest candles
//     (for sources that cost API calls);
//   - caches live quotes, with each caller saying how old a quote it accepts;
//   - tags everything with the source it came from.
//
// It knows nothing about any particular source (see ./types.ts). No server-only
// imports: dependencies are injected so it can be unit-tested with fake sources.

import { CHART_INTERVAL_CONFIG } from "@/core/market/intervals";
import type { PricePoint, Quote } from "@/contracts/api";
import { SourceSkip, type BaseInterval, type DataSource, type HistoryResult, type SourceKind } from "./types";

/** A failing source is skipped for this long, then tried again. */
export const REST_MS = 30_000;
/** Errors that mean the whole source is down, not just this request. */
const SOURCE_WIDE = /\b(401|403|429|5\d\d)\b|^fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|timed? ?out|unauthori[sz]ed|invalid token/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Disk-backed incremental history (see ../providers/historyStore.ts); injected so tests can pass a fake. */
export interface HistoryStore {
  get(params: { key: string; from: number; freshMs: number; overlapMs: number; reload?: boolean; download: (fromMs: number) => Promise<HistoryResult> }): Promise<PricePoint[]>;
}

export interface EngineOptions {
  historyStore: HistoryStore;
  now?: () => number;
  log?: (message: string) => void;
}

export interface HistoryAnswer {
  candles: PricePoint[];
  /** The source that answered, or null when none had data. */
  source: Pick<DataSource, "id" | "label" | "kind"> | null;
  /** Why earlier sources were passed over, in order. */
  skipped: string[];
}

interface Health {
  restingUntil: number;
  lastError: string | null;
}

/** How long a history download stays fresh, and how far back a refresh re-reads (to replace the forming candle and spot splits). */
function freshness(interval: BaseInterval) {
  const unit = CHART_INTERVAL_CONFIG[interval].unit;
  return unit === "days" ? { freshMs: 15 * 60_000, overlapMs: 5 * DAY_MS } : { freshMs: 30_000, overlapMs: DAY_MS };
}

export class DataEngine {
  private readonly health = new Map<string, Health>();
  private readonly quoteCache = new Map<string, { at: number; quote: Quote }>();
  private readonly quoteInflight = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(
    readonly sources: DataSource[],
    private readonly options: EngineOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  // ------------------------------------------------------------------ history

  /**
   * Candles for `symbol` from `from` (epoch ms) to now. Weekly/monthly candles are
   * built from daily ones. `kinds` limits which kinds of source may answer (the
   * screener only accepts real broker data); `reload` forces a full download.
   */
  async history(request: { symbol: string; interval: BaseInterval; from: number; email?: string | null; kinds?: SourceKind[]; reload?: boolean }): Promise<HistoryAnswer> {
    const skipped: string[] = [];
    for (const source of this.sources) {
      const history = source.history;
      if (!history || !history.supports(request.interval) || (request.kinds && !request.kinds.includes(source.kind))) continue;
      const reason = await this.unavailable(source, request.email);
      if (reason) {
        skipped.push(`${source.label}: ${reason}`);
        continue;
      }
      const window = history.windowDays?.(request.interval);
      const from = window ? Math.max(request.from, this.now() - window * DAY_MS) : request.from;
      try {
        const download = (fromMs: number) => history.fetch({ symbol: request.symbol, interval: request.interval, from: fromMs, email: request.email });
        const candles = history.cacheable
          ? await this.options.historyStore.get({
              key: history.cacheKey?.(request.symbol, request.interval) ?? `${source.id}:${request.symbol}:${request.interval}`,
              from,
              reload: request.reload,
              ...freshness(request.interval),
              download,
            })
          : (await download(from)).candles;
        if (candles.length) return { candles, source: { id: source.id, label: source.label, kind: source.kind }, skipped };
        skipped.push(`${source.label}: no data for ${request.symbol}`);
      } catch (error) {
        skipped.push(`${source.label}: ${this.failed(source, error)}`);
      }
    }
    return { candles: [], source: null, skipped };
  }

  // ------------------------------------------------------------------ quotes

  /**
   * Quotes for `symbols`. Live quotes no older than `maxAgeMs` come from the cache;
   * the rest are fetched from the first source that has them, then the next source
   * fills in whatever is still missing (e.g. end-of-day closes when the broker is down).
   */
  async quotes(symbols: string[], options: { maxAgeMs: number; kinds?: SourceKind[] }): Promise<Quote[]> {
    const wanted = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
    const result = new Map<string, Quote>();
    const now = this.now();
    let missing = wanted.filter((symbol) => {
      const hit = this.quoteCache.get(symbol);
      const kindOk = !options.kinds || options.kinds.includes(this.kindOf(hit?.quote.source));
      if (hit && kindOk && now - hit.at <= options.maxAgeMs) result.set(symbol, hit.quote);
      return !result.has(symbol);
    });

    for (const source of this.sources) {
      const quotes = source.quotes;
      if (!missing.length) break;
      if (!quotes || (options.kinds && !options.kinds.includes(source.kind))) continue;
      if (await this.unavailable(source)) continue;
      try {
        const got = quotes.delayed ? await this.fetchQuotes(source, missing) : await this.fetchLiveQuotes(source, missing, options.maxAgeMs);
        for (const quote of got) result.set(quote.symbol, quote);
        missing = missing.filter((symbol) => !result.has(symbol));
      } catch (error) {
        this.failed(source, error);
      }
    }
    return wanted.flatMap((symbol) => (result.has(symbol) ? [result.get(symbol)!] : []));
  }

  /** Last quote seen for a symbol (any age), without fetching. */
  cachedQuote(symbol: string): Quote | null {
    return this.quoteCache.get(symbol.toUpperCase())?.quote ?? null;
  }

  // ------------------------------------------------------------------ health

  status(): Array<{ source: DataSource; restingUntil: number | null; lastError: string | null }> {
    const now = this.now();
    return this.sources.map((source) => {
      const health = this.health.get(source.id);
      return { source, restingUntil: health && health.restingUntil > now ? health.restingUntil : null, lastError: health?.lastError ?? null };
    });
  }

  /** Null when `source` may be asked now; otherwise why not. */
  async unavailable(source: DataSource, email?: string | null): Promise<string | null> {
    const health = this.health.get(source.id);
    if (health && health.restingUntil > this.now()) return `resting after an error (${health.lastError})`;
    try {
      return await source.unavailable({ email });
    } catch (error) {
      return (error as Error).message || "unavailable";
    }
  }

  /**
   * Record a failure. SourceSkip, and errors about one request (bad symbol: 400/404/422),
   * just pass to the next source; source-wide failures (network, auth, 5xx, rate limit)
   * rest the source for REST_MS so later requests go straight to the next one.
   */
  private failed(source: DataSource, error: unknown): string {
    const message = (error as Error)?.message || String(error);
    if (error instanceof SourceSkip || !SOURCE_WIDE.test(message)) return message;
    this.health.set(source.id, { restingUntil: this.now() + REST_MS, lastError: message });
    this.log(`Data source ${source.id} failed (${message}); trying the next source for ${REST_MS / 1000} s.`);
    return message;
  }

  private kindOf(sourceId: string | undefined): SourceKind {
    return this.sources.find((source) => source.id === sourceId)?.kind ?? "broker";
  }

  private async fetchQuotes(source: DataSource, symbols: string[]): Promise<Quote[]> {
    const quotes = await source.quotes!.fetch(symbols);
    const delayed = source.quotes!.delayed;
    return quotes.map((quote) => ({ ...quote, source: source.id, ...(delayed ? { delayed: true } : {}) }));
  }

  /** Live quotes through the cache: concurrent callers share one fetch per symbol. */
  private async fetchLiveQuotes(source: DataSource, symbols: string[], maxAgeMs: number): Promise<Quote[]> {
    const stale = symbols.filter((symbol) => !this.quoteInflight.has(symbol));
    if (stale.length) {
      const job = this.fetchQuotes(source, stale).then((quotes) => {
        const at = this.now();
        for (const quote of quotes) this.quoteCache.set(quote.symbol, { at, quote });
      });
      const settled = job.finally(() => stale.forEach((symbol) => this.quoteInflight.delete(symbol)));
      stale.forEach((symbol) => this.quoteInflight.set(symbol, settled.catch(() => undefined)));
      await settled; // this caller's own fetch: let its error reach the source health check
    }
    await Promise.all(symbols.map((symbol) => this.quoteInflight.get(symbol)).filter(Boolean));
    const now = this.now();
    return symbols.flatMap((symbol) => {
      const hit = this.quoteCache.get(symbol);
      return hit && hit.quote.source === source.id && now - hit.at <= Math.max(maxAgeMs, 60_000) ? [hit.quote] : [];
    });
  }
}
