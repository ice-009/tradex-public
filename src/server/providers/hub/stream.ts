import type { HubFeedStatus, HubQuote } from "./client";
import { HUB_MAX_SYMBOLS } from "./client";
import { SseParser, type SseEvent } from "./sse";

// One Server-Sent Events connection to the hub's /v1/stream for every symbol
// Tradex wants live, kept open:
//  - when the symbol set changes, the connection is reopened with the new list
//    (changes within `debounceMs` are coalesced into one reconnect);
//  - a dropped or failed connection is reopened with back-off (the hub's
//    `retry:` hint, doubling on repeated failures up to `maxReconnectMs`, or the
//    hub's Retry-After), sending Last-Event-ID so the hub resumes where it left;
//  - a connection that sends nothing — not even the hub's 15-second heartbeat —
//    for `idleMs` is treated as dead and reopened.
//
// No server-only import: unit-tested against a local mock server.

export interface HubStreamListener {
  tick?(quote: HubQuote): void;
  status?(status: HubFeedStatus): void;
  snapshot?(quotes: HubQuote[]): void;
}

export interface HubStreamOptions {
  /** Open the stream for these symbols (HubClient.openStream). */
  open: (symbols: string[], lastEventId: string | undefined, signal: AbortSignal) => Promise<Response>;
  minReconnectMs?: number;
  maxReconnectMs?: number;
  debounceMs?: number;
  idleMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export class HubStream {
  private symbols: string[] = [];
  private running = false;
  private connection: AbortController | null = null;
  private open = false;
  private skipDelay = false;
  private idleTimedOut = false;
  private wakeUp: (() => void) | null = null;
  private resubscribe: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private serverRetryMs: number | null = null;
  private lastHeardAt = 0;
  private readonly listeners = new Set<HubStreamListener>();
  private readonly o: Required<Omit<HubStreamOptions, "open">> & Pick<HubStreamOptions, "open">;
  /** Resume point: the id of the last event received. */
  lastEventId: string | undefined;
  /** Why the last connection failed, or null. */
  lastError: string | null = null;
  /** The hub's feed status from its last `status` event. */
  feed: HubFeedStatus | null = null;
  /** Successful connections so far. */
  connects = 0;

  constructor(options: HubStreamOptions) {
    this.o = {
      open: options.open,
      minReconnectMs: options.minReconnectMs ?? 1_000,
      maxReconnectMs: options.maxReconnectMs ?? 30_000,
      debounceMs: options.debounceMs ?? 250,
      idleMs: options.idleMs ?? 45_000,
      now: options.now ?? Date.now,
      log: options.log ?? ((message) => console.warn(message)),
    };
  }

  on(listener: HubStreamListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Symbols the connection is (or will be) opened with. */
  current(): string[] {
    return [...this.symbols];
  }

  /** Stream these hub symbols (at most 100); reconnects when the set changed. */
  setSymbols(next: string[]) {
    const unique = [...new Set(next)].sort().slice(0, HUB_MAX_SYMBOLS);
    if (unique.length === this.symbols.length && unique.every((symbol, index) => symbol === this.symbols[index])) return;
    this.symbols = unique;
    if (!this.running) {
      this.start();
      return;
    }
    if (this.resubscribe) clearTimeout(this.resubscribe);
    this.resubscribe = setTimeout(() => {
      this.resubscribe = null;
      this.reconnectNow();
    }, this.o.debounceMs);
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  /** Drop the connection and open a fresh one now. */
  restart(reason: string) {
    this.o.log(`Market Data Hub stream: reconnecting (${reason}).`);
    this.failures = 0;
    this.reconnectNow();
  }

  close() {
    this.running = false;
    if (this.resubscribe) clearTimeout(this.resubscribe);
    this.resubscribe = null;
    this.connection?.abort();
    this.wakeUp?.();
  }

  /** A connection is open right now. */
  isOpen() {
    return this.open;
  }

  /** Running, the last attempt didn't fail and the hub's feed isn't down. */
  healthy() {
    return this.running && this.failures === 0 && this.feed?.mode !== "down";
  }

  // ------------------------------------------------------------------ internals

  private reconnectNow() {
    this.skipDelay = true;
    this.connection?.abort();
    this.wakeUp?.();
  }

  private wait(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      this.wakeUp = null;
    });
  }

  private async loop() {
    while (this.running) {
      if (!this.symbols.length) {
        await this.wait(60_000); // woken by setSymbols / close
        continue;
      }
      const controller = new AbortController();
      this.connection = controller;
      let retryAfterMs: number | null = null;
      try {
        const response = await this.o.open(this.symbols, this.lastEventId, controller.signal);
        this.open = true;
        this.connects += 1;
        if (this.failures || this.lastError) this.o.log("Market Data Hub stream: connected.");
        this.failures = 0;
        this.lastError = null;
        await this.read(response, controller);
        if (this.idleTimedOut) throw new Error(`no data for ${Math.round(this.o.idleMs / 1000)} s`);
      } catch (error) {
        if (this.idleTimedOut || !controller.signal.aborted) {
          const message = (error as Error).message || String(error);
          if (message !== this.lastError) this.o.log(`Market Data Hub stream: ${message}`);
          this.lastError = message;
          this.failures += 1;
          retryAfterMs = (error as { retryAfterMs?: number | null }).retryAfterMs ?? null;
        }
      } finally {
        this.idleTimedOut = false;
        this.open = false;
        if (this.connection === controller) this.connection = null;
      }
      if (!this.running) break;
      if (this.skipDelay) {
        this.skipDelay = false;
        continue;
      }
      const base = this.serverRetryMs ?? this.o.minReconnectMs;
      const delay = this.failures ? Math.min(this.o.maxReconnectMs, Math.max(retryAfterMs ?? 0, base * 2 ** (this.failures - 1))) : base;
      await this.wait(delay);
      this.skipDelay = false;
    }
  }

  private async read(response: Response, controller: AbortController) {
    const parser = new SseParser();
    this.lastHeardAt = this.o.now();
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    const cancel = () => void reader.cancel().catch(() => {});
    controller.signal.addEventListener("abort", cancel, { once: true });
    const watchdog = setInterval(
      () => {
        if (this.o.now() - this.lastHeardAt <= this.o.idleMs) return;
        this.idleTimedOut = true;
        controller.abort();
      },
      Math.max(20, Math.min(5_000, this.o.idleMs / 3)),
    );
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.lastHeardAt = this.o.now();
        for (const event of parser.feed(value)) this.dispatch(event);
        if (parser.retryMs !== null) this.serverRetryMs = parser.retryMs;
      }
    } finally {
      clearInterval(watchdog);
      controller.signal.removeEventListener("abort", cancel);
    }
  }

  private dispatch(event: SseEvent) {
    if (event.id !== undefined) this.lastEventId = event.id;
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (event.event === "status") this.feed = data as HubFeedStatus;
    for (const listener of this.listeners) {
      try {
        if (event.event === "tick") listener.tick?.(data as HubQuote);
        else if (event.event === "status") listener.status?.(data as HubFeedStatus);
        else if (event.event === "snapshot") listener.snapshot?.((data as { quotes?: HubQuote[] }).quotes ?? []);
        // "bars" (1-minute replay) isn't used: charts re-read candles, which the hub keeps current to the minute.
      } catch {
        // one broken listener must not stop the others
      }
    }
  }
}
