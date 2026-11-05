// The market stream: one live price pipeline for the whole app, whatever the
// source. Consumers (browser tabs over SSE, the high/low scanner) subscribe to
// symbols and get the same Tick events either way:
//   - from a source's live socket, when one is available and has room;
//   - otherwise by polling quotes through the data engine and turning changes
//     into ticks (marked `polled`) — so the app keeps updating with no socket,
//     past the socket's symbol limit, or with a source that has no socket.
//
// A watchdog keeps it honest during market hours. A socket can look connected
// and still go quiet (expired token, a reconnect that gave up, a half-open
// connection). When the socket has sent nothing for a minute it is restarted,
// and meanwhile its symbols are polled so prices keep moving; a single symbol
// that stops ticking is polled too. When ticks resume, polling stops.
//
// No server-only imports: unit-tested with fake sources and a fake clock.

import { isMarketOpen } from "@/core/market/session";
import type { StreamStatus, Tick } from "@/contracts/api";
import type { DataEngine } from "./engine";
import type { DataSource, SourceTick } from "./types";

export interface MarketStreamOptions {
  /** How often polled symbols are refreshed (ms). */
  pollMs?: number;
  /** How often the watchdog runs (ms). */
  watchMs?: number;
  /** A socket silent this long during market hours is restarted (ms). */
  staleMs?: number;
  /** A symbol on the socket with no tick for this long during market hours is polled too (ms). */
  symbolStaleMs?: number;
  /** At most one socket restart per this long (ms). */
  restartEveryMs?: number;
  isMarketOpen?: (now: number) => boolean;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  log?: (message: string) => void;
  /** Wraps the quote calls polling makes (e.g. to charge them to a lower API-budget priority). */
  runPolling?: <T>(job: () => Promise<T>) => Promise<T>;
}

type Settings = Required<Omit<MarketStreamOptions, "setInterval" | "clearInterval" | "runPolling">> & Pick<MarketStreamOptions, "setInterval" | "clearInterval" | "runPolling">;

export class MarketStream {
  private readonly refCounts = new Map<string, number>();
  /** Symbols subscribed on the live socket. */
  private readonly live = new Set<string>();
  /** When each socket symbol last ticked (or was placed on the socket). */
  private readonly socketSeen = new Map<string, number>();
  private readonly latest = new Map<string, Tick>();
  private readonly listeners = new Set<(tick: Tick) => void>();
  private feed: DataSource | null = null;
  private detachFeed: (() => void) | null = null;
  /** First source with live quotes that can serve now (what polling uses), refreshed on each check. */
  private pollSource: string | null = null;
  /** Last tick from the socket, or when it was (re)started — whichever is later. */
  private feedHeardAt = 0;
  private lastRestartAt = 0;
  private lastPollAt = 0;
  private timer: unknown = null;
  private pollJob: Promise<void> | null = null;
  private readonly o: Settings;

  constructor(
    private readonly engine: DataEngine,
    options: MarketStreamOptions = {},
  ) {
    this.o = {
      pollMs: options.pollMs ?? 15_000,
      watchMs: options.watchMs ?? 5_000,
      staleMs: options.staleMs ?? 60_000,
      symbolStaleMs: options.symbolStaleMs ?? 180_000,
      restartEveryMs: options.restartEveryMs ?? 60_000,
      isMarketOpen: options.isMarketOpen ?? ((now) => isMarketOpen(now)),
      now: options.now ?? Date.now,
      log: options.log ?? ((message) => console.warn(message)),
      setInterval: options.setInterval,
      clearInterval: options.clearInterval,
      runPolling: options.runPolling,
    };
  }

  /** Every tick for every subscribed symbol. Returns an unsubscribe function. */
  onTick(listener: (tick: Tick) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getLatest(symbols: string[]): Tick[] {
    return symbols.flatMap((symbol) => {
      const tick = this.latest.get(symbol.toUpperCase());
      return tick ? [tick] : [];
    });
  }

  /**
   * Add a consumer for these symbols, in priority order (earlier ones get the
   * socket's limited slots first). Pass the same list to `unsubscribe` later.
   */
  async subscribe(symbols: string[]): Promise<StreamStatus> {
    const wanted = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
    const fresh: string[] = [];
    for (const symbol of wanted) {
      const count = this.refCounts.get(symbol) ?? 0;
      this.refCounts.set(symbol, count + 1);
      if (count === 0) fresh.push(symbol);
    }
    await this.ensureFeed();
    await this.placeOnSocket(fresh);
    this.startWatching();
    if (this.polledSymbols().length) void this.pollOnce().catch(() => {});
    return this.status(wanted);
  }

  unsubscribe(symbols: string[]) {
    const dropLive: string[] = [];
    for (const raw of new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))) {
      const count = (this.refCounts.get(raw) ?? 0) - 1;
      if (count > 0) {
        this.refCounts.set(raw, count);
        continue;
      }
      this.refCounts.delete(raw);
      this.socketSeen.delete(raw);
      if (this.live.delete(raw)) dropLive.push(raw);
    }
    if (dropLive.length && this.feed?.stream) {
      try {
        this.feed.stream.unsubscribe(dropLive);
      } catch {
        // best-effort
      }
    }
    if (!this.refCounts.size) this.stopWatching();
  }

  /** How these symbols (or all subscribed ones) are being fed right now. */
  status(symbols?: string[]): StreamStatus {
    const list = symbols ?? [...this.refCounts.keys()];
    const polledNow = new Set(this.polledSymbols());
    const live = list.filter((symbol) => this.live.has(symbol) && !polledNow.has(symbol));
    const polled = list.filter((symbol) => !live.includes(symbol));
    const pollSource = this.pollSource;
    const mode: StreamStatus["mode"] = live.length && !polled.length ? "live" : polled.length && pollSource ? "polling" : live.length ? "live" : "offline";
    return { mode, source: live.length ? (this.feed?.id ?? null) : pollSource, live, polled };
  }

  /** Refresh polled symbols once; if a poll is already running, wait for that one. */
  pollOnce(): Promise<void> {
    this.pollJob ??= this.poll().finally(() => {
      this.pollJob = null;
    });
    return this.pollJob;
  }

  /** One watchdog pass (the timer calls this every `watchMs`; exposed for tests). */
  async check() {
    if (!this.refCounts.size) return;
    const now = this.o.now();
    const stream = this.feed?.stream;
    if (stream && this.live.size && this.o.isMarketOpen(now) && this.socketQuiet(now) && now - this.lastRestartAt >= this.o.restartEveryMs) {
      const silentFor = Math.round((now - this.feedHeardAt) / 1000);
      // Symbols stay polled until the socket actually ticks again; lastRestartAt limits retries.
      this.lastRestartAt = now;
      this.o.log(`Market stream: no ticks from ${this.feed!.id} for ${silentFor} s — reconnecting, polling meanwhile.`);
      try {
        if (stream.restart) await stream.restart(`no ticks for ${silentFor} s`);
        else await stream.start();
      } catch {
        // the next pass tries again
      }
    }
    if (this.polledSymbols().length && this.o.now() - this.lastPollAt >= this.o.pollMs) await this.pollOnce();
  }

  // ------------------------------------------------------------------ internals

  /** The socket is down, or connected but silent for longer than `staleMs`. */
  private socketQuiet(now: number) {
    const stream = this.feed?.stream;
    if (!stream) return false;
    return !stream.isConnected() || now - this.feedHeardAt > this.o.staleMs;
  }

  /** Subscribed symbols to poll: not on the socket, or (market hours) on a quiet socket or not ticking. */
  private polledSymbols() {
    const now = this.o.now();
    const marketOpen = this.o.isMarketOpen(now);
    const quiet = marketOpen && this.socketQuiet(now);
    return [...this.refCounts.keys()].filter((symbol) => {
      if (!this.live.has(symbol)) return true;
      if (!marketOpen) return false;
      return quiet || now - (this.socketSeen.get(symbol) ?? 0) > this.o.symbolStaleMs;
    });
  }

  private async poll() {
    this.lastPollAt = this.o.now();
    // A socket that (re)connected takes over polled symbols it has room for.
    await this.ensureFeed();
    await this.placeOnSocket([...this.refCounts.keys()].filter((symbol) => !this.live.has(symbol)));
    const polled = this.polledSymbols();
    if (!polled.length) return;
    const fetch = () => this.engine.quotes(polled, { maxAgeMs: Math.max(1_000, this.o.pollMs - 1_000) });
    const quotes = await (this.o.runPolling ? this.o.runPolling(fetch) : fetch());
    for (const quote of quotes) {
      if (quote.delayed) continue; // end-of-day closes aren't ticks
      const previous = this.latest.get(quote.symbol);
      if (previous && previous.ltp === quote.ltp && previous.high === quote.high && previous.low === quote.low && previous.volume === quote.volume) continue;
      const now = this.o.now();
      this.emit({ ...quote, ltt: now, ts: now, source: quote.source ?? "unknown", polled: true });
    }
  }

  /** Pick the first source with a live socket that can connect now (and note which can be polled). */
  private async ensureFeed() {
    let pollSource: string | null = null;
    for (const source of this.engine.sources) {
      if (source.quotes && !source.quotes.delayed && !(await this.engine.unavailable(source))) {
        pollSource = source.id;
        break;
      }
    }
    this.pollSource = pollSource; // assigned once, so a concurrent status() never sees it half-checked
    if (this.feed?.stream?.isConnected()) return;
    for (const source of this.engine.sources) {
      if (!source.stream || (await this.engine.unavailable(source))) continue;
      let started = false;
      try {
        started = await source.stream.start();
      } catch {
        started = false;
      }
      if (!started) continue;
      if (this.feed !== source) {
        this.detachFeed?.();
        this.live.clear();
        this.socketSeen.clear();
        this.feed = source;
        this.feedHeardAt = this.o.now();
        this.detachFeed = source.stream.onTick((tick) => this.fromFeed(source, tick));
      }
      return;
    }
    // No socket: everything is polled.
    this.live.clear();
  }

  private async placeOnSocket(symbols: string[]) {
    const stream = this.feed?.stream;
    if (!stream?.isConnected() || !symbols.length) return;
    const room = stream.maxSymbols - this.live.size;
    if (room <= 0) return;
    // Highest-priority first: callers subscribe charts before watchlist rows.
    const accepted = await stream.subscribe(symbols.slice(0, room));
    const now = this.o.now();
    for (const symbol of accepted) {
      const key = symbol.toUpperCase();
      this.live.add(key);
      this.socketSeen.set(key, now); // grace period before it counts as silent
    }
  }

  private fromFeed(source: DataSource, tick: SourceTick) {
    const symbol = tick.symbol.toUpperCase();
    const now = this.o.now();
    this.feedHeardAt = now;
    if (!this.refCounts.has(symbol)) return;
    this.socketSeen.set(symbol, now);
    this.emit({ ...tick, symbol, source: source.id });
  }

  private emit(tick: Tick) {
    this.latest.set(tick.symbol, tick);
    for (const listener of this.listeners) {
      try {
        listener(tick);
      } catch {
        // one broken consumer must not stop the others
      }
    }
  }

  private startWatching() {
    if (this.timer) return;
    const set = this.o.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    this.timer = set(() => void this.check().catch(() => {}), this.o.watchMs);
  }

  private stopWatching() {
    if (!this.timer) return;
    const clear = this.o.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
    clear(this.timer);
    this.timer = null;
  }
}
