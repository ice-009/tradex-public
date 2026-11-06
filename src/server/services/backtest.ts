import "server-only";

import type { BacktestInfoResponse, BacktestRequest, BacktestResponse } from "@/contracts/api";
import { COST_PRESETS, type CostModel, type CostPresetId } from "@/core/backtest/costs";
import { BacktestInputError, runPortfolio, type BacktestResult } from "@/core/backtest/portfolio";
import { WARMUP_SESSIONS, scanSignals, type SignalScan } from "@/core/backtest/signals";
import { SCREENS } from "@/core/screener/screens";
import { screenerStore } from "@/server/providers/dailyStore";
import { getLotSizes } from "@/server/providers/lotSizes";
import { UNIVERSES, getUniverse } from "@/server/providers/universe";
import { BENCHMARK, parseUniverse } from "./screener";

// Strategy backtests: replay the screens over the stored daily history of a
// universe (src/core/backtest/signals.ts), then trade the signals as one
// account (portfolio.ts). Only bars already on disk are used — this never asks
// a broker for more history.
//
// Two caches, both keyed by the last stored session so a new EOD file
// invalidates them:
//  - the signal scan per universe (the slow part: features for every stock on
//    every session, ~5–10 s for ~240 stocks × 250 sessions);
//  - finished results per request (the portfolio pass itself takes milliseconds).

/** Bump when the scan or simulation rules change, so a running server drops cached results. */
const BACKTEST_VERSION = 3;
const MAX_RESULTS = 24;

const globalForBacktest = globalThis as unknown as {
  backtestScans?: Map<string, Promise<SignalScan>>;
  backtestResults?: Map<string, BacktestResult>;
};
const scans = (globalForBacktest.backtestScans ??= new Map());
const results = (globalForBacktest.backtestResults ??= new Map());

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function coveredSymbols(universe: string) {
  const id = parseUniverse(universe);
  const symbols = (await getUniverse(id)).map((member) => member.symbol);
  // Disk only: hasData reads what's stored and never starts a download.
  await screenerStore.hasData([...symbols, BENCHMARK]);
  const covered = symbols.filter((symbol) => screenerStore.getBars(symbol).length > 0);
  return { id, symbols, covered };
}

export async function backtestInfo(universe: string): Promise<BacktestInfoResponse> {
  const { id, symbols, covered } = await coveredSymbols(universe);
  const dates = [...new Set(covered.flatMap((symbol) => screenerStore.getBars(symbol).map((bar) => bar.t)))].sort((a, b) => a - b);
  return {
    universe: id,
    label: UNIVERSES.find((u) => u.id === id)?.label,
    symbols: symbols.length,
    covered: covered.length,
    history: dates.length ? { from: dates[0], to: dates.at(-1)!, sessions: dates.length, dates } : null,
    warmupDate: dates[WARMUP_SESSIONS - 1] ?? null,
  };
}

const num = (value: unknown, fallback: number, min: number, max: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const dayOrNull = (value: unknown) => (value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null);

/** Validate and clamp a request body (anything the client sends). */
export function parseBacktestRequest(body: unknown): BacktestRequest {
  const raw = (body ?? {}) as Record<string, unknown>;
  const known = new Set(SCREENS.map((screen) => screen.id));
  const screenIds = Array.isArray(raw.screenIds) ? [...new Set(raw.screenIds.map(String).filter((id) => known.has(id)))] : [];
  const preset = String(raw.costPreset ?? "futures-2026");
  const slip = raw.slippage as { mode?: unknown; value?: unknown } | undefined;
  const hold = dayOrNull(raw.holdBars);
  return {
    universe: parseUniverse(typeof raw.universe === "string" ? raw.universe : null),
    screenIds,
    from: dayOrNull(raw.from),
    to: dayOrNull(raw.to),
    holdBars: hold === null || hold <= 0 ? null : Math.round(num(hold, 10, 1, 60)),
    capital: num(raw.capital, 10_00_000, 10_000, 1e10),
    riskPct: num(raw.riskPct, 1, 0.05, 10),
    maxPositions: Math.round(num(raw.maxPositions, 5, 1, 50)),
    maxLeverage: num(raw.maxLeverage, 4, 0.5, 10),
    entry: raw.entry === "signal-close" ? "signal-close" : "next-open",
    costPreset: preset in COST_PRESETS ? (preset as CostPresetId) : "futures-2026",
    slippage:
      slip && (slip.mode === "pct" || slip.mode === "ticks") ? { mode: slip.mode, value: num(slip.value, 0, 0, slip.mode === "pct" ? 2 : 50) } : undefined,
    sizing: raw.sizing === "shares" ? "shares" : "lots",
    oosFraction: num(raw.oosFraction, 0.3, 0.1, 0.5),
  };
}

async function scanFor(universe: string): Promise<{ scan: SignalScan; key: string; cached: boolean; ms: number }> {
  const { id, covered } = await coveredSymbols(universe);
  if (!covered.length) throw new BacktestError("No daily history is stored for this universe yet. Open the screener once a broker is connected to sync it.");
  const lastSession = Math.max(...covered.map((symbol) => screenerStore.getBars(symbol).at(-1)?.t ?? 0));
  const key = `${id}:${lastSession}:${covered.length}:${BACKTEST_VERSION}`;
  let pending = scans.get(key);
  const cached = Boolean(pending);
  const started = Date.now();
  if (!pending) {
    // Concurrent requests share one scan; older scans of this universe are dropped.
    pending = scanSignals({
      symbols: covered,
      getBars: (symbol) => screenerStore.getBars(symbol),
      benchmark: screenerStore.getBars(BENCHMARK),
      pause: yieldToEventLoop,
    });
    for (const stale of [...scans.keys()].filter((entry) => entry.startsWith(`${id}:`))) scans.delete(stale);
    scans.set(key, pending);
    pending.catch(() => scans.delete(key));
  }
  const scan = await pending;
  const ms = Date.now() - started;
  if (!cached) console.info(`Backtest scan for ${id}: ${scan.symbols} stocks × ${scan.dates.length} sessions, ${scan.signals} signals in ${ms} ms`);
  return { scan, key, cached, ms };
}

class BacktestError extends Error {}

export async function runBacktest(request: BacktestRequest): Promise<BacktestResponse> {
  if (!request.screenIds.length) return { status: "error", error: "Pick at least one strategy." };
  try {
    const { scan, key: scanKey, cached: scanCached, ms: scanMs } = await scanFor(request.universe);
    const preset = COST_PRESETS[request.costPreset].model;
    const costs: CostModel = request.slippage ? { ...preset, slippage: request.slippage } : preset;

    let lots: Record<string, number> | null = null;
    let lotNote: string | null = null;
    if (request.sizing === "lots") {
      const sizes = await getLotSizes();
      if (Object.keys(sizes.lots).length) lots = sizes.lots;
      else lotNote = "Futures lot sizes couldn't be loaded, so positions are sized in whole shares.";
    }

    const key = JSON.stringify([scanKey, request, lots ? "lots" : "shares"]);
    const hit = results.get(key);
    if (hit) return { status: "ready", universe: request.universe, symbols: scan.symbols, result: hit, costs, runtime: { scanMs, simMs: 0, scanCached, cached: true } };

    const started = Date.now();
    const result = runPortfolio(scan, {
      screenIds: request.screenIds,
      from: request.from,
      to: request.to,
      holdBars: request.holdBars,
      capital: request.capital,
      riskPct: request.riskPct,
      maxPositions: request.maxPositions,
      maxLeverage: request.maxLeverage,
      entry: request.entry,
      costs,
      lots,
      oosFraction: request.oosFraction,
    });
    if (lotNote) result.warnings.unshift(lotNote);
    const simMs = Date.now() - started;
    results.set(key, result);
    while (results.size > MAX_RESULTS) results.delete(results.keys().next().value!);
    return { status: "ready", universe: request.universe, symbols: scan.symbols, result, costs, runtime: { scanMs, simMs, scanCached, cached: false } };
  } catch (error) {
    if (error instanceof BacktestError || error instanceof BacktestInputError) return { status: "error", error: error.message };
    throw error;
  }
}
