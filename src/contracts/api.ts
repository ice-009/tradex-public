// The HTTP contract between the backend (src/app/api → src/server) and the
// frontend (src/client → src/terminal). Every JSON body an /api route returns
// is declared here, and both sides import it from here — so changing a
// response is a type error on both ends at once.
//
// Types only: this module has no runtime code and imports only from src/core.

import type { CostModel, CostPresetId } from "@/core/backtest/costs";
import type { BacktestResult, EntryMode } from "@/core/backtest/portfolio";
import type { ChartInterval, ChartRange } from "@/core/market/intervals";
import type { BudgetSnapshot } from "@/core/ratelimit/budget";
import type { ResultsEvent } from "@/core/parsers/resultsCalendar";
import type { HLEvent } from "@/core/scanner/highLow";
import type { TrackReplay } from "@/core/screener/backtest";
import type { LiveScreenRecord, LiveTrade } from "@/core/screener/liveRecord";
import type { EvidenceTable } from "@/core/plan/evidence";
import type { ExitReason, JournalSummary } from "@/core/plan/journal";
import type { TradeTrack } from "@/core/plan/tracker";
import type { StockFacts } from "@/core/screener/score";
import type { MarketOverview, ScreenerRow, TradePlan } from "@/core/screener/screens";
import type { MarketRegime } from "@/core/screener/regime";

export type { ResultsEvent };

/** Body of every failed request (status ≥ 400). */
export interface ApiError {
  error: string;
}

// ------------------------------------------------------------------ GET /api/chart?symbol&interval&range

/** One candle on the wire (date is an ISO string). */
export interface PricePoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** What kind of source data came from: a live broker feed, end-of-day files, or generated sample data. */
export type SourceKind = "broker" | "eod" | "sample";

export interface ChartResponse {
  symbol: string;
  interval: ChartInterval;
  range: ChartRange;
  source: SourceKind;
  /** Id of the data source that answered (e.g. "fyers", "eod", "sample"). */
  sourceId: string | null;
  /** Why a fallback source was used (null when the first-choice source answered). */
  sourceReason: string | null;
  /** Set when no source could answer and sample data wasn't appropriate (the broker is connected but failed): show this instead of a chart. */
  error?: string | null;
  priceSeries: PricePoint[];
}

// ------------------------------------------------------------------ GET /api/quotes?symbols=A,B

export interface Quote {
  symbol: string;
  ltp: number;
  ch: number;
  chp: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  /** Id of the data source that answered (e.g. "fyers", "eod"). */
  source?: string;
  /** Not a live price (e.g. the last end-of-day close): never fire alerts or compute a basis from it. */
  delayed?: boolean;
}

export interface QuotesResponse {
  quotes: Quote[];
}

// ------------------------------------------------------------------ GET /api/broker/stream?symbols=A,B (Server-Sent Events)

/** One live price update, the same shape whichever source produced it. Sent as SSE event "tick". */
export interface Tick {
  symbol: string;
  ltp: number;
  ch: number;
  chp: number;
  /** Cumulative volume for the day. */
  volume: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  /** Last traded time, epoch ms. */
  ltt: number;
  /** Feed time, epoch ms. */
  ts: number;
  /** Id of the source that produced it. */
  source: string;
  /** Built from polled quotes rather than a live socket (updates every few seconds). */
  polled?: boolean;
}

/** SSE event "status": how the requested symbols are being fed. */
export interface StreamStatus {
  /** live = a socket streams them; polling = quotes are polled and sent as ticks; offline = no source. */
  mode: "live" | "polling" | "offline";
  /** Source id streaming or being polled. */
  source: string | null;
  /** Symbols on the live socket. */
  live: string[];
  /** Symbols fed by polling (no socket, or beyond the socket's symbol limit). */
  polled: string[];
}

// ------------------------------------------------------------------ GET /api/symbols?q=

export interface SymbolInfo {
  /** App symbol, e.g. "RELIANCE" / "NIFTY". */
  symbol: string;
  name: string;
  exchange: "NSE" | "BSE";
  type: "stock" | "index";
}

export interface SymbolsResponse {
  results: SymbolInfo[];
}

// ------------------------------------------------------------------ GET /api/screener?universe

export interface SyncProgressDto {
  phase: string;
  done: number;
  total: number;
  message: string;
}

export interface ScreenerResponse {
  status: "syncing" | "ready" | "error";
  error?: string;
  syncing?: boolean;
  progress?: SyncProgressDto;
  universe?: { id: string; label?: string; count: number; covered: number };
  asOf?: {
    eodDate: number;
    live: boolean;
    computedAt: number;
    /** When the live quotes behind this run were fetched (null outside market hours or without a broker). */
    quotesAt?: number | null;
    /** How often live quotes are refreshed right now (budget-paced). */
    paceMs?: number | null;
    /** Stocks whose live bar came from a stream tick newer than the quotes. */
    fromTicks?: number;
    /** Market hours, but no live prices: screens are running on the last close. */
    stale?: boolean;
  };
  results?: Record<string, ScreenerRow[]>;
  market?: MarketOverview;
  /** Is it a good time for long setups? NIFTY trend + breadth (src/core/screener/regime.ts). */
  regime?: MarketRegime;
  /** NSE's F&O ban list for today (best-effort; available=false when NSE couldn't be reached). */
  ban?: { available: boolean; tradeDate: number | null; symbols: string[] };
}

// ------------------------------------------------------------------ GET /api/screener/track?universe

export type TrackResponse = { status: "ready"; error?: undefined; universe: string } & TrackReplay;
export type TrackErrorResponse = { status: "error"; error: string; universe?: string };
/** Either a replay or an error; the replay fields are optional so callers can read them uniformly. */
export type TrackResult = TrackResponse | (TrackErrorResponse & Partial<TrackReplay>);

// ------------------------------------------------------------------ GET /api/screener/live-record

/** What the BTST setups did live, recorded at 3:10–3:25 PM and settled at the next open — no hindsight. */
export interface LiveRecordResponse {
  /** Per overnight (BTST) screen. */
  screens: Record<string, LiveScreenRecord>;
  /** Latest settled trades, newest first (up to 30). */
  recent: LiveTrade[];
  /** Trade days the recorder has watched the window. */
  days: number;
  /** The cost model behind the net returns. */
  costs: { preset: CostPresetId; label: string };
}

// ------------------------------------------------------------------ GET /api/plan/evidence

/**
 * Which screens have an edge, per market state (NIFTY above / below its 200-day
 * average), from replaying them over the stored daily history (up to 5 years).
 * Computed in the background: "computing" until the first table is ready.
 */
export type EvidenceResponse =
  | { status: "computing"; error?: undefined; startedAt: number; progress: { done: number; total: number } }
  | {
      status: "ready";
      error?: undefined;
      table: EvidenceTable;
      computedAt: number;
      /** How long the replay took. */
      ms: number;
      /** A newer table (a new session was stored) is being computed; this one is still valid until then. */
      updating: boolean;
      /** Which F&O list decided membership (point-in-time or today's). */
      universeNote: string;
      /** The cost model behind the net R, and what one round trip costs. */
      costs: { preset: CostPresetId; label: string; roundTripPct: number };
      /** The BTST live record per overnight screen (null when it couldn't be read). */
      live: Record<string, LiveScreenRecord> | null;
    }
  | { status: "error"; error: string };

// ------------------------------------------------------------------ /api/trades (the trade journal)

/** One trade you took from the plan. Long only for now. */
export interface TradeDto {
  id: string;
  symbol: string;
  screenId: string;
  side: "long";
  /** The plan when you took it. */
  plannedEntry: number;
  stop: number;
  target: number | null;
  /** See ExitRule in src/core/plan/instructions.ts ("next-open", "stop-target", "time", "trail-low:10"). */
  exitRule: string;
  holdSessions: number;
  /** Your fill. */
  entryPrice: number;
  /** Epoch ms of the entry, and its IST session (day key). */
  entryAt: number;
  entryDay: number;
  lots: number;
  lotSize: number;
  quantity: number;
  status: "open" | "closed";
  exitPrice: number | null;
  exitAt: number | null;
  exitReason: ExitReason | null;
  /** What the plan would have exited at (for slippage). */
  plannedExit: number | null;
  notes: string | null;
  createdAt: number;
}

export interface TradesResponse {
  trades: TradeDto[];
  /** Per open trade: session of the hold, R at the last stored close, today's action (the browser re-checks it on live prices). */
  tracks: Record<string, TradeTrack>;
  /** Closed trades only. */
  journal: JournalSummary;
}

/** POST /api/trades: "I took it". */
export interface TradeCreateRequest {
  symbol: string;
  screenId: string;
  plannedEntry: number;
  stop: number;
  target: number | null;
  exitRule: string;
  holdSessions: number;
  entryPrice: number;
  /** Epoch ms; default now. */
  entryAt?: number;
  lots: number;
  lotSize: number;
  notes?: string | null;
}

/** PATCH /api/trades/:id: fix a fill, the size, the stop or the notes. */
export type TradeUpdateRequest = Partial<Pick<TradeCreateRequest, "entryPrice" | "entryAt" | "lots" | "stop" | "target" | "notes">>;

/** POST /api/trades/:id/close */
export interface TradeCloseRequest {
  exitPrice: number;
  /** Epoch ms; default now. */
  exitAt?: number;
  reason: ExitReason;
  notes?: string | null;
}

// ------------------------------------------------------------------ GET /api/backtest?universe

/** What a backtest can run on: the stored daily history of a universe. */
export interface BacktestInfoResponse {
  universe: string;
  label?: string;
  /** Stocks in the universe / with stored history. */
  symbols: number;
  covered: number;
  /** Stored sessions (null when nothing is stored). */
  history: { from: number; to: number; sessions: number; dates: number[] } | null;
  /** First session with enough warm-up (60 sessions) for any signal; most screens need more. */
  warmupDate: number | null;
}

// ------------------------------------------------------------------ POST /api/backtest

export interface BacktestRequest {
  universe: string;
  screenIds: string[];
  /** Period (session day keys); null = all stored history the screens can use. */
  from: number | null;
  to: number | null;
  /** Holding period in sessions for every screen; null = each screen's default. */
  holdBars: number | null;
  capital: number;
  riskPct: number;
  maxPositions: number;
  /** Total open notional ≤ equity × this. */
  maxLeverage: number;
  entry: EntryMode;
  costPreset: CostPresetId;
  /** Overrides the preset's slippage. */
  slippage?: CostModel["slippage"];
  /** "lots": whole futures lots (NSE lot file); "shares": whole shares. */
  sizing: "lots" | "shares";
  /** Out-of-sample share at the end of the period, e.g. 0.3. */
  oosFraction: number;
}

export type BacktestResponse =
  | {
      status: "ready";
      error?: undefined;
      universe: string;
      /** Stocks the scan covered. */
      symbols: number;
      result: BacktestResult;
      /** Cost model actually used (preset + overrides). */
      costs: CostModel;
      runtime: { scanMs: number; simMs: number; scanCached: boolean; cached: boolean };
    }
  | { status: "error"; error: string };

// ------------------------------------------------------------------ GET /api/analyze?symbols=A,B

export interface AnalyzedStock {
  symbol: string;
  name: string;
  industry: string;
  /** No cached daily history for this symbol (not in a scanned universe yet). */
  missing?: boolean;
  live?: boolean;
  date?: number;
  close?: number;
  changePct?: number;
  facts?: StockFacts;
  /** Plan read off the chart (pattern levels, else support / resistance). */
  plan?: TradePlan;
  warnings?: string[];
}

export interface AnalyzeResponse {
  stocks: AnalyzedStock[];
}

// ------------------------------------------------------------------ GET /api/universe/presets

export interface PresetList {
  id: string;
  name: string;
  group: "fno-sector" | "curated" | "index";
  symbols: string[];
}

export interface PresetsResponse {
  presets: PresetList[];
}

// ------------------------------------------------------------------ GET /api/results

export interface ResultsResponse {
  /** False when NSE couldn't be reached (the calendar is best-effort). */
  available: boolean;
  fetchedAt: number;
  events: ResultsEvent[];
}

// ------------------------------------------------------------------ GET /api/highlow?after=seq

export type ScanStatus = "live" | "closed" | "no-broker" | "starting";

export interface HighLowResponse {
  status: ScanStatus;
  /** IST trading day the sequence belongs to; a new day restarts `seq`. */
  day: number;
  seq: number;
  instruments: number;
  lastPollAt: number;
  /** How often the full sweep runs right now (paced by the API budget); null when not sweeping or the budget is spent. */
  sweepMs: number | null;
  totals: { highs: number; lows: number };
  /** Events with seq > `after`, oldest first. */
  events: HLEvent[];
}

// ------------------------------------------------------------------ GET /api/lots

export interface LotsResponse {
  lots: Record<string, number>;
  source: "nse" | "fyers" | "disk" | "none";
  fetchedAt: number;
}

// ------------------------------------------------------------------ GET /api/broker/usage

/** Fyers Data API calls spent today and in the last minute, against our self-imposed caps. */
export type ApiUsageResponse = BudgetSnapshot & { plan: "standard" | "prime"; /** Paused after a 429. */ coolingDown: boolean };

// ------------------------------------------------------------------ GET /api/data/sources

export interface DataSourceStatus {
  id: string;
  label: string;
  kind: SourceKind;
  /** What it can serve. */
  provides: Array<"history" | "quotes" | "stream">;
  /** Null when ready; otherwise why it's skipped (not connected, resting after errors). */
  unavailable: string | null;
  /** Last error and when it may be tried again. */
  lastError: string | null;
  restingUntil: number | null;
}

export interface DataSourcesResponse {
  /** In the order they're tried. */
  sources: DataSourceStatus[];
  stream: { mode: StreamStatus["mode"]; source: string | null; live: number; polled: number };
}

// ------------------------------------------------------------------ GET/POST /api/data/history-db

export type HistoryKind = "daily" | "m15";

/** The local market-data database and the "Download F&O history" job. */
export interface HistoryDbStatus {
  job: {
    state: "idle" | "running" | "paused" | "done" | "error";
    kinds: HistoryKind[];
    /** Series downloaded / to download in this run. */
    done: number;
    total: number;
    /** Symbols that failed in this run (no data, or a broker error). */
    failed: string[];
    current: string | null;
    message: string;
    startedAt: number | null;
    finishedAt: number | null;
  };
  /** How many of the F&O stocks + indices are stored, per kind. */
  coverage: Array<{ kind: HistoryKind; label: string; covered: number; total: number; missing: number; estimatedCalls: number }>;
  db: { series: number; candles: number; bytes: number; path: string };
  /** Broker calls background work may still make today (Fyers budget). */
  backgroundCallsLeft: number | null;
  brokerConnected: boolean;
  /** The NSE F&O bhavcopy import (free: NSE's public archive, no broker calls). */
  fo: FoBhavStatus;
}

/** Stock-futures OI and point-in-time F&O membership from NSE's daily F&O bhavcopy. */
export interface FoBhavStatus {
  job: {
    state: "idle" | "running" | "paused" | "done" | "error";
    /** Days checked / to check in this run. */
    done: number;
    total: number;
    /** Days that failed in this run (NSE refused or timed out). */
    failed: number;
    current: string | null;
    message: string;
    startedAt: number | null;
    finishedAt: number | null;
  };
  coverage: {
    /** How far back the backfill goes. */
    lookbackDays: number;
    /** Weekdays in that window NSE could have published so far, and how many were checked (trading days + holidays). */
    expected: number;
    checked: number;
    /** Trade days stored, their range, and the underlying-day rows. */
    days: number;
    first: number | null;
    last: number | null;
    rows: number;
  };
}

export type HistoryDbAction = { action: "start"; kinds: HistoryKind[] } | { action: "stop" } | { action: "start-fo" } | { action: "stop-fo" };
