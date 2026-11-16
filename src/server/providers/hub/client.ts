import type { HubConfig } from "./config";

// A small typed client for the Market Data Hub's /v1 API
// (github.com/ice-009/market-data-hub, docs/api.md).
//
//  - Every request carries `Authorization: Bearer <HUB_KEY>` and a timeout.
//  - 429 and 502/503/504 answers, and network errors, are retried with
//    exponential back-off, waiting what the hub's Retry-After asks for — but
//    never longer than `maxRetryWaitMs` (a chart shouldn't hang for a minute):
//    beyond that the error is returned at once.
//  - The key lives in a private field and is scrubbed from every error message,
//    so neither `console.log(client)` nor a logged error can print it.
//
// No server-only import: unit-tested with a fake fetch and a local server.

// ------------------------------------------------------------------ hub shapes

/** A candle: `t` epoch ms (daily bars at UTC midnight of the IST trade date). `dp` = delivery %. */
export interface HubCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  dp?: number | null;
}

export type HubTimeframe = "1d" | "1w" | "1h" | "15m" | "5m" | "1m";

export interface HubCandles {
  symbol: string;
  tf: HubTimeframe;
  from: number;
  to: number;
  complete: boolean;
  coverage: { from: number; to: number } | null;
  liveThrough?: number | null;
  candles: HubCandle[];
  /** Set by this client: the hub answered 503 with what it has stored (broker unavailable, or still fetching). */
  partial?: { code: string; reason: string | null; message: string };
}

/** A live quote (a tick) as the hub serves it. */
export interface HubQuote {
  symbol: string;
  ltp: number;
  ch: number;
  chp: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  ltt: number;
  ts: number;
  source: "socket" | "poll" | "store" | string;
  ageMs?: number;
  stale?: boolean;
}

export interface HubQuotes {
  quotes: HubQuote[];
  missing: string[];
  warning?: string;
  reason?: string;
}

/** The live feed's state (SSE `status` event, and `live.feed` in /v1/status). */
export interface HubFeedStatus {
  mode: "socket" | "polling" | "mixed" | "idle" | "down" | string;
  socket?: string;
  socketSymbols?: number;
  polledSymbols?: number;
  capacity?: number;
  lastTickAt?: number | null;
  reconnects?: number;
}

export interface HubBudget {
  plan: "standard" | "prime" | string;
  usedToday: number;
  dayCap: number;
  usedThisMinute: number;
  minuteCap: number;
  byPriority?: Record<string, number>;
  strikes: number;
  slowed?: boolean;
  coolingDown?: boolean;
  stoppedForToday?: boolean;
}

/** One dataset's freshness in /v1/status `data` (cash and F&O bhavcopy, lots, ban list, results calendar). */
export interface HubDataset {
  lastSession?: string | null;
  tradeDate?: string | null;
  lastSuccessAt?: number | null;
  lastAttemptAt?: number | null;
  lastError?: string | null;
  count?: number;
  events?: number;
  source?: string;
}

export interface HubStatus {
  /** Health first: `problems` are worth an alert, `warnings` worth knowing. */
  healthy?: boolean;
  problems?: string[];
  warnings?: string[];
  service: string;
  version: string;
  uptimeSec?: number;
  key?: { name: string; scopes: string[] };
  broker: { configured: boolean; connected: boolean; ownsConnection?: boolean; lastLoginError?: string | null; budget?: HubBudget };
  data?: {
    dbBytes?: number;
    cashBhav?: HubDataset;
    foBhav?: HubDataset;
    lots?: HubDataset;
    foBan?: HubDataset;
    resultsCalendar?: HubDataset;
    candles?: Array<{ tf: string; series: number; candles: number; lastSession?: string | null }>;
  };
  live?: { enabled: boolean; running: boolean; feed?: HubFeedStatus & { pollingStopped?: string | null } };
}

/** One symbol's series in a batch answer. */
export interface HubBatchSeries {
  /** Every final bar of the (clamped) range is stored. */
  complete: boolean;
  coverage: { from: number; to: number } | null;
  candles: HubCandle[];
}

/** GET /v1/candles/batch: many symbols' daily or weekly bars in one request. */
export interface HubCandlesBatch {
  tf: "1d" | "1w";
  from: number;
  to: number;
  series: Record<string, HubBatchSeries>;
  /** Incomplete symbols the hub is now fetching in the background: ask again later. */
  queued: string[];
  /** Malformed symbols, and ones the broker doesn't know: no `series` entry. */
  unknown: string[];
  /** Set (still 200) when the hub's broker can't be used: nothing was queued. */
  warning?: string;
  reason?: string;
}

/** One leg (month) of a stock's futures on a trade day. Expiry is YYYY-MM-DD. */
export interface HubOiLeg {
  expiry: string;
  close: number;
  settle: number;
  prevClose: number;
  /** Contracts. */
  volume: number;
  /** Shares. */
  oi: number;
  chgOi: number;
}

/** A stock's futures on one trade day (the /v1/fo/oi item shape, plus its symbol). */
export interface HubOiRow {
  symbol: string;
  date: string;
  /** UTC midnight of the trade date, ms. */
  day: number;
  nseSymbol?: string;
  expiries?: number;
  lot?: number | null;
  underlying?: number | null;
  near: HubOiLeg;
  next?: HubOiLeg | null;
  /** Open interest combined across listed months, and its change (sum of each month's change). */
  oi: number;
  chgOi: number;
  oiChangePct?: number | null;
  pricePct?: number | null;
  buildup?: string | null;
  basisPct?: number | null;
}

/** GET /v1/fo/oi/day: every stock's futures on one trade day (the newest stored by default). */
export interface HubOiDay {
  date: string;
  day: number;
  rows: HubOiRow[];
}

/** GET /v1/fo/members?from&to: the F&O list on every stored trade day in the range. */
export interface HubMembers {
  from: string;
  to: string;
  days: Array<{ date: string; day: number; symbols: string[] }>;
}

/** GET /v1/fo/contracts?symbol: a stock's listed futures, as hub tickers (e.g. SBIN26NOVFUT). */
export interface HubContracts {
  symbol: string;
  asOf: string | null;
  lot: number | null;
  contracts: Array<{ ticker: string; expiry: string; kind: "near" | "next" | string }>;
}

export interface HubUniverse {
  name: string;
  source: string;
  asOf: string | null;
  count: number;
  members: Array<{ symbol: string; name: string; industry: string }>;
}

export interface HubLots {
  source: string;
  fetchedAt: number;
  count: number;
  lots: Record<string, number>;
}

export interface HubFoBan {
  /** YYYY-MM-DD */
  tradeDate: string | null;
  symbols: string[];
  fetchedAt: number;
  current: boolean;
}

export interface HubResultsCalendar {
  from: string;
  to: string;
  fetchedAt: number;
  events: Array<{ symbol: string; date: string; day: number; company: string; purpose: string }>;
}

// ------------------------------------------------------------------ errors

/** A failed hub request. `status` is 0 for network errors and timeouts. The message never contains the key. */
export class HubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryAfterMs: number | null = null,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "HubError";
  }
}

// ------------------------------------------------------------------ client

export interface HubClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Extra attempts after the first (default 2). */
  retries?: number;
  /** Longest wait before a retry; a longer Retry-After fails at once (default 10 s). */
  maxRetryWaitMs?: number;
  /** First back-off without a Retry-After (doubles each attempt, default 500 ms). */
  backoffMs?: number;
}

export interface RequestOptions {
  retries?: number;
  maxRetryWaitMs?: number;
  signal?: AbortSignal;
  /** Return this non-2xx body instead of failing (e.g. a 503 that still carries stored candles). */
  acceptPartial?: (status: number, body: unknown) => boolean;
}

/** Most symbols the hub takes in one quotes or stream request. */
export const HUB_MAX_SYMBOLS = 100;
/** Most symbols in one /v1/candles/batch request. */
export const HUB_BATCH_SYMBOLS = 300;
/** Most days in one /v1/fo/members range request. */
export const HUB_MEMBER_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_BACKOFF_MS = 8_000;

/** Retry-After as ms: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export class HubClient {
  readonly url: string;
  readonly timeoutMs: number;
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #retries: number;
  readonly #maxRetryWaitMs: number;
  readonly #backoffMs: number;

  constructor(config: HubConfig, options: HubClientOptions = {}) {
    this.url = config.url;
    this.timeoutMs = config.timeoutMs;
    this.#key = config.key;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#retries = options.retries ?? 2;
    this.#maxRetryWaitMs = options.maxRetryWaitMs ?? 10_000;
    this.#backoffMs = options.backoffMs ?? 500;
  }

  /** `text` with the key replaced, for anything that may end up in a log. */
  scrub(text: string): string {
    return this.#key ? text.split(this.#key).join("[hub key]") : text;
  }

  /** Never print the key, whatever logs this object. */
  toJSON() {
    return { url: this.url, timeoutMs: this.timeoutMs };
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `HubClient(${this.url})`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.#key}`, Accept: "application/json", ...extra };
  }

  private href(path: string, query?: Record<string, string | number | undefined>): string {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query ?? {})) if (value !== undefined && value !== "") params.set(name, String(value));
    const search = params.toString();
    return `${this.url}${path}${search ? `?${search}` : ""}`;
  }

  private backoff(attempt: number) {
    return Math.min(MAX_BACKOFF_MS, this.#backoffMs * 2 ** attempt);
  }

  /** GET a JSON endpoint, with timeout and retries (see the file comment). */
  async get<T>(path: string, query?: Record<string, string | number | undefined>, options: RequestOptions = {}): Promise<T> {
    const retries = options.retries ?? this.#retries;
    const maxWait = options.maxRetryWaitMs ?? this.#maxRetryWaitMs;
    const href = this.href(path, query);
    for (let attempt = 0; ; attempt += 1) {
      let error: HubError;
      let retryable: boolean;
      let waitMs: number;
      try {
        const signals = [AbortSignal.timeout(this.timeoutMs), ...(options.signal ? [options.signal] : [])];
        const response = await this.#fetch(href, { headers: this.headers(), cache: "no-store", signal: AbortSignal.any(signals) });
        const text = await response.text();
        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = null;
        }
        if (response.ok) {
          if (body === null) throw new HubError(`Market Data Hub ${response.status}: not a JSON answer from ${path}`, response.status, "bad_response");
          return body as T;
        }
        if (options.acceptPartial?.(response.status, body)) return body as T;
        const info = (body ?? {}) as { error?: unknown; code?: unknown };
        const code = typeof info.code === "string" ? info.code : "http_error";
        const detail = typeof info.error === "string" ? info.error : response.statusText || "request failed";
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        error = new HubError(this.scrub(`Market Data Hub ${response.status} ${code}: ${detail}`), response.status, code, retryAfterMs, body);
        retryable = RETRYABLE.has(response.status);
        waitMs = retryAfterMs ?? this.backoff(attempt);
      } catch (caught) {
        if (caught instanceof HubError) throw caught;
        if (options.signal?.aborted) throw caught;
        const cause = (caught as { cause?: { code?: string } }).cause?.code;
        const timedOut = (caught as Error).name === "TimeoutError";
        const what = timedOut ? `timed out after ${this.timeoutMs} ms` : `${(caught as Error).message}${cause ? ` (${cause})` : ""}`;
        error = new HubError(this.scrub(`Market Data Hub network error: ${what} (${path})`), 0, timedOut ? "timeout" : "network");
        retryable = true;
        waitMs = this.backoff(attempt);
      }
      if (!retryable || attempt >= retries || waitMs > maxWait) throw error;
      await this.#sleep(waitMs);
    }
  }

  /**
   * Open the price stream (Server-Sent Events). Resolves once the hub has answered
   * with 200; the caller reads `response.body`. `signal` closes it. The timeout
   * covers only the wait for the answer, not the (endless) stream.
   */
  async openStream(symbols: string[], lastEventId: string | undefined, signal: AbortSignal): Promise<Response> {
    const connect = new AbortController();
    const abort = () => connect.abort(signal.reason);
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => connect.abort(new Error(`timed out after ${this.timeoutMs} ms`)), this.timeoutMs);
    try {
      const response = await this.#fetch(this.href("/v1/stream", { symbols: symbols.join(",") }), {
        headers: this.headers({ Accept: "text/event-stream", ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) }),
        cache: "no-store",
        signal: connect.signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
        const code = body?.code ?? "http_error";
        throw new HubError(this.scrub(`Market Data Hub ${response.status} ${code}: ${body?.error ?? response.statusText}`), response.status, code, parseRetryAfter(response.headers.get("retry-after")), body);
      }
      if (!response.body) throw new HubError("Market Data Hub stream has no body", response.status, "bad_response");
      return response;
    } catch (caught) {
      if (caught instanceof HubError) throw caught;
      throw new HubError(this.scrub(`Market Data Hub network error: ${(caught as Error).message} (/v1/stream)`), 0, "network");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  // ---------------------------------------------------------------- endpoints

  /**
   * Candles from `from` (epoch ms) to now. A 503 that still carries stored candles
   * (broker unavailable, or a fetch still running) comes back with `partial` set
   * instead of failing, without waiting out its Retry-After.
   */
  async candles(symbol: string, tf: HubTimeframe, from: number, options: { signal?: AbortSignal } = {}): Promise<HubCandles> {
    const body = await this.get<HubCandles & { error?: string; code?: string; reason?: string | null }>(
      "/v1/candles",
      { symbol, tf, from: Math.floor(from) },
      { signal: options.signal, acceptPartial: (status, answer) => status === 503 && Array.isArray((answer as { candles?: unknown } | null)?.candles) },
    );
    if (body.code) {
      const { error, code, reason, ...rest } = body;
      return { ...rest, partial: { code, reason: reason ?? null, message: this.scrub(error ?? code) } };
    }
    return body;
  }

  /** Quotes for any number of symbols (asked for in batches of 100). */
  async quotes(symbols: string[]): Promise<HubQuotes> {
    const unique = [...new Set(symbols)];
    const answer: HubQuotes = { quotes: [], missing: [] };
    for (let start = 0; start < unique.length; start += HUB_MAX_SYMBOLS) {
      const part = await this.get<HubQuotes>("/v1/quotes", { symbols: unique.slice(start, start + HUB_MAX_SYMBOLS).join(",") });
      answer.quotes.push(...(part.quotes ?? []));
      answer.missing.push(...(part.missing ?? []));
      if (part.warning) answer.warning = this.scrub(part.warning);
      if (part.reason) answer.reason = part.reason;
    }
    return answer;
  }

  /**
   * Daily or weekly bars for many symbols (plain hub tickers), asked for in
   * batches of 300. Never waits for the broker: symbols the hub doesn't hold in
   * full come back in `queued` (it fetches them in the background: ask again
   * later) with whatever it has stored so far. Series are keyed by hub ticker.
   */
  async candlesBatch(symbols: string[], tf: "1d" | "1w", from: number, to?: number): Promise<HubCandlesBatch> {
    const unique = [...new Set(symbols)];
    const answer: HubCandlesBatch = { tf, from: Math.floor(from), to: to ?? Date.now(), series: {}, queued: [], unknown: [] };
    for (let start = 0; start < unique.length; start += HUB_BATCH_SYMBOLS) {
      const part = await this.get<HubCandlesBatch>("/v1/candles/batch", {
        symbols: unique.slice(start, start + HUB_BATCH_SYMBOLS).join(","),
        tf,
        from: Math.floor(from),
        to: to === undefined ? undefined : Math.floor(to),
      });
      Object.assign(answer.series, part.series ?? {});
      answer.queued.push(...(part.queued ?? []));
      answer.unknown.push(...(part.unknown ?? []));
      if (part.to) answer.to = part.to;
      if (part.warning) answer.warning = this.scrub(part.warning);
      if (part.reason) answer.reason = part.reason;
    }
    return answer;
  }

  /** Every stock's futures on one trade day (YYYY-MM-DD); the newest stored day when omitted. */
  foOiDay(date?: string): Promise<HubOiDay> {
    return this.get<HubOiDay>("/v1/fo/oi/day", { date });
  }

  /** The F&O list on every stored trade day between two dates (epoch ms), asked for in ranges of ≤ 400 days. */
  async foMembers(from: number, to: number): Promise<HubMembers> {
    const answer: HubMembers = { from: isoDay(from), to: isoDay(to), days: [] };
    for (let start = from; start <= to; start += HUB_MEMBER_DAYS * DAY_MS) {
      const end = Math.min(to, start + (HUB_MEMBER_DAYS - 1) * DAY_MS);
      const part = await this.get<HubMembers>("/v1/fo/members", { from: isoDay(start), to: isoDay(end) });
      answer.days.push(...(part.days ?? []));
    }
    return answer;
  }

  /** A stock's listed futures contracts (near and next month) as hub tickers, with the lot size. */
  foContracts(symbol: string): Promise<HubContracts> {
    return this.get<HubContracts>("/v1/fo/contracts", { symbol });
  }

  status(): Promise<HubStatus> {
    return this.get<HubStatus>("/v1/status", undefined, { retries: 0 });
  }

  universe(name: "fno" | "nifty50" | "nifty100" | "nifty200" | "nifty500"): Promise<HubUniverse> {
    return this.get<HubUniverse>(`/v1/universe/${name}`);
  }

  lots(): Promise<HubLots> {
    return this.get<HubLots>("/v1/lots");
  }

  foBan(): Promise<HubFoBan> {
    return this.get<HubFoBan>("/v1/fo/ban");
  }

  /** Results dates between two IST dates (YYYY-MM-DD). */
  resultsCalendar(from: string, to: string): Promise<HubResultsCalendar> {
    return this.get<HubResultsCalendar>("/v1/results-calendar", { from, to });
  }
}
