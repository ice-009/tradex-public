import crypto from "crypto";
import {
  CHART_INTERVAL_CONFIG,
  type ChartIntervalUnit,
  type ChartInterval,
  formatDateForApi,
} from "@/core/market/intervals";
import type { PricePoint } from "@/contracts/api";
import { BudgetExhaustedError, acquireFyersSlot, fyersPlan, reportRateLimited } from "@/server/providers/fyers/budget";

// NOTE: Fyers API v3 field names/paths below are based on public docs/SDK
// source researched during the Upstox->Fyers migration. Several details are
// flagged as unverified and must be confirmed against a live account before
// this module is trusted in production:
//  - exact validate-authcode / validate-refresh-token request field casing
//  - whether refreshing a token requires a trading PIN
//  - whether a news endpoint exists at all (none found in the documented
//    endpoint set: profile, funds, quotes, history, market status, option-chain)
//  - exact rate limits (min request gap below is a conservative guess)
//  - max history range per request per resolution (chunk sizes below are guesses)

const FYERS_API_BASE = process.env.FYERS_API_URL || "https://api-t1.fyers.in/api/v3";

// Fyers v3 market-data endpoints (quotes/history/depth) are served from
// <origin>/data — NOT under /api/v3, which only covers auth + profile/funds.
// Verified against a live account: /api/v3/data/quotes returns a non-JSON error,
// while /data/quotes returns the documented payload.
const FYERS_DATA_BASE =
  process.env.FYERS_DATA_URL || `${new URL(FYERS_API_BASE).origin}/data`;

// A single Fyers "app" (client_id) serves the whole deployment — unlike the
// access token, this isn't per-user data, so it's read from env internally
// rather than threaded through every call site.
function getFyersClientId() {
  return process.env.FYERS_CLIENT_ID || "";
}
const SERIES_CACHE_SHORT_TTL_MS = 30 * 1000;
const SERIES_CACHE_DAILY_TTL_MS = 15 * 60 * 1000;
const SERIES_CACHE_MONTHLY_TTL_MS = 60 * 60 * 1000;
const HISTORICAL_CHUNK_TTL_MS = 6 * 60 * 60 * 1000;
const INVALID_TOKEN_TTL_MS = 5 * 60 * 1000;


export interface FyersNewsArticle {
  heading: string;
  summary: string;
  article_link: string;
  published_time: number;
}

type FyersCandleTuple = [number, number, number, number, number, number];

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const historicalSeriesCache = new Map<string, CacheEntry<PricePoint[]>>();
const historicalSeriesInFlight = new Map<string, Promise<PricePoint[]>>();
const invalidTokenCache = new Map<string, CacheEntry<string>>();

// Fyers uses composed, human-readable symbols (EXCHANGE:SYMBOL-SEGMENT), so
// resolution is string construction rather than a network search call.
const KNOWN_INDEX_SYMBOLS: Record<string, string> = {
  NIFTY: "NSE:NIFTY50-INDEX",
  BANKNIFTY: "NSE:NIFTYBANK-INDEX",
  FINNIFTY: "NSE:FINNIFTY-INDEX",
  MIDCPNIFTY: "NSE:MIDCPNIFTY-INDEX",
  NIFTYIT: "NSE:NIFTYIT-INDEX",
  INDIAVIX: "NSE:INDIAVIX-INDEX",
  SENSEX: "BSE:SENSEX-INDEX",
};

// Token-bucket state (per-second) + rolling per-minute request log.

function normalizeAccessToken(accessToken: string | null | undefined) {
  return accessToken?.trim().replace(/\s+/g, "") || "";
}

function getTokenCacheKey(accessToken: string | null | undefined) {
  const token = normalizeAccessToken(accessToken);
  return token ? `${token.length}:${token.slice(-16)}` : "";
}

function markTokenInvalid(accessToken: string | null | undefined, reason: string) {
  const key = getTokenCacheKey(accessToken);
  if (!key) return;
  invalidTokenCache.set(key, {
    value: reason,
    expiresAt: Date.now() + INVALID_TOKEN_TTL_MS,
  });
}

export function getFyersTokenFailureReason(accessToken: string | null | undefined) {
  const key = getTokenCacheKey(accessToken);
  if (!key) return null;
  return getCachedValue(invalidTokenCache, key);
}

export function clearFyersTokenFailureReason(accessToken: string | null | undefined) {
  const key = getTokenCacheKey(accessToken);
  if (!key) return;
  invalidTokenCache.delete(key);
}

function getAuthHeaders(accessToken: string) {
  const token = normalizeAccessToken(accessToken);
  return {
    Authorization: `${getFyersClientId()}:${token}`,
    Accept: "application/json",
  };
}

function toFyersResolution(unit: ChartIntervalUnit, interval: number): string {
  if (unit === "minutes") return `${interval}`;
  if (unit === "hours") return `${interval * 60}`;
  // Weekly/monthly charts are aggregated from daily candles in
  // fetchFyersChartSeries rather than relying on Fyers' coarser resolutions.
  return "D";
}

function parseFyersCandleTimestamp(epochSeconds: number) {
  return new Date(epochSeconds * 1000).toISOString();
}

function convertFyersCandlesToPricePoints(candles: FyersCandleTuple[]): PricePoint[] {
  return candles
    .map((candle) => ({
      date: parseFyersCandleTimestamp(candle[0]),
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
      volume: candle[5] ?? 0,
    }))
    .sort((left, right) => Date.parse(left.date) - Date.parse(right.date));
}

// Bucket key for weekly (IST Monday) / monthly aggregation of daily candles.
// Fyers daily candles are stamped at IST midnight, so shift into IST first.
function subtractDays(baseDate: Date, days: number) {
  const result = new Date(baseDate);
  result.setDate(result.getDate() - days);
  return result;
}

function mergePriceSeriesChunks(chunks: PricePoint[][]) {
  const merged = new Map<string, PricePoint>();
  chunks.flat().forEach((point) => {
    merged.set(point.date, point);
  });
  return [...merged.values()].sort((left, right) => Date.parse(left.date) - Date.parse(right.date));
}

function getCachedValue<T>(cache: Map<string, CacheEntry<T>>, key: string) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

async function getOrLoadCached<T>(params: {
  cache: Map<string, CacheEntry<T>>;
  inFlight: Map<string, Promise<T>>;
  key: string;
  ttlMs: number;
  loader: () => Promise<T>;
}) {
  const cached = getCachedValue(params.cache, params.key);
  if (cached !== null) {
    return cached;
  }

  const pending = params.inFlight.get(params.key);
  if (pending) {
    return pending;
  }

  const promise = params.loader()
    .then((value) => {
      params.cache.set(params.key, {
        value,
        expiresAt: Date.now() + params.ttlMs,
      });
      return value;
    })
    .finally(() => {
      params.inFlight.delete(params.key);
    });

  params.inFlight.set(params.key, promise);
  return promise;
}

// Every Data API call (quotes, history, option chain) goes through the shared
// request budget (./budget.ts), which keeps us inside the plan's per-second,
// per-minute and per-day limits. A 429 is never retried: Fyers blocks the
// account for the day after repeated per-minute breaches, so we pause instead.
async function fetchFyersData(input: string, init: RequestInit) {
  const release = await acquireFyersSlot();
  let response: Response;
  try {
    response = await fetch(input, init);
  } finally {
    release();
  }
  if (response.status === 429) {
    reportRateLimited();
    throw new Error("Fyers request failed: 429 Too Many Requests");
  }
  return response;
}

function getSeriesCacheTtl(unit: ChartIntervalUnit) {
  if (unit === "months" || unit === "weeks") return SERIES_CACHE_MONTHLY_TTL_MS;
  if (unit === "days") return SERIES_CACHE_DAILY_TTL_MS;
  return SERIES_CACHE_SHORT_TTL_MS;
}

// Fyers intraday history is commonly capped to a much smaller range per
// request than daily/monthly. These are conservative placeholders pending
// verification against the live API's actual error responses.
// Verified against the live API: Fyers rejects daily/weekly/monthly ("D"/"1W"/
// "1M") requests whose range exceeds 366 days ("Date range cannot exceed 366
// days"). Intraday resolutions allow larger spans. Longer chart ranges are
// stitched together from multiple ≤-cap chunks in fetchFyersChartSeries.
// Sized so the plan's whole window takes the fewest calls: 4 × 90 days covers the
// intraday window, 5 × 365 days the 5 daily years (Fyers rejects daily spans > 366 days).
// Intraday stays at 90 days per request, the size verified against the live API
// (a 91-day trial coincided with intraday charts falling back to sample data).
const MAX_CHUNK_DAYS_BY_UNIT: Record<ChartIntervalUnit, number> = {
  minutes: 90,
  hours: 90,
  days: 365,
  weeks: 365,
  months: 365,
};

// How far back the plan serves history (verified on Standard: a request that starts
// earlier fails with 422). Asking for more only wastes a call on every new symbol,
// so requests are clamped to this, with a few days' margin.
const HISTORY_WINDOW_DAYS: Record<ChartIntervalUnit, number> = {
  minutes: 4 * 90,
  hours: 4 * 90,
  days: 5 * 365 - 3,
  weeks: 5 * 365 - 3,
  months: 5 * 365 - 3,
};

// Live streaming is handled server-side by src/lib/fyersStream.ts via the
// official SDK's HSM data socket (wss://socket.fyers.in/hsm/v1-5/prod), then
// relayed to browsers over SSE (/api/broker/stream). The old per-client v2
// socket URL was dead and has been removed.

export function toFyersSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  // Already a full Fyers symbol (e.g. NSE:SBIN26NOVFUT): pass it through.
  if (normalized.includes(":")) return normalized;
  const known = KNOWN_INDEX_SYMBOLS[normalized];
  if (known) return known;
  return `NSE:${normalized}-EQ`;
}

export function computeAppIdHash(clientId: string, secretKey: string): string {
  return crypto.createHash("sha256").update(`${clientId}:${secretKey}`).digest("hex");
}

export function getFyersAuthURL(state?: string): string {
  const clientId = getFyersClientId();
  const redirectUri = process.env.FYERS_REDIRECT_URL || "http://localhost:3000/api/broker/callback";
  const resolvedState = state || Math.random().toString(36).substring(7);

  return `${FYERS_API_BASE}/generate-authcode?client_id=${clientId}&redirect_uri=${encodeURIComponent(
    redirectUri,
  )}&response_type=code&state=${resolvedState}`;
}

export async function exchangeFyersAuthCode(
  authCode: string,
): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: Date | null }> {
  const clientId = getFyersClientId();
  const secretKey = process.env.FYERS_SECRET_KEY || "";
  const appIdHash = computeAppIdHash(clientId, secretKey);

  const response = await fetch(`${FYERS_API_BASE}/validate-authcode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      appIdHash,
      code: authCode,
    }),
  });

  if (!response.ok) {
    throw new Error(`Fyers token request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    // Fyers does not document a stable expires_in field for this response as
    // of this writing; leave null until confirmed rather than guessing.
    expiresAt: null,
  };
}

export async function refreshFyersAccessToken(
  refreshToken: string,
  pin?: string,
): Promise<{ accessToken: string; expiresAt: Date | null } | null> {
  const clientId = getFyersClientId();
  const secretKey = process.env.FYERS_SECRET_KEY || "";
  const appIdHash = computeAppIdHash(clientId, secretKey);
  // Verified against a live account: Fyers rejects refresh without a PIN
  // ("Please provide your valid pin"), so a server-side FYERS_PIN is required
  // for unattended token refresh. Callers may still pass an explicit pin.
  const resolvedPin = pin || process.env.FYERS_PIN || "";

  try {
    const response = await fetch(`${FYERS_API_BASE}/validate-refresh-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        appIdHash,
        refresh_token: refreshToken,
        ...(resolvedPin ? { pin: resolvedPin } : {}),
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.access_token) {
      // Fyers requires a trading PIN for refresh; if FYERS_PIN is unset or
      // wrong this fails and callers fall back to re-authenticating via OAuth.
      console.warn(
        `Fyers token refresh failed: ${response.status} ${data?.message ?? response.statusText}` +
          (resolvedPin ? "" : " (no FYERS_PIN configured)"),
      );
      return null;
    }

    return { accessToken: data.access_token, expiresAt: null };
  } catch (error) {
    console.warn("Fyers token refresh error:", error);
    return null;
  }
}

export async function validateFyersAccessToken(accessToken: string): Promise<boolean> {
  try {
    const normalizedToken = normalizeAccessToken(accessToken);
    if (!normalizedToken) {
      return false;
    }

    const cachedFailure = getFyersTokenFailureReason(normalizedToken);
    if (cachedFailure) {
      return false;
    }

    // User-info API: its own (much larger) limit, so it bypasses the data budget.
    const response = await fetch(`${FYERS_API_BASE}/profile`, {
      headers: getAuthHeaders(normalizedToken),
      cache: "no-store",
    });

    if (!response.ok) {
      if (response.status === 401) {
        markTokenInvalid(normalizedToken, "Fyers token was rejected with 401 Unauthorized.");
      }
      return false;
    }

    clearFyersTokenFailureReason(normalizedToken);
    return true;
  } catch (error) {
    console.error("Fyers token validation error:", error);
    return false;
  }
}

export async function fetchFyersQuote(
  symbol: string,
  accessToken: string,
): Promise<{ ltp: number; high: number; low: number; open: number; close: number; volume: number } | null> {
  try {
    const fyersSymbol = toFyersSymbol(symbol);
    const query = new URLSearchParams({ symbols: fyersSymbol });
    const response = await fetchFyersData(`${FYERS_DATA_BASE}/quotes?${query.toString()}`, {
      headers: getAuthHeaders(accessToken),
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Fyers quote failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const quote = Array.isArray(data.d) ? data.d.find((entry: { n?: string }) => entry.n === fyersSymbol) ?? data.d[0] : null;
    const values = quote?.v;

    return values
      ? {
          ltp: values.lp || values.close_price || 0,
          high: values.high_price || 0,
          low: values.low_price || 0,
          open: values.open_price || 0,
          close: values.prev_close_price || values.close_price || 0,
          volume: values.volume || 0,
        }
      : null;
  } catch (error) {
    console.error("Fyers quote fetch error:", error);
    return null;
  }
}

export interface FyersQuoteSnapshot {
  symbol: string; // app symbol
  ltp: number;
  ch: number;
  chp: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
}

// Fyers /data/quotes takes up to 50 symbols per request on Standard, 1,000 on Prime.
export async function fetchFyersQuotes(symbols: string[], accessToken: string): Promise<FyersQuoteSnapshot[]> {
  const batch = fyersPlan().limits.quoteBatch;
  const appSymbolByFyers = new Map(symbols.map((symbol) => [toFyersSymbol(symbol), symbol.trim().toUpperCase()]));
  const fyersSymbols = [...appSymbolByFyers.keys()];
  const snapshots: FyersQuoteSnapshot[] = [];

  for (let start = 0; start < fyersSymbols.length; start += batch) {
    const query = new URLSearchParams({ symbols: fyersSymbols.slice(start, start + batch).join(",") });
    try {
      const response = await fetchFyersData(`${FYERS_DATA_BASE}/quotes?${query.toString()}`, {
        headers: getAuthHeaders(accessToken),
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`Fyers quotes failed: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      for (const entry of Array.isArray(data.d) ? data.d : []) {
        const values = entry?.v;
        const appSymbol = appSymbolByFyers.get(entry?.n);
        if (!values || !appSymbol || typeof values.lp !== "number") continue;
        snapshots.push({
          symbol: appSymbol,
          ltp: values.lp,
          ch: values.ch ?? 0,
          chp: values.chp ?? 0,
          open: values.open_price ?? 0,
          high: values.high_price ?? 0,
          low: values.low_price ?? 0,
          prevClose: values.prev_close_price ?? 0,
          volume: values.volume ?? 0,
        });
      }
    } catch (error) {
      if (error instanceof BudgetExhaustedError) break; // the rest would be refused too
      console.error("Fyers batch quote fetch error:", error);
    }
  }

  return snapshots;
}

export interface FyersOptionStrike {
  strike: number;
  type: "CE" | "PE";
  ltp: number;
  ltpch: number;
  oi: number;
  oich: number;
  volume: number;
}

export interface FyersOptionChainRaw {
  underlyingLtp: number;
  futuresPrice: number;
  callOiTotal: number;
  putOiTotal: number;
  strikes: FyersOptionStrike[];
}

interface OptionChainApiRow {
  strike_price: number;
  option_type?: string;
  ltp?: number;
  ltpch?: number;
  oi?: number;
  oich?: number;
  volume?: number;
  fp?: number;
}

// Live option chain via Fyers' /options-chain-v3. Returns null for non-F&O
// symbols (or when the chain is unavailable), so callers can fall back.
export async function fetchFyersOptionChain(
  symbol: string,
  accessToken: string | null,
  strikeCount = 8,
): Promise<FyersOptionChainRaw | null> {
  const normalizedToken = normalizeAccessToken(accessToken);
  if (!normalizedToken || getFyersTokenFailureReason(normalizedToken)) {
    return null;
  }

  try {
    const fyersSymbol = toFyersSymbol(symbol);
    const query = new URLSearchParams({ symbol: fyersSymbol, strikecount: String(strikeCount) });
    const response = await fetchFyersData(`${FYERS_DATA_BASE}/options-chain-v3?${query.toString()}`, {
      headers: getAuthHeaders(normalizedToken),
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Fyers option chain failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const chain: OptionChainApiRow[] = Array.isArray(data?.data?.optionsChain) ? data.data.optionsChain : [];
    if (!chain.length) return null;

    // The strike_price === -1 row describes the underlying/future.
    const underlyingRow = chain.find((row) => row.strike_price === -1);
    const strikes: FyersOptionStrike[] = chain
      .filter((row) => row.strike_price > 0 && (row.option_type === "CE" || row.option_type === "PE"))
      .map((row) => ({
        strike: row.strike_price,
        type: row.option_type as "CE" | "PE",
        ltp: row.ltp ?? 0,
        ltpch: row.ltpch ?? 0,
        oi: row.oi ?? 0,
        oich: row.oich ?? 0,
        volume: row.volume ?? 0,
      }));

    if (!strikes.length) return null;

    return {
      underlyingLtp: underlyingRow?.ltp ?? 0,
      futuresPrice: underlyingRow?.fp ?? underlyingRow?.ltp ?? 0,
      callOiTotal: typeof data?.data?.callOi === "number" ? data.data.callOi : 0,
      putOiTotal: typeof data?.data?.putOi === "number" ? data.data.putOi : 0,
      strikes,
    };
  } catch (error) {
    console.warn(`Fyers option chain error for ${symbol}:`, error);
    return null;
  }
}

// No confirmed news endpoint exists in Fyers API v3's documented surface
// (profile, funds, quotes, history, market status, option-chain). Returning
// an empty map here rather than fabricating one — src/lib/eventRisk.ts's
// news-based risk gating needs an explicit product decision once this is
// confirmed against the live docs, not a silent no-op.
export async function fetchFyersNewsForSymbols(
  symbols: string[],
  accessToken: string | null,
): Promise<Record<string, FyersNewsArticle[]>> {
  if (!accessToken || !symbols.length) {
    return {};
  }
  console.warn("fetchFyersNewsForSymbols: no confirmed Fyers news endpoint exists; returning empty results.");
  return {};
}

async function fetchFyersHistoricalChunk(params: {
  symbol: string;
  resolution: string;
  toDate: Date;
  fromDate: Date;
  accessToken: string;
  cacheTtlMs: number;
}) {
  const query = new URLSearchParams({
    symbol: params.symbol,
    resolution: params.resolution,
    date_format: "1",
    range_from: formatDateForApi(params.fromDate),
    range_to: formatDateForApi(params.toDate),
    cont_flag: "1",
  });
  const cacheKey = `${params.symbol}:${params.resolution}:${query.get("range_from")}:${query.get("range_to")}`;

  return getOrLoadCached({
    cache: historicalSeriesCache,
    inFlight: historicalSeriesInFlight,
    key: cacheKey,
    ttlMs: params.cacheTtlMs,
    loader: async () => {
      const response = await fetchFyersData(`${FYERS_DATA_BASE}/history?${query.toString()}`, {
        headers: getAuthHeaders(params.accessToken),
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`Fyers candles fetch failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      // Fyers reports many errors with HTTP 200 and { s: "error", code, message }. Treating
      // those as "no candles" hid the real problem (and charts fell back to sample data).
      // "no_data" is a genuine empty answer (e.g. a range with no sessions).
      if (data?.s && data.s !== "ok" && data.s !== "no_data") {
        throw new Error(`Fyers history error${data.code !== undefined ? ` ${data.code}` : ""}: ${data.message ?? data.s} (${params.symbol} ${params.resolution}, ${query.get("range_from")} → ${query.get("range_to")})`);
      }
      const candles = Array.isArray(data.candles) ? (data.candles as FyersCandleTuple[]) : [];
      return convertFyersCandlesToPricePoints(candles);
    },
  });
}

/** How far back Fyers serves this interval, in days (requests starting earlier fail with 422). */
export function fyersHistoryWindowDays(interval: ChartInterval): number {
  return HISTORY_WINDOW_DAYS[CHART_INTERVAL_CONFIG[interval].unit];
}

/** Disk-cache key for a symbol's history (kept from before the data engine, so stored files stay valid). */
export function fyersHistoryCacheKey(symbol: string, interval: ChartInterval): string {
  const config = CHART_INTERVAL_CONFIG[interval];
  return `${toFyersSymbol(symbol)}:${toFyersResolution(config.unit, config.interval)}`;
}

/**
 * Candles for `symbol` from `fromMs` to now at a minute or daily interval, in as few
 * ≤ chunk-size requests as possible, newest chunk first. `complete` is false when a
 * request failed part-way (429, network) — the rest still exists and is fetched next
 * time; a 422 (older than the plan serves) means that's all there is.
 */
export async function downloadFyersHistory(
  symbol: string,
  interval: ChartInterval,
  fromMs: number,
  accessToken: string,
): Promise<{ candles: PricePoint[]; complete: boolean }> {
  const normalizedToken = normalizeAccessToken(accessToken);
  const failure = getFyersTokenFailureReason(normalizedToken);
  if (failure) throw new Error(failure);
  const config = CHART_INTERVAL_CONFIG[interval];
  if (config.unit === "weeks" || config.unit === "months") throw new Error(`Fyers adapter is asked for daily candles, not ${interval}`);
  const fyersSymbol = toFyersSymbol(symbol);
  const resolution = toFyersResolution(config.unit, config.interval);
  const cacheTtlMs = getSeriesCacheTtl(config.unit);
  const maxChunkDays = MAX_CHUNK_DAYS_BY_UNIT[config.unit];
  const toDate = new Date();
  const start = new Date(fromMs);

  const chunks: PricePoint[][] = [];
  let complete = true;
  let chunkTo = new Date(toDate);
  while (chunkTo > start) {
    const chunkFrom = subtractDays(chunkTo, maxChunkDays);
    try {
      chunks.push(
        await fetchFyersHistoricalChunk({
          symbol: fyersSymbol,
          resolution,
          toDate: chunkTo,
          fromDate: chunkFrom < start ? start : chunkFrom,
          accessToken: normalizedToken,
          // Only the newest chunk can still change; closed history caches long.
          cacheTtlMs: chunks.length === 0 ? cacheTtlMs : HISTORICAL_CHUNK_TTL_MS,
        }),
      );
    } catch (error) {
      const message = (error as Error).message ?? "";
      if (message.includes("401")) markTokenInvalid(normalizedToken, "Fyers token was rejected with 401 Unauthorized.");
      // Nothing at all: let the data engine fall back to the next source.
      if (!chunks.length) throw error;
      const beyondPlan = message.includes("422");
      if (!beyondPlan) complete = false;
      console.warn(`Fyers history for ${symbol} stops at ${formatDateForApi(chunkTo)}${beyondPlan ? " (plan's history limit)" : " for now"}:`, message);
      break;
    }
    chunkTo = subtractDays(chunkFrom, 1);
  }
  return { candles: mergePriceSeriesChunks(chunks), complete };
}
