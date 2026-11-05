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
  /** Kind of source that answered: live broker, end-of-day store, or generated sample. */
  source: SourceKind;
  /** Why a fallback source was used. */
  reason: string | null;
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
  return { bars, source: data.source ?? "sample", reason: data.sourceReason ?? null };
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
  private sourceKey = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  status: LiveStatus = "idle";

  /**
   * Live ticks for `symbol`. The broker streams a limited number of symbols (100 on
   * Fyers Standard), so lower `priority` numbers are kept first: 0 = open charts,
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
      if (this.source && Date.now() - this.lastEventAt > 40_000) this.reconnect(true);
    }, 10_000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.source && Date.now() - this.lastEventAt > 20_000) this.reconnect(true);
    });
  }

  private reconnect(force = false) {
    this.timer = null;
    this.watch();
    const rank = (symbol: string) => Math.min(...(this.priorities.get(symbol)?.values() ?? [Infinity]));
    const symbols = [...this.listeners.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const key = symbols.join(",");
    if (key === this.sourceKey && this.source && !force) return;
    this.source?.close();
    this.source = null;
    this.sourceKey = key;
    if (!symbols.length) {
      this.setStatus("idle");
      return;
    }

    this.setStatus("connecting");
    this.lastEventAt = Date.now();
    const source = new EventSource(`/api/broker/stream?symbols=${encodeURIComponent(key)}`);
    this.source = source;
    source.addEventListener("status", (event) => {
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

/** Start of the intraday bar containing `time`, aligned to the 09:15 IST session open like Fyers. */
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
