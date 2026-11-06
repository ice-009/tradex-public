// Typed fetchers for every /api endpoint — the only place in the browser that
// knows URLs and query strings. Response shapes come from @/contracts/api, so
// a backend change that breaks the frontend is a type error.
//
// Feeds (polling, caching, React stores) live next to this in src/client and
// call these; components should not call fetch() for /api themselves.

import type {
  AnalyzeResponse,
  ApiUsageResponse,
  HistoryDbAction,
  HistoryDbStatus,
  BacktestInfoResponse,
  BacktestRequest,
  BacktestResponse,
  ChartResponse,
  HighLowResponse,
  LiveRecordResponse,
  LotsResponse,
  PresetList,
  PresetsResponse,
  QuotesResponse,
  ResultsResponse,
  ScreenerResponse,
  SymbolsResponse,
  TrackResult,
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

/** POST a JSON body; answers in the endpoint's own `{ status: "error" }` shape are returned, other failures throw. */
/** POST a JSON body; non-2xx throws ApiError with the server's `error` message. */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
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
  chart: (symbol: string, interval: string, range: string, signal?: AbortSignal) => getJson<ChartResponse>("/api/chart", { symbol, interval, range }, signal),

  /** `fresh`: a just-now price (costs an API call); otherwise a recent cached one is fine. */
  quotes: (symbols: string[], fresh = false) => getJson<QuotesResponse>("/api/quotes", { symbols: csv(symbols), fresh: fresh ? 1 : undefined }),

  symbols: (query: string, signal?: AbortSignal) => getJson<SymbolsResponse>("/api/symbols", { q: query }, signal),

  screener: (universe: string) => getStatusJson<ScreenerResponse>("/api/screener", { universe }),

  track: (universe: string) => getStatusJson<TrackResult>("/api/screener/track", { universe }),

  /** What the BTST setups did live (recorded at 3:10–3:25 PM, settled at the next open). */
  liveRecord: () => getJson<LiveRecordResponse>("/api/screener/live-record"),

  /** Stored history a backtest can use for a universe. */
  backtestInfo: (universe: string, signal?: AbortSignal) => getJson<BacktestInfoResponse>("/api/backtest", { universe }, signal),

  /** Run a strategy backtest on the server (the first run per universe scans the history: several seconds). */
  backtest: (request: BacktestRequest, signal?: AbortSignal) => postStatusJson<BacktestResponse>("/api/backtest", request, signal),

  analyze: (symbols: string[]) => getJson<AnalyzeResponse>("/api/analyze", { symbols: csv(symbols) }),

  results: () => getJson<ResultsResponse>("/api/results"),

  highLow: (after: number) => getJson<HighLowResponse>("/api/highlow", { after }),

  lots: () => getJson<LotsResponse>("/api/lots"),

  usage: () => getJson<ApiUsageResponse>("/api/broker/usage"),

  /** The local market-data database and its "Download F&O history" job. */
  historyDb: () => getJson<HistoryDbStatus>("/api/data/history-db"),
  historyDbAction: (action: HistoryDbAction) => postJson<HistoryDbStatus>("/api/data/history-db", action),

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
