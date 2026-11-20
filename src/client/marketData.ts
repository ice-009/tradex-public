import { DAY_MS, IST_OFFSET_MS } from "@/core/market/session";
import type { ChartInterval } from "@/core/market/intervals";
import type { Bar } from "@/core/types";
import type { Quote, SourceKind, StreamStatus, SymbolInfo, Tick } from "@/contracts/api";
import { api } from "@/client/api";
import { istClock } from "@/core/format";
import { INTERVAL_META } from "@/core/market/intervals";

// Browser-side market data: candle history over /api/chart, snapshot quotes
// over /api/quotes, and ONE shared SSE connection for live ticks that every
// chart and the watchlist multiplex onto.

/** A live price update (same shape from every data source; see src/contracts/api.ts). */
export type LiveTick = Tick;

export type { Quote, SymbolInfo };

export interface HistoryResult {
  bars: Bar[];
  /** Kind of source that answered: the Market Data Hub ("broker") or generated sample data. */
  source: SourceKind;
  /** Why a fallback source was used. */
  reason: string | null;
  /** Split/bonus ex-dates in range (the hub's; prices before them are adjusted). */
  corporateActions: Array<{ time: number; label: string; title: string }>;
}

export async function fetchHistory(symbol: string, interval: ChartInterval, signal?: AbortSignal): Promise<HistoryResult> {
  const meta = INTERVAL_META[interval];
  const data = await api.chart(symbol, interval, meta.range, signal);
  if (data.error) throw new Error(data.error);
  const bars: Bar[] = (data.priceSeries ?? [])
    .map((point) => ({
      time: Date.parse(point.date),
      open: point.open,
      high: point.high,
      low: point.low,
      close: point.close,
      volume: point.volume ?? 0,
    }))
    .filter((bar: Bar) => Number.isFinite(bar.time) && Number.isFinite(bar.close))
    .sort((a: Bar, b: Bar) => a.time - b.time);
  return { bars, source: data.source ?? "sample", reason: data.sourceReason ?? null, corporateActions: data.corporateActions ?? [] };
}

export async function fetchQuotes(symbols: string[], options: { fresh?: boolean } = {}): Promise<Quote[]> {
  if (!symbols.length) return [];
  try {
    const data = await api.quotes(symbols, options.fresh);
    return Array.isArray(data.quotes) ? data.quotes : [];
  } catch {
    return [];
  }
}

const symbolCache = new Map<string, SymbolInfo>();

export async function searchSymbols(query: string, signal?: AbortSignal): Promise<SymbolInfo[]> {
  let results: SymbolInfo[];
  try {
    const data = await api.symbols(query, signal);
    results = Array.isArray(data.results) ? data.results : [];
  } catch (error) {
    if (signal?.aborted) throw error;
    return [];
  }
  for (const item of results) symbolCache.set(item.symbol, item);
  return results;
}

export async function getSymbolInfo(symbol: string): Promise<SymbolInfo | null> {
  const cached = symbolCache.get(symbol);
  if (cached) return cached;
  const results = await searchSymbols(symbol);
  return results.find((item) => item.symbol === symbol) ?? null;
}

// ------------------------------------------------------------------ live hub

/** live = socket ticks; delayed = no socket, prices polled every few seconds. */
export type LiveStatus = "idle" | "connecting" | "live" | "delayed" | "offline";
type TickListener = (tick: LiveTick) => void;

/** Most symbols the hub streams live on one connection; past it, list order is priority. */
export const STREAM_SYMBOL_LIMIT = 100;
/** A connection still carrying symbols nobody listens to is trimmed after this long. */
const PRUNE_AFTER_MS = 30_000;
/** The old connection is closed once the new one answers, or after this long regardless. */
const HANDOVER_MS = 10_000;

/**
 * What the open stream (`open`, the symbols it was opened with, in priority order)
 * needs for the symbols wanted now (`wanted`, in priority order):
 *  - "reconnect" when a wanted symbol isn't on it, or (past the limit) a top-priority
 *    one isn't among its live slots;
 *  - "prune" when it carries extra symbols — they cost nothing in the browser, so
 *    it's trimmed later rather than now (a row scrolled away often comes back);
 *  - "keep" otherwise. Order alone never reconnects: a sorted watchlist reorders on
 *    every tick, and each reconnect is a gap in the prices.
 */
export function streamChange(open: string[], wanted: string[], limit = STREAM_SYMBOL_LIMIT): "keep" | "reconnect" | "prune" {
  if (!wanted.length) return open.length ? "reconnect" : "keep";
  const all = new Set(open);
  if (wanted.some((symbol) => !all.has(symbol))) return "reconnect";
  const liveSlots = new Set(open.slice(0, limit));
  if (wanted.slice(0, limit).some((symbol) => !liveSlots.has(symbol))) return "reconnect";
  return open.length > wanted.length ? "prune" : "keep";
}

class LiveHub {
  private readonly listeners = new Map<string, Set<TickListener>>();
  private readonly statusListeners = new Set<(status: LiveStatus) => void>();
  private readonly latest = new Map<string, LiveTick>();
  /** Per symbol, each listener's priority (lower = kept first under the broker's symbol limit). */
  private readonly priorities = new Map<string, Map<TickListener, number>>();
  private limited = new Set<string>();
  /** When anything (status, tick) last arrived on the stream. */
  private lastEventAt = 0;
  /** When the last price tick arrived (0 = none yet). */
  lastTickAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private source: EventSource | null = null;
  /** Symbols `source` was opened with, in priority order. */
  private sourceSymbols: string[] = [];
  /** The previous connection, kept open until `source` answers (no gap in prices). */
  private retiring: { source: EventSource; timer: ReturnType<typeof setTimeout> } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pruneTimer: ReturnType<typeof setTimeout> | null = null;
  status: LiveStatus = "idle";

  /**
   * Live ticks for `symbol`. The Market Data Hub streams a limited number of symbols
   * (100 per connection), so lower `priority` numbers are kept first: 0 = open charts,
   * 1 = alerts, 2+ = watchlist rows in list order. Symbols that don't fit get no
   * ticks and stay on the (slower) quote refresh.
   */
  subscribe(symbol: string, listener: TickListener, priority = 2) {
    const key = symbol.toUpperCase();
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    const ranks = this.priorities.get(key) ?? new Map<TickListener, number>();
    ranks.set(listener, priority);
    this.priorities.set(key, ranks);
    this.schedule();
    return () => {
      set.delete(listener);
      ranks.delete(listener);
      if (!set.size) {
        this.listeners.delete(key);
        this.priorities.delete(key);
      }
      this.schedule();
    };
  }

  /** Symbols the broker refused because of its streaming limit (they update by polling). */
  isLimited(symbol: string) {
    return this.limited.has(symbol.toUpperCase());
  }

  onStatus(listener: (status: LiveStatus) => void) {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  getLatest(symbol: string) {
    return this.latest.get(symbol.toUpperCase()) ?? null;
  }

  private setStatus(status: LiveStatus) {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  // Symbol sets change in bursts (layout switch, watchlist load); coalesce
  // them into a single reconnect.
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reconnect(), 150);
  }

  /**
   * The server sends a status event every 15 s. Hearing nothing for 40 s means the
   * connection died without telling us (Wi-Fi change, laptop sleep, iPad Safari
   * suspending the tab), so open a new one. Same when a hidden tab comes back.
   */
  private watch() {
    if (this.watchdog || typeof window === "undefined") return;
    this.watchdog = setInterval(() => {
      if (this.source && Date.now() - this.lastEventAt > 40_000) this.reconnect("force");
    }, 10_000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.source && Date.now() - this.lastEventAt > 20_000) this.reconnect("force");
    });
  }

  /**
   * Bring the connection in line with the symbols wanted now (see `streamChange`).
   * `force` reopens it even when nothing changed (a dead connection); `prune` is the
   * delayed trim of symbols nobody listens to any more.
   */
  private reconnect(mode: "change" | "force" | "prune" = "change") {
    if (mode === "prune") this.pruneTimer = null;
    else this.timer = null;
    this.watch();
    const rank = (symbol: string) => Math.min(...(this.priorities.get(symbol)?.values() ?? [Infinity]));
    const symbols = [...this.listeners.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const change = this.source ? streamChange(this.sourceSymbols, symbols) : symbols.length ? "reconnect" : "keep";
    if (mode !== "force" && change === "keep") return;
    if (mode === "change" && change === "prune") {
      this.pruneTimer ??= setTimeout(() => this.reconnect("prune"), PRUNE_AFTER_MS);
      return;
    }
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.pruneTimer = null;

    // Make before break: the old connection keeps delivering until the new one answers,
    // and the server never sees its symbols drop to no subscribers in between.
    this.retire(); // a connection already being replaced isn't needed any more
    const previous = this.source;
    this.source = null;
    this.sourceSymbols = symbols;
    if (!symbols.length) {
      previous?.close();
      this.setStatus("idle");
      return;
    }
    if (previous) this.retiring = { source: previous, timer: setTimeout(() => this.retire(), HANDOVER_MS) };
    if (!previous || this.status !== "live") this.setStatus("connecting");

    this.lastEventAt = Date.now();
    const source = new EventSource(`/api/broker/stream?symbols=${encodeURIComponent(symbols.join(","))}`);
    this.source = source;
    this.listen(source);
  }

  /** Close the connection being replaced, if any. */
  private retire() {
    if (!this.retiring) return;
    clearTimeout(this.retiring.timer);
    this.retiring.source.close();
    this.retiring = null;
  }

  private listen(source: EventSource) {
    source.addEventListener("status", (event) => {
      if (this.source !== source) return; // the retiring connection's status is stale
      this.retire();
      try {
        this.lastEventAt = Date.now();
        const data = JSON.parse((event as MessageEvent).data) as StreamStatus;
        this.limited = new Set(data.polled ?? []);
        // Live if anything is on the live socket (extra watchlist rows may be polled); delayed if all are polled.
        this.setStatus(data.live?.length ? "live" : data.mode === "polling" ? "delayed" : "offline");
      } catch {
        // ignore malformed status frames
      }
    });
    source.addEventListener("tick", (event) => {
      try {
        const tick = JSON.parse((event as MessageEvent).data) as LiveTick;
        if (typeof tick.ltp !== "number") return;
        if (this.source === source) this.retire();
        this.lastEventAt = this.lastTickAt = Date.now();
        const next = tick.polled ? "delayed" : "live";
        if (this.status !== next && !(next === "delayed" && this.status === "live")) this.setStatus(next);
        this.latest.set(tick.symbol, tick);
        for (const listener of this.listeners.get(tick.symbol) ?? []) listener(tick);
      } catch {
        // ignore malformed tick frames
      }
    });
    source.onerror = () => {
      // EventSource retries on its own; reflect the gap in the status pill.
      if (this.source === source) this.setStatus("connecting");
    };
  }
}

export const liveHub = new LiveHub();

// ------------------------------------------------------------------ tick → candle

const SESSION_OPEN_MINUTES = 9 * 60 + 15;
const SESSION_CLOSE_MINUTES = 15 * 60 + 30;

function istDayNumber(time: number) {
  return Math.floor((time + IST_OFFSET_MS) / DAY_MS);
}

/** Start of the intraday bar containing `time`, aligned to the 09:15 IST session open (as the hub's candles are). */
function intradayBucket(time: number, intervalMs: number) {
  const dayStart = istDayNumber(time) * DAY_MS - IST_OFFSET_MS;
  const open = dayStart + SESSION_OPEN_MINUTES * 60_000;
  if (time < open) return time - (time % intervalMs);
  return open + Math.floor((time - open) / intervalMs) * intervalMs;
}

function samePeriod(a: number, b: number, interval: ChartInterval) {
  if (interval === "1d") return istDayNumber(a) === istDayNumber(b);
  if (interval === "1w") {
    const monday = (time: number) => istDayNumber(time) - ((istClock(time).weekday + 6) % 7);
    return monday(a) === monday(b);
  }
  const pa = istClock(a);
  const pb = istClock(b);
  return pa.year === pb.year && pa.month === pb.month;
}

/**
 * Fold a tick into the series' last bar. Returns the bar to upsert, or null if
 * the tick is stale. `volumeDelta` is the change in cumulative day volume since
 * the previous tick (0 for the first tick we see).
 */
export function applyTick(last: Bar, tick: LiveTick, interval: ChartInterval, volumeDelta: number): Bar | null {
  const meta = INTERVAL_META[interval];
  const time = tick.ltt || tick.ts || Date.now();
  const price = tick.ltp;

  if (meta.intraday) {
    // Pre-open ticks belong to no bar; post-close ticks (closing price
    // updates) fold into the session's last bar instead of opening a new one.
    const dayStart = istDayNumber(time) * DAY_MS - IST_OFFSET_MS;
    const minutes = (time - dayStart) / 60_000;
    if (minutes < SESSION_OPEN_MINUTES) return null;
    const sessionTime = minutes >= SESSION_CLOSE_MINUTES ? dayStart + SESSION_CLOSE_MINUTES * 60_000 - 1 : time;
    const bucket = intradayBucket(sessionTime, meta.ms);
    if (bucket < last.time) return null;
    if (bucket === last.time) {
      return {
        ...last,
        high: Math.max(last.high, price),
        low: Math.min(last.low, price),
        close: price,
        volume: last.volume + volumeDelta,
      };
    }
    return { time: bucket, open: price, high: price, low: price, close: price, volume: volumeDelta };
  }

  if (time < last.time) return null;
  if (samePeriod(time, last.time, interval)) {
    if (interval === "1d" && tick.high > 0 && tick.low > 0) {
      // The tick carries the exchange's own day OHLC/volume — use it verbatim.
      return {
        ...last,
        high: Math.max(last.high, tick.high),
        low: Math.min(last.low, tick.low),
        close: price,
        volume: tick.volume > 0 ? tick.volume : last.volume + volumeDelta,
      };
    }
    return {
      ...last,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
      volume: last.volume + volumeDelta,
    };
  }

  // New daily/weekly/monthly bar: keep the history's timestamp convention by
  // offsetting from the last bar by whole IST days.
  const days = istDayNumber(time) - istDayNumber(last.time);
  return { time: last.time + days * DAY_MS, open: price, high: price, low: price, close: price, volume: volumeDelta };
}
