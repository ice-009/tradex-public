// Typed fetchers for every /api endpoint — the only place in the browser that
// knows URLs and query strings. Response shapes come from @/contracts/api, so
// a backend change that breaks the frontend is a type error.
//
// Feeds (polling, caching, React stores) live next to this in src/client and
// call these; components should not call fetch() for /api themselves.

import type {
  AnalyzeResponse,
  ApiUsageResponse,
  BacktestInfoResponse,
  BrokerStatusResponse,
  DataQualityResponse,
  FuturesResponse,
  HealthReport,
  MarketDataStatus,
  BacktestRequest,
  BacktestResponse,
  ChartResponse,
  EvidenceReplayResponse,
  EvidenceResponse,
  HighLowResponse,
  LabCardResponse,
  LabCardsResponse,
  LabRequest,
  LabResponse,
  LabTrialsResponse,
  LiveRecordResponse,
  LotsResponse,
  PlanLedgerResponse,
  PlanLedgerVerifyResponse,
  PresetList,
  PresetsResponse,
  QuotesResponse,
  ReceiptsResponse,
  ReplayRequest,
  ResultsResponse,
  RiskReturnsResponse,
  ScreenerResponse,
  SymbolsResponse,
  TimeMachineResponse,
  TrackResult,
  TradeCloseRequest,
  TradeCreateRequest,
  PaperResponse,
  PaperTakeRequest,
  TradeDto,
  TradesResponse,
  TradeUpdateRequest,
} from "@/contracts/api";
import { asOfParam } from "@/client/timeMachine";
import { replayActive } from "@/client/replay";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** GET a JSON endpoint; non-2xx throws ApiError with the server's `error` message. */
async function getJson<T>(path: string, params?: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
  const query = params
    ? new URLSearchParams(Object.entries(params).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]]))).toString()
    : "";
  const response = await fetch(query ? `${path}?${query}` : path, { cache: "no-store", signal });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError((body as { error?: string } | null)?.error ?? `${path} failed (${response.status})`, response.status);
  return body as T;
}

/**
 * Like getJson, but endpoints that answer errors in their own shape (`{ status: "error", … }`)
 * return the body instead of throwing.
 */
async function getStatusJson<T extends { status: string }>(path: string, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`${path}?${query}`, { cache: "no-store" });
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (body?.status) return body;
  throw new ApiError(body?.error ?? `${path} failed (${response.status})`, response.status);
}

/** Send a JSON body (POST by default); non-2xx throws ApiError with the server's `error` message. */
async function postJson<T>(path: string, body: unknown, method: "POST" | "PATCH" | "DELETE" = "POST"): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError((json as { error?: string } | null)?.error ?? `${path} failed (${response.status})`, response.status);
  return json as T;
}

async function postStatusJson<T extends { status: string }>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal });
  const json = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (json?.status) return json;
  throw new ApiError(json?.error ?? `${path} failed (${response.status})`, response.status);
}

const csv = (symbols: string[]) => symbols.join(",");

/**
 * The Time Machine's day (src/client/timeMachine.ts) for endpoints that answer
 * as of a past day: added to every one of them here, so no caller can forget it.
 */
const asOf = () => asOfParam();
/** "1" while a replay steps or plays (src/client/replay.ts): the server may read the replay block once and cut it at each day. */
const replay = () => (asOf() && replayActive() ? "1" : undefined);
const withAsOf = (params: Record<string, string>): Record<string, string> => {
  const day = asOf();
  if (!day) return params;
  const flag = replay();
  return flag ? { ...params, asOf: day, replay: flag } : { ...params, asOf: day };
};

export const api = {
  /** Candles for a chart; `older` asks daily-based intervals for the bars from `from` up to (not including) `to`, epoch ms. */
  chart: (symbol: string, interval: string, range: string, signal?: AbortSignal, older?: { from: number; to: number }) =>
    getJson<ChartResponse>("/api/chart", { symbol, interval, range, from: older?.from, to: older?.to, asOf: asOf(), replay: replay() }, signal),

  /** `fresh`: a just-now price (costs an API call); otherwise a recent cached one is fine. */
  quotes: (symbols: string[], fresh = false) => getJson<QuotesResponse>("/api/quotes", { symbols: csv(symbols), fresh: fresh ? 1 : undefined, asOf: asOf(), replay: replay() }),

  symbols: (query: string, signal?: AbortSignal) => getJson<SymbolsResponse>("/api/symbols", { q: query }, signal),

  screener: (universe: string) => getStatusJson<ScreenerResponse>("/api/screener", withAsOf({ universe })),

  track: (universe: string) => getStatusJson<TrackResult>("/api/screener/track", withAsOf({ universe })),

  /** The Time Machine: which session `asOf` (YYYY-MM-DD) means and what was known that day. */
  timeMachine: (day: string) => getJson<TimeMachineResponse>("/api/time-machine", { asOf: day }),

  /** What the BTST setups did live (recorded at 3:10–3:25 PM, settled at the next open). */
  liveRecord: () => getJson<LiveRecordResponse>("/api/screener/live-record"),

  /** The Signal Lab's trial record for an idea: variants tried, deflated Sharpe ratios, promotion verdict. */
  labTrials: (idea: string, signal?: AbortSignal) => getJson<LabTrialsResponse>("/api/lab/trials", { idea }, signal),
  /** Every Lab signal with its latest stored report's verdict (the report cards index, #23). */
  labCards: (signal?: AbortSignal) => getJson<LabCardsResponse>("/api/lab/cards", undefined, signal),
  /** One signal's report card: its stored variants and the latest report of `variant` (default: the newest). */
  labCard: (signalId: string, variant?: string, signal?: AbortSignal) => getJson<LabCardResponse>("/api/lab/card", { signal: signalId, variant }, signal),
  /** Every score factor's and screen's report card in brief, and the factors that pass (the receipts, #29). */
  receipts: (signal?: AbortSignal) => getJson<ReceiptsResponse>("/api/lab/receipts", undefined, signal),

  /** Which screens have an edge in which market state (computed in the background on the server: poll while "computing"). */
  evidence: (period?: { from: number; to: number | null }) =>
    getStatusJson<EvidenceResponse>("/api/plan/evidence", withAsOf(period ? { from: String(period.from), ...(period.to === null ? {} : { to: String(period.to) }) } : {})),

  /** "Re-run this": compute a stamped evidence table again from scratch (~10 s). */
  replayEvidence: (body: ReplayRequest, signal?: AbortSignal) => postStatusJson<EvidenceReplayResponse>("/api/plan/evidence/replay", body, signal),

  /** Daily returns of open trades and plan ideas for the risk model (issue #40); "syncing" while a past day's bars are read. */
  riskReturns: (symbols: string[]) => getStatusJson<RiskReturnsResponse>("/api/plan/returns", withAsOf({ symbols: csv(symbols) })),

  /** The sealed daily plans (#33) between two YYYY-MM-DD dates (default: the last 30 days); "past" in the Time Machine. */
  planLedger: (range?: { from?: string; to?: string }) => getStatusJson<PlanLedgerResponse>("/api/plan/ledger", withAsOf({ ...(range?.from ? { from: range.from } : {}), ...(range?.to ? { to: range.to } : {}) })),

  /** The sealed-plan ledger verified end to end. */
  verifyPlanLedger: () => getStatusJson<PlanLedgerVerifyResponse>("/api/plan/ledger/verify", withAsOf({})),

  /** The trade journal: open trades with today's action, closed ones with the summary. */
  trades: () => getJson<TradesResponse>("/api/trades"),
  createTrade: (body: TradeCreateRequest) => postJson<TradeDto>("/api/trades", body),
  updateTrade: (id: string, body: TradeUpdateRequest) => postJson<TradeDto>(`/api/trades/${encodeURIComponent(id)}`, body, "PATCH"),
  closeTrade: (id: string, body: TradeCloseRequest) => postJson<TradeDto>(`/api/trades/${encodeURIComponent(id)}/close`, body),
  deleteTrade: (id: string) => postJson<{ ok: boolean }>(`/api/trades/${encodeURIComponent(id)}`, undefined, "DELETE"),

  /** Paper trading in a Time Machine replay (#32): the current session graded as of the day shown. */
  paper: (signal?: AbortSignal) => getJson<PaperResponse>("/api/paper", withAsOf({}), signal),
  /** Paper-take a plan idea on the day shown. */
  paperTake: (body: PaperTakeRequest) => postJson<{ id: string }>(`/api/paper?${new URLSearchParams(withAsOf({})).toString()}`, body),
  paperRemove: (id: string) => postJson<{ ok: boolean }>(`/api/paper/${encodeURIComponent(id)}`, undefined, "DELETE"),
  /** Start a new paper session (the current one is kept, closed). */
  paperSession: () => postJson<{ id: string }>("/api/paper/session", {}),

  /** Stored history a backtest can use for a universe. */
  backtestInfo: (universe: string, signal?: AbortSignal) => getJson<BacktestInfoResponse>("/api/backtest", { universe }, signal),

  /** Run a strategy backtest on the server (the first run per universe scans the history: several seconds). */
  backtest: (request: BacktestRequest, signal?: AbortSignal) => postStatusJson<BacktestResponse>("/api/backtest", request, signal),

  /** "Re-run this": run a stamped backtest again from scratch (no cached scan or result). */
  replayBacktest: (body: ReplayRequest, signal?: AbortSignal) => postStatusJson<BacktestResponse>("/api/backtest/replay", body, signal),

  /** Test a signal in the Signal Lab (a screen signal's first run scans every stock's history: several seconds). */
  lab: (request: LabRequest, signal?: AbortSignal) => postStatusJson<LabResponse>("/api/lab/run", request, signal),

  /** "Re-run this": run a stamped Lab run again from scratch. */
  replayLab: (body: ReplayRequest, signal?: AbortSignal) => postStatusJson<LabResponse>("/api/lab/replay", body, signal),

  analyze: (symbols: string[]) => getJson<AnalyzeResponse>("/api/analyze", { symbols: csv(symbols) }),

  results: () => getJson<ResultsResponse>("/api/results", { asOf: asOf(), replay: replay() }),

  highLow: (after: number) => getJson<HighLowResponse>("/api/highlow", { after }),

  lots: () => getJson<LotsResponse>("/api/lots", { asOf: asOf(), replay: replay() }),

  /** A stock's listed futures contracts (near and next month, as hub tickers) and lot size. */
  futures: (symbol: string) => getJson<FuturesResponse>("/api/futures", { symbol }),

  /** The Market Data Hub's broker budget and health, for the top bar. */
  usage: () => getJson<ApiUsageResponse>("/api/broker/usage"),

  /** Whether a Market Data Hub is configured and reachable. */
  hubStatus: () => getJson<BrokerStatusResponse>("/api/broker/status"),

  /** "Market data: provided by your hub": its health and the freshness of each dataset (read-only). */
  marketData: () => getJson<MarketDataStatus>("/api/data/hub"),

  /** The /health page: hub connection, data freshness, budget, sockets, jobs, recent errors and why a number may be old. */
  health: () => getJson<HealthReport>("/api/health/details"),

  /** The hub's data-quality findings, for the terminal's alerts. */
  quality: () => getJson<DataQualityResponse>("/api/health/quality"),

  /** Ready-made lists; fetched once per page load and shared. */
  presets: (() => {
    let pending: Promise<PresetList[]> | null = null;
    return () => {
      pending ??= getJson<PresetsResponse>("/api/universe/presets")
        .then((json) => json.presets)
        .catch((error) => {
          pending = null; // let the next caller retry
          throw error;
        });
      return pending;
    };
  })(),
};
