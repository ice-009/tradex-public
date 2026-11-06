import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvidenceResponse } from "@/contracts/api";
import { COST_PRESETS, type CostPresetId } from "@/core/backtest/costs";
import { scanSignals } from "@/core/backtest/signals";
import { pointInTimeUniverse, universeNote } from "@/core/backtest/universe";
import { marketStates, replaySignals, roundTripPct, summarizeEvidence, type EvidenceTable } from "@/core/plan/evidence";
import type { DailyBar } from "@/core/types";
import { screenerStore } from "@/server/providers/dailyStore";
import { deepDailyBars, lastFinalDay, lastStoredDay } from "@/server/providers/deepHistory";
import { foMembership } from "@/server/providers/foBhavStore";
import { getLotSizes } from "@/server/providers/lotSizes";
import { getUniverse } from "@/server/providers/universe";
import { liveRecord } from "@/server/services/btstRecord";
import { BENCHMARK } from "@/server/services/screener";

// Strategy evidence for the daily plan (rules in src/core/plan/evidence.ts):
// every screen replayed over the stored daily history of the F&O list — up to
// five years where "Download F&O history" has filled the market database —
// split by NIFTY above / below its 200-day average.
//
// Only data already on disk is read; this never asks a broker for history.
// The replay takes ~10 s (features for ~220 stocks × ~1,200 sessions), so it
// runs in the background, yields to the event loop between sessions, and
// answers "computing" with its progress until it's done. The result changes
// once a day, so it's cached in memory and on disk (.cache/plan-evidence.json)
// keyed by the last stored session; a restart reads it back instead of
// replaying again.

/** Bump when the replay or the statistics change, so cached tables are rebuilt. */
const EVIDENCE_VERSION = 1;
const COST_PRESET: CostPresetId = "futures-2026";
const CACHE_FILE = path.join(process.cwd(), ".cache", "plan-evidence.json");
/** How long a computed cache key is trusted before the stored history is checked again. */
const KEY_TTL_MS = 60_000;
const RETRY_AFTER_ERROR_MS = 60_000;

interface Computed {
  key: string;
  table: EvidenceTable;
  computedAt: number;
  ms: number;
  note: string;
}

interface State {
  current: Computed | null;
  pending: { key: string; startedAt: number; done: number; total: number } | null;
  error: { key: string; message: string; at: number } | null;
  keyMemo: { at: number; value: KeyInfo } | null;
}

interface KeyInfo {
  key: string;
  symbols: string[];
  byDay: Map<number, Set<string>>;
  today: string[];
  lastDay: number;
}

const globalForEvidence = globalThis as unknown as { planEvidence?: State };
const state = (globalForEvidence.planEvidence ??= { current: null, pending: null, error: null, keyMemo: null });

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** What the table would be computed from right now (cheap: series metadata only). */
async function keyInfo(): Promise<KeyInfo> {
  if (state.keyMemo && Date.now() - state.keyMemo.at < KEY_TTL_MS) return state.keyMemo.value;
  const today = (await getUniverse("fno")).map((member) => member.symbol);
  // Point-in-time F&O membership where the NSE F&O bhavcopy has been imported (disk only).
  const byDay = foMembership();
  const symbols = byDay.size ? pointInTimeUniverse({ byDay, today }).symbols : today;
  await screenerStore.hasData([...symbols, BENCHMARK]);
  const lastDay = lastFinalDay();
  const last = lastStoredDay([...symbols, BENCHMARK], (symbol) => screenerStore.getBars(symbol).at(-1)?.t ?? 0, lastDay);
  const membership = byDay.size ? `pit${byDay.size}-${Math.max(...byDay.keys())}` : "today";
  const value = { key: `${last}:${symbols.length}:${membership}:${COST_PRESET}:${EVIDENCE_VERSION}`, symbols, byDay, today, lastDay };
  state.keyMemo = { at: Date.now(), value };
  return value;
}

async function readDisk(key: string): Promise<Computed | null> {
  try {
    const saved = JSON.parse(await readFile(CACHE_FILE, "utf8")) as Computed;
    return saved.key === key && saved.table?.screens ? saved : null;
  } catch {
    return null;
  }
}

async function compute(info: KeyInfo): Promise<Computed> {
  const started = Date.now();
  const bars = new Map<string, DailyBar[]>();
  for (const symbol of [...info.symbols, BENCHMARK]) {
    bars.set(symbol, deepDailyBars(symbol, screenerStore.getBars(symbol), info.lastDay));
    await yieldToEventLoop();
  }
  const pit = info.byDay.size ? pointInTimeUniverse({ byDay: info.byDay, today: info.today }) : null;
  const benchmark = bars.get(BENCHMARK) ?? [];
  const symbols = info.symbols.filter((symbol) => (bars.get(symbol)?.length ?? 0) > 0);
  if (!symbols.length || benchmark.length < 200) throw new Error("Not enough stored daily history yet: the evidence needs the F&O stocks' and NIFTY's daily bars (Market data → Download F&O history).");

  const pending = state.pending!;
  pending.total = new Set(symbols.flatMap((symbol) => bars.get(symbol)!.map((bar) => bar.t))).size;
  const scan = await scanSignals({
    symbols,
    getBars: (symbol) => bars.get(symbol) ?? [],
    benchmark,
    isMember: pit?.isMember,
    pause: async () => {
      pending.done += 1;
      await yieldToEventLoop();
    },
  });
  const { lots } = await getLotSizes();
  const states = marketStates(benchmark);
  const trades = replaySignals(scan, { costs: COST_PRESETS[COST_PRESET].model, lots, states });
  const dates = scan.dates.filter((day) => day >= (scan.firstSignalDate ?? 0));
  const table = summarizeEvidence(trades, { dates, symbols: scan.symbols, lastState: states.get(benchmark.at(-1)!.t) ?? null });
  const noHistory = pit ? pit.symbols.filter((symbol) => !info.today.includes(symbol) && !(bars.get(symbol)?.length ?? 0)) : [];
  const note = universeNote({ sessions: dates, byDay: info.byDay, noHistory });
  const ms = Date.now() - started;
  console.info(`Strategy evidence: ${scan.symbols} stocks × ${scan.dates.length} sessions, ${trades.length} trades in ${ms} ms`);
  return { key: info.key, table, computedAt: Date.now(), ms, note };
}

function start(info: KeyInfo) {
  state.pending = { key: info.key, startedAt: Date.now(), done: 0, total: 0 };
  void compute(info)
    .then(async (result) => {
      state.current = result;
      state.error = null;
      await mkdir(path.dirname(CACHE_FILE), { recursive: true });
      await writeFile(CACHE_FILE, JSON.stringify(result));
    })
    .catch((error: Error) => {
      console.error("Strategy evidence failed", error);
      state.error = { key: info.key, message: error.message, at: Date.now() };
    })
    .finally(() => {
      state.pending = null;
    });
}

/** The evidence table, or "computing" (started in the background on first ask) with its progress. */
export async function strategyEvidence(): Promise<EvidenceResponse> {
  const info = await keyInfo();
  if (state.current?.key !== info.key) {
    const disk = await readDisk(info.key);
    if (disk) state.current = disk;
  }
  const current = state.current;
  if (current?.key !== info.key) {
    const failed = state.error?.key === info.key && Date.now() - state.error.at < RETRY_AFTER_ERROR_MS;
    if (failed && !state.pending) return { status: "error", error: state.error!.message };
    if (!state.pending) start(info);
    // An older table (yesterday's) is still a fine answer while today's is computed.
    if (!current) {
      const { startedAt, done, total } = state.pending!;
      return { status: "computing", startedAt, progress: { done, total } };
    }
  }
  const live = await liveRecord().catch(() => null);
  const preset = COST_PRESETS[COST_PRESET];
  return {
    status: "ready",
    table: current!.table,
    computedAt: current!.computedAt,
    ms: current!.ms,
    updating: Boolean(state.pending),
    universeNote: current!.note,
    costs: { preset: COST_PRESET, label: preset.label, roundTripPct: roundTripPct(preset.model) },
    live: live?.screens ?? null,
  };
}
