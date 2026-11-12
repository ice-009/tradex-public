import "server-only";

import { expiryDayKey, type FuturesContract } from "@/core/market/futures";
import { istParts } from "@/core/market/session";
import { HubError, hubClient } from "@/server/providers/hub";

// Stock-futures contracts from the Market Data Hub (GET /v1/fo/contracts): the
// listed months' tickers (e.g. SBIN26NOVFUT, which the hub serves in candles,
// quotes and the stream like any symbol), their expiries and the lot size.
// Tradex never builds a contract name itself.
//
// Cached per stock until the near month expires (or for 12 hours), so the
// order ticket and the Day High/Low sweep ask once a month, not per use.

const TTL_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
/** Parallel contract requests while warming the F&O list (the hub allows a key ~10 a second). */
const WARM_CONCURRENCY = 2;

export interface StockFutures {
  symbol: string;
  lot: number | null;
  contracts: FuturesContract[];
}

interface Entry {
  at: number;
  value: StockFutures | null;
  pending: Promise<StockFutures | null> | null;
}

const globalForFutures = globalThis as unknown as { hubFutures?: Map<string, Entry>; hubFuturesWarming?: Promise<void> | null };
const entries: Map<string, Entry> = (globalForFutures.hubFutures ??= new Map());

function fresh(entry: Entry | undefined, today: number): boolean {
  if (!entry || entry.pending) return Boolean(entry?.pending);
  if (!entry.value) return Date.now() - entry.at < RETRY_MS;
  const near = entry.value.contracts.find((contract) => contract.kind === "near");
  return Date.now() - entry.at < TTL_MS && (!near || near.expiry >= today);
}

async function load(symbol: string): Promise<StockFutures | null> {
  const hub = hubClient();
  if (!hub) return null;
  try {
    const answer = await hub.foContracts(symbol);
    const contracts = (answer.contracts ?? []).flatMap((contract): FuturesContract[] => {
      const expiry = expiryDayKey(contract.expiry);
      const kind = contract.kind === "next" ? "next" : contract.kind === "near" ? "near" : null;
      return expiry !== null && kind && contract.ticker ? [{ ticker: contract.ticker.toUpperCase(), expiry, kind }] : [];
    });
    return { symbol, lot: answer.lot ?? null, contracts };
  } catch (error) {
    // 404 not_found: the stock has no futures — remember that like any answer. Anything else
    // (404 not_ready: no F&O file stored yet, network) is asked again in 10 minutes.
    if (error instanceof HubError && error.status === 404 && error.code === "not_found") return { symbol, lot: null, contracts: [] };
    console.warn(`Futures contracts for ${symbol} from the Market Data Hub:`, (error as Error).message);
    return null;
  }
}

/** A stock's listed futures contracts and lot size (null when the hub has none, or can't answer). */
export function stockFutures(symbol: string): Promise<StockFutures | null> {
  const key = symbol.trim().toUpperCase();
  const today = istParts().day;
  const entry = entries.get(key);
  if (entry && fresh(entry, today)) return entry.pending ?? Promise.resolve(entry.value);
  const next: Entry = { at: entry?.at ?? 0, value: entry?.value ?? null, pending: null };
  next.pending = load(key).then((value) => {
    next.value = value ?? next.value;
    next.at = Date.now();
    next.pending = null;
    return next.value;
  });
  entries.set(key, next);
  return next.pending;
}

/**
 * Near-month tickers already known for `symbols` (underlying → ticker), without
 * waiting. Unknown or stale ones are loaded in the background, a couple at a time,
 * so a later call has them. Used by the Day High/Low sweep.
 */
export function knownNearFutures(symbols: string[]): Map<string, string> {
  const today = istParts().day;
  const known = new Map<string, string>();
  const missing: string[] = [];
  for (const symbol of symbols) {
    const entry = entries.get(symbol);
    const near = entry?.value?.contracts.find((contract) => contract.kind === "near" && contract.expiry >= today);
    if (near) known.set(symbol, near.ticker);
    if (!fresh(entry, today)) missing.push(symbol);
  }
  if (missing.length && !globalForFutures.hubFuturesWarming && hubClient()) {
    const queue = [...missing];
    const worker = async () => {
      for (let symbol = queue.shift(); symbol; symbol = queue.shift()) await stockFutures(symbol);
    };
    globalForFutures.hubFuturesWarming = Promise.all(Array.from({ length: WARM_CONCURRENCY }, worker))
      .then(() => undefined)
      .finally(() => {
        globalForFutures.hubFuturesWarming = null;
      });
  }
  return known;
}
