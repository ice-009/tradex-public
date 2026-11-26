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
  PresetList,
  PresetsResponse,
  QuotesResponse,
  ReplayRequest,
  ResultsResponse,
  ScreenerResponse,
  SymbolsResponse,
  TrackResult,
  TradeCloseRequest,
  TradeCreateRequest,
  TradeDto,
  TradesResponse,
  TradeUpdateRequest,
} from "@/contracts/api";

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

export const api = {
  /** Candles for a chart; `older` asks daily-based intervals for the bars from `from` up to (not including) `to`, epoch ms. */
  chart: (symbol: string, interval: string, range: string, signal?: AbortSignal, older?: { from: number; to: number }) =>
    getJson<ChartResponse>("/api/chart", { symbol, interval, range, from: older?.from, to: older?.to }, signal),

  /** `fresh`: a just-now price (costs an API call); otherwise a recent cached one is fine. */
  quotes: (symbols: string[], fresh = false) => getJson<QuotesResponse>("/api/quotes", { symbols: csv(symbols), fresh: fresh ? 1 : undefined }),

  symbols: (query: string, signal?: AbortSignal) => getJson<SymbolsResponse>("/api/symbols", { q: query }, signal),

  screener: (universe: string) => getStatusJson<ScreenerResponse>("/api/screener", { universe }),

  track: (universe: string) => getStatusJson<TrackResult>("/api/screener/track", { universe }),

  /** What the BTST setups did live (recorded at 3:10–3:25 PM, settled at the next open). */
  liveRecord: () => getJson<LiveRecordResponse>("/api/screener/live-record"),

  /** The Signal Lab's trial record for an idea: variants tried, deflated Sharpe ratios, promotion verdict. */
  labTrials: (idea: string, signal?: AbortSignal) => getJson<LabTrialsResponse>("/api/lab/trials", { idea }, signal),
  /** Every Lab signal with its latest stored report's verdict (the report cards index, #23). */
  labCards: (signal?: AbortSignal) => getJson<LabCardsResponse>("/api/lab/cards", undefined, signal),
  /** One signal's report card: its stored variants and the latest report of `variant` (default: the newest). */
  labCard: (signalId: string, variant?: string, signal?: AbortSignal) => getJson<LabCardResponse>("/api/lab/card", { signal: signalId, variant }, signal),

  /** Which screens have an edge in which market state (computed in the background on the server: poll while "computing"). */
  evidence: (period?: { from: number; to: number | null }) =>
    getStatusJson<EvidenceResponse>("/api/plan/evidence", period ? { from: String(period.from), ...(period.to === null ? {} : { to: String(period.to) }) } : {}),

  /** "Re-run this": compute a stamped evidence table again from scratch (~10 s). */
  replayEvidence: (body: ReplayRequest, signal?: AbortSignal) => postStatusJson<EvidenceReplayResponse>("/api/plan/evidence/replay", body, signal),

  /** The trade journal: open trades with today's action, closed ones with the summary. */
  trades: () => getJson<TradesResponse>("/api/trades"),
  createTrade: (body: TradeCreateRequest) => postJson<TradeDto>("/api/trades", body),
  updateTrade: (id: string, body: TradeUpdateRequest) => postJson<TradeDto>(`/api/trades/${encodeURIComponent(id)}`, body, "PATCH"),
  closeTrade: (id: string, body: TradeCloseRequest) => postJson<TradeDto>(`/api/trades/${encodeURIComponent(id)}/close`, body),
  deleteTrade: (id: string) => postJson<{ ok: boolean }>(`/api/trades/${encodeURIComponent(id)}`, undefined, "DELETE"),

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

  results: () => getJson<ResultsResponse>("/api/results"),

  highLow: (after: number) => getJson<HighLowResponse>("/api/highlow", { after }),

  lots: () => getJson<LotsResponse>("/api/lots"),

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
