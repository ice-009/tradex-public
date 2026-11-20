import "server-only";

import type { BacktestInfoResponse, BacktestRequest, BacktestResponse } from "@/contracts/api";
import { COST_PRESETS, type CostModel, type CostPresetId } from "@/core/backtest/costs";
import { lotHistoryPart, pointInTimeLots } from "@/core/backtest/lots";
import { BacktestInputError, runPortfolio, type BacktestResult } from "@/core/backtest/portfolio";
import { WARMUP_SESSIONS, scanSignals, type SignalScan } from "@/core/backtest/signals";
import { pointInTimeUniverse, universeNote } from "@/core/backtest/universe";
import { DAY_MS, istParts } from "@/core/market/session";
import { hashDataset, lotsOf, makeStamp, withDataPart, type DataStamp, type RunStamp } from "@/core/repro/stamp";
import { SCREENS } from "@/core/screener/screens";
import type { DailyBar } from "@/core/types";
import { DEEP_HISTORY_DAYS } from "@/server/providers/dailyBars";
import { screenerStore } from "@/server/providers/dailyStore";
import { asOfSpan, orElse, type ReferenceTimeline } from "@/server/providers/asOf";
import { UNIVERSES } from "@/server/providers/universe";
import { codeVersion, hubVersion, parseStamp, pinOf, type ReplayPin } from "./runStamp";
import { BENCHMARK, parseUniverse } from "./screener";
import { log } from "@/server/log";

// Strategy backtests: replay the screens over a universe's daily history (up to
// the 5 years the Market Data Hub serves; src/core/backtest/signals.ts), then
// trade the signals as one account (portfolio.ts). The bars come from the
// screener's store (dailyStore), which reads them from the hub's batch candles;
// opening the backtest asks the hub for any symbol not held yet.
//
// Two caches, both keyed by the last stored session so a new session
// invalidates them:
//  - the signal scan per universe (the slow part: features for every stock on
//    every session, ~5–10 s for ~240 stocks × 250 sessions), with the content
//    hash of the bars it read;
//  - finished results per request (the portfolio pass itself takes milliseconds).
//
// Reference data comes only through the point-in-time engine (asOf,
// src/server/providers/asOf.ts). The F&O universe is point-in-time
// (src/core/backtest/universe.ts) on every session the engine knows the F&O
// list for: only stocks that had stock futures that day can signal; other
// sessions use today's list. Lots are point-in-time too (src/core/backtest/lots.ts):
// each signal is sized with its session's lot where known (NSE's files carry
// lots from Jul 2024), else today's. Every result says which list and which
// lots were used on how many sessions.
//
// Every result carries a run stamp (src/core/repro/stamp.ts): the hash of the
// data it read, the commit, the parameters, and the hash of the result.
// `replayBacktest` runs a stamp again from scratch — no cache — on the bars up
// to the stamped last session, so the browser can show whether it reproduces.

/** Bump when the scan or simulation rules change, so a running server drops cached results. */
const BACKTEST_VERSION = 7;
const ENGINE = `backtest/${BACKTEST_VERSION}`;
const MAX_RESULTS = 24;

interface Scanned {
  scan: SignalScan;
  /** Hash of the bars, F&O list and universe the scan read (lot sizes are added per run). */
  data: DataStamp;
}

const globalForBacktest = globalThis as unknown as {
  backtestScans?: Map<string, Promise<Scanned>>;
  backtestResults?: Map<string, { result: BacktestResult; stamp: RunStamp }>;
  backtestBarHashes?: WeakMap<DailyBar[], string>;
};
const scans = (globalForBacktest.backtestScans ??= new Map());
const results = (globalForBacktest.backtestResults ??= new Map());
/** Hash per stored series; the store replaces a series' array when it changes, never edits it. */
const barHashes = (globalForBacktest.backtestBarHashes ??= new WeakMap());

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Membership {
  byDay: ReadonlyMap<number, ReadonlySet<string>>;
  listOn: (day: number) => ReadonlySet<string> | null;
  isMember: (symbol: string, date: number) => boolean;
  /** Former members (not on today's list) with no stored daily bars: they can't be replayed. */
  noHistory: string[];
  /** Changes when more F&O days are imported, so the scan cache refreshes. */
  key: string;
  /** Range the list was read for. */
  window: { from: number; to: number };
}

async function coveredSymbols(universe: string, options: { sync?: boolean; window?: { from: number; to: number } | null } = {}) {
  const id = parseUniverse(universe);
  // Point-in-time F&O membership over the stored span, through asOf (cached).
  const today = istParts().day;
  const window = options.window ?? { from: today - DEEP_HISTORY_DAYS * DAY_MS, to: today };
  const timeline = await asOfSpan(window.from, window.to, { results: false, factors: false });
  const symbols = orElse(timeline.at(today).universe(id), []).map((member) => member.symbol);
  const byDay = id === "fno" ? timeline.history.fo.byDay : new Map<number, Set<string>>();
  const listOn = listOnOf(timeline);
  const pit = byDay.size ? pointInTimeUniverse({ byDay, today: symbols, listOn }) : null;
  const wanted = pit ? pit.symbols : symbols;
  // Ask the hub for anything not held yet (in the background); meanwhile use what's stored.
  if (options.sync) screenerStore.ensureFresh([...wanted, BENCHMARK]);
  await screenerStore.hasData([...wanted, BENCHMARK]);
  const hasBars = (symbol: string) => screenerStore.getBars(symbol).length > 0;
  const current = new Set(symbols);
  const membership: Membership | null = pit
    ? {
        byDay,
        listOn,
        isMember: pit.isMember,
        noHistory: pit.symbols.filter((symbol) => !current.has(symbol) && !hasBars(symbol)),
        key: `pit${byDay.size}-${Math.max(...byDay.keys())}`,
        window,
      }
    : null;
  // Sorted, so the scan (and the ranking of tied signals) doesn't depend on the list's order.
  return { id, symbols, covered: symbols.filter(hasBars), scanned: wanted.filter(hasBars).sort(), membership };
}

/** The F&O list on a session as asOf knows it, null when unknown. */
const listOnOf = (timeline: ReferenceTimeline) => (day: number) => {
  const list = timeline.at(day).foList;
  return list.known ? list.value : null;
};

export async function backtestInfo(universe: string): Promise<BacktestInfoResponse> {
  const { id, symbols, covered } = await coveredSymbols(universe, { sync: true });
  const dates = [...new Set(covered.flatMap((symbol) => screenerStore.getBars(symbol).map((bar) => bar.t)))].sort((a, b) => a - b);
  const { progress } = screenerStore;
  const active = screenerStore.isSyncing() || progress.queued > 0;
  return {
    universe: id,
    label: UNIVERSES.find((u) => u.id === id)?.label,
    symbols: symbols.length,
    covered: covered.length,
    history: dates.length ? { from: dates[0], to: dates.at(-1)!, sessions: dates.length, dates } : null,
    warmupDate: dates[WARMUP_SESSIONS - 1] ?? null,
    sync: { active, queued: progress.queued, message: progress.message, error: progress.phase === "error" ? progress.message : null },
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
    entry: raw.entry === "next-open" ? "next-open" : "signal-close",
    costPreset: preset in COST_PRESETS ? (preset as CostPresetId) : "futures-2026",
    slippage:
      slip && (slip.mode === "pct" || slip.mode === "ticks") ? { mode: slip.mode, value: num(slip.value, 0, 0, slip.mode === "pct" ? 2 : 50) } : undefined,
    sizing: raw.sizing === "shares" ? "shares" : "lots",
    oosFraction: num(raw.oosFraction, 0.3, 0.1, 0.5),
  };
}

/** Scan the bars, and hash exactly the bars it read. */
async function scanAndHash(input: { symbols: string[]; bars: Map<string, DailyBar[]>; membership: Membership | null; universe: string[] }): Promise<Scanned> {
  const benchmark = input.bars.get(BENCHMARK) ?? [];
  const scan = await scanSignals({
    symbols: input.symbols,
    getBars: (symbol) => input.bars.get(symbol) ?? [],
    benchmark,
    pause: yieldToEventLoop,
    isMember: input.membership?.isMember,
  });
  const data = await hashDataset({
    bars: input.bars,
    benchmark: BENCHMARK,
    membership: input.membership?.byDay ?? null,
    membershipWindow: input.membership?.window ?? null,
    universe: input.universe,
    hub: hubVersion(),
    cache: barHashes,
    pause: yieldToEventLoop,
  });
  return { scan, data };
}

/** The bars a run reads: every scanned symbol's and the benchmark's, up to `to` when the run is a replay. */
function barsFor(symbols: string[], to: number | null): Map<string, DailyBar[]> {
  const bars = new Map<string, DailyBar[]>();
  for (const symbol of [...symbols, BENCHMARK]) {
    const stored = screenerStore.getBars(symbol);
    // The same array when nothing is cut off, so its cached hash is reused.
    bars.set(symbol, to === null || (stored.at(-1)?.t ?? 0) <= to ? stored : stored.filter((bar) => bar.t <= to));
  }
  return bars;
}

interface ScanRun extends Scanned {
  key: string;
  cached: boolean;
  ms: number;
  membership: Membership | null;
}

async function scanFor(universe: string, pin: ReplayPin | null): Promise<ScanRun> {
  const { id, symbols, covered, scanned, membership } = await coveredSymbols(universe, { window: pin?.membership });
  if (!covered.length) throw new BacktestError(`No daily bars for this universe yet: they are read from the Market Data Hub. ${screenerStore.progress.message || "Try again in a moment."}`);
  const started = Date.now();
  if (pin) {
    // A replay: the stamped symbols (that are still in the universe), up to the stamped last session, scanned afresh.
    const allowed = new Set(pin.symbols);
    const replayed = scanned.filter((symbol) => allowed.has(symbol));
    const result = await scanAndHash({ symbols: replayed, bars: barsFor(replayed, pin.to), membership, universe: symbols });
    return { ...result, key: "replay", cached: false, ms: Date.now() - started, membership };
  }
  const lastSession = Math.max(...scanned.map((symbol) => screenerStore.getBars(symbol).at(-1)?.t ?? 0));
  const key = `${id}:${lastSession}:${scanned.length}:${membership?.key ?? "today"}:${BACKTEST_VERSION}`;
  let pending = scans.get(key);
  const cached = Boolean(pending);
  if (!pending) {
    // Concurrent requests share one scan; older scans of this universe are dropped.
    pending = scanAndHash({ symbols: scanned, bars: barsFor(scanned, null), membership, universe: symbols });
    for (const stale of [...scans.keys()].filter((entry) => entry.startsWith(`${id}:`))) scans.delete(stale);
    scans.set(key, pending);
    pending.catch(() => scans.delete(key));
  }
  const { scan, data } = await pending;
  const ms = Date.now() - started;
  if (!cached) log.info("Backtest scan", { universe: id, stocks: scan.symbols, sessions: scan.dates.length, signals: scan.signals, ms });
  return { scan, data, key, cached, ms, membership };
}

class BacktestError extends Error {}

async function execute(request: BacktestRequest, pin: ReplayPin | null): Promise<BacktestResponse> {
  if (!request.screenIds.length) return { status: "error", error: "Pick at least one strategy." };
  try {
    const { scan, data: scanData, key: scanKey, cached: scanCached, ms: scanMs, membership } = await scanFor(request.universe, pin);
    const preset = COST_PRESETS[request.costPreset].model;
    const costs: CostModel = request.slippage ? { ...preset, slippage: request.slippage } : preset;

    let lots: Record<string, number> | null = null;
    let lotNote: string | null = null;
    let pitLots: ReturnType<typeof pointInTimeLots> | null = null;
    let lotHistory: ReturnType<typeof lotHistoryPart> | null = null;
    if (request.sizing === "lots") {
      // Lots as of each session (and the split/bonus factors that convert them to the bars' shares), through asOf.
      const today = istParts().day;
      const window = membership?.window ?? pin?.membership ?? { from: today - DEEP_HISTORY_DAYS * DAY_MS, to: today };
      const timeline = await asOfSpan(window.from, window.to, { symbols: scanData.symbols, results: false });
      const current = orElse(timeline.at(today).lots, {});
      if (Object.keys(current).length) {
        lots = { ...current };
        pitLots = pointInTimeLots(timeline, current);
        lotHistory = lotHistoryPart(timeline.history, scanData.symbols);
      } else lotNote = "Futures lot sizes couldn't be loaded, so positions are sized in whole shares.";
    }
    const data = withDataPart(withDataPart(scanData, "lots", lots ? lotsOf(lots, scanData) : null), "lotHistory", lotHistory);

    const key = JSON.stringify([scanKey, request, data.hash]);
    const hit = pin ? undefined : results.get(key);
    if (hit) return { status: "ready", universe: request.universe, symbols: scan.symbols, result: hit.result, costs, runtime: { scanMs, simMs: 0, scanCached, cached: true }, stamp: hit.stamp };

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
      lotOn: pitLots?.lotOn,
      oosFraction: request.oosFraction,
    });
    if (lotNote) result.warnings.unshift(lotNote);
    if (pitLots) {
      const { from, to } = result.period;
      result.warnings.push(pitLots.note(scan.dates.filter((day) => day >= from && day <= to)));
    }
    if (request.universe === "fno") {
      const { from, to } = result.period;
      const sessions = scan.dates.filter((day) => day >= from && day <= to);
      result.warnings.push(universeNote({ sessions, byDay: membership?.byDay ?? new Map(), listOn: membership?.listOn, noHistory: membership?.noHistory ?? [] }));
    }
    const simMs = Date.now() - started;
    const stamp = makeStamp({ kind: "backtest", code: codeVersion(ENGINE), data, params: { ...request }, result, createdAt: Date.now() });
    if (!pin) {
      results.set(key, { result, stamp });
      while (results.size > MAX_RESULTS) results.delete(results.keys().next().value!);
    }
    return { status: "ready", universe: request.universe, symbols: scan.symbols, result, costs, runtime: { scanMs, simMs, scanCached, cached: false }, stamp };
  } catch (error) {
    if (error instanceof BacktestError || error instanceof BacktestInputError) return { status: "error", error: error.message };
    throw error;
  }
}

export const runBacktest = (request: BacktestRequest) => execute(request, null);

/**
 * "Re-run this": run a stamped backtest again from scratch (no cached scan or
 * result) with the stamp's parameters, on the stored bars up to its last
 * session. The answer carries its own stamp; the browser compares the two.
 */
export async function replayBacktest(body: unknown): Promise<BacktestResponse> {
  const stamp = parseStamp(body, "backtest");
  if (!stamp) return { status: "error", error: "That isn't a backtest stamp this version can replay." };
  return execute(parseBacktestRequest(stamp.params), pinOf(stamp));
}
