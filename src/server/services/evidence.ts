import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvidenceReplayResponse, EvidenceResponse } from "@/contracts/api";
import { COST_PRESETS, type CostPresetId } from "@/core/backtest/costs";
import { lotHistoryPart, pointInTimeLots } from "@/core/backtest/lots";
import { scanSignals } from "@/core/backtest/signals";
import { pointInTimeUniverse, universeNote } from "@/core/backtest/universe";
import { marketStates, replaySignals, roundTripPct, summarizeEvidence, type EvidenceTable } from "@/core/plan/evidence";
import { DAY_MS, istParts } from "@/core/market/session";
import { hashDataset, makeStamp, withDataPart, type RunStamp } from "@/core/repro/stamp";
import type { DailyBar } from "@/core/types";
import { DEEP_HISTORY_DAYS } from "@/server/providers/dailyBars";
import { screenerStore } from "@/server/providers/dailyStore";
import { asOfSpan, orElse, type ReferenceTimeline } from "@/server/providers/asOf";
import { liveRecord } from "@/server/services/btstRecord";
import { BENCHMARK } from "@/server/services/screener";
import { hubEndOfDay } from "@/server/providers/hub";
import { log } from "@/server/log";
import { codeVersion, hubVersion, parseStamp, pinOf, type ReplayPin } from "./runStamp";

// Strategy evidence for the daily plan (rules in src/core/plan/evidence.ts):
// every screen replayed over the F&O list's daily history — the five years the
// Market Data Hub serves, held by the screener's store (dailyStore) — split by
// NIFTY above / below its 200-day average.
//
// The replay takes ~10 s (features for ~220 stocks × ~1,200 sessions), so it
// runs in the background, yields to the event loop between sessions, and
// answers "computing" with its progress until it's done. The result changes
// once a day, so it's cached in memory and on disk (.cache/plan-evidence.json)
// keyed by the last stored session; a restart reads it back instead of
// replaying again.
//
// Reference data — the F&O list of each session, lot sizes — comes only
// through the point-in-time engine (asOf, src/server/providers/asOf.ts): a
// signal counts only if the stock had futures that session, and its costs use
// that session's lot where known (src/core/backtest/lots.ts).
//
// The table carries a run stamp (src/core/repro/stamp.ts): the hash of the bars,
// F&O lists and lot sizes it read, the commit and the parameters, and the hash
// of the table. `replayEvidence` computes a stamped table again from scratch on
// the bars up to its last session, so the browser can show whether it reproduces.

/** Bump when the replay or the statistics change, so cached tables are rebuilt. */
const EVIDENCE_VERSION = 3;
const ENGINE = `evidence/${EVIDENCE_VERSION}`;
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
  stamp: RunStamp;
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
  byDay: ReadonlyMap<number, ReadonlySet<string>>;
  /** The F&O list on a session as asOf knows it (null when unknown). */
  listOn: (day: number) => ReadonlySet<string> | null;
  today: string[];
  lastDay: number;
  /** Range the point-in-time F&O list was read for. */
  window: { from: number; to: number };
}

const globalForEvidence = globalThis as unknown as { planEvidence?: State };
const state = (globalForEvidence.planEvidence ??= { current: null, pending: null, error: null, keyMemo: null });

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Day key of the newest session whose daily bar is final: today only after 16:00 IST (like the store). */
function lastFinalDay(now = Date.now()): number {
  const { day, minutes } = istParts(now);
  return minutes >= 16 * 60 ? day : day - DAY_MS;
}

/** A symbol's stored bars up to `lastDay`. */
const barsThrough = (symbol: string, lastDay: number) => screenerStore.getBars(symbol).filter((bar) => bar.t <= lastDay);

/** Today's F&O list and the list of each session in `window`, as asOf knows them. */
async function membershipOver(window: { from: number; to: number }) {
  const timeline = await asOfSpan(window.from, window.to, { results: false, factors: false });
  const today = orElse(timeline.at(timeline.history.today).universe("fno"), []).map((member) => member.symbol);
  return { today, byDay: timeline.history.fo.byDay, listOn: listOnOf(timeline) };
}

const listOnOf = (timeline: ReferenceTimeline) => (day: number) => {
  const list = timeline.at(day).foList;
  return list.known ? list.value : null;
};

/** What the table would be computed from right now (cheap: the newest and oldest stored bar per symbol). */
async function keyInfo(): Promise<KeyInfo> {
  if (state.keyMemo && Date.now() - state.keyMemo.at < KEY_TTL_MS) return state.keyMemo.value;
  // Point-in-time F&O membership over the stored span, through asOf (cached).
  const day = istParts().day;
  const window = { from: day - DEEP_HISTORY_DAYS * DAY_MS, to: day };
  const { today, byDay, listOn } = await membershipOver(window);
  // Sorted, so the replay (and the order of tied signals) doesn't depend on the list's order.
  const symbols = byDay.size ? pointInTimeUniverse({ byDay, today, listOn }).symbols : [...today].sort();
  screenerStore.ensureFresh([...symbols, BENCHMARK]);
  await screenerStore.hasData([...symbols, BENCHMARK]);
  const lastDay = lastFinalDay();
  let last = 0;
  let first = Infinity;
  let covered = 0;
  for (const symbol of [...symbols, BENCHMARK]) {
    const bars = screenerStore.getBars(symbol);
    if (!bars.length) continue;
    covered += 1;
    first = Math.min(first, bars[0].t);
    const newest = bars.findLast((bar) => bar.t <= lastDay)?.t ?? 0;
    if (newest > last) last = newest;
  }
  const membership = byDay.size ? `pit${byDay.size}-${Math.max(...byDay.keys())}` : "today";
  // More symbols or a deeper history (the hub finished a download) changes the key too.
  const value = { key: `${last}:${covered}/${symbols.length}:${Number.isFinite(first) ? first : 0}:${membership}:${COST_PRESET}:${EVIDENCE_VERSION}`, symbols, byDay, listOn, today, lastDay, window };
  state.keyMemo = { at: Date.now(), value };
  return value;
}

async function readDisk(key: string): Promise<Computed | null> {
  try {
    const saved = JSON.parse(await readFile(CACHE_FILE, "utf8")) as Computed;
    return saved.key === key && saved.table?.screens && saved.stamp ? saved : null;
  } catch {
    return null;
  }
}

/** What the replay reads: the stamped symbols still in the F&O lists, up to the stamped last session. */
async function pinnedInfo(pin: ReplayPin): Promise<KeyInfo> {
  const window = pin.membership ?? { from: istParts().day - DEEP_HISTORY_DAYS * DAY_MS, to: istParts().day };
  const { today, byDay, listOn } = await membershipOver(window);
  const listed = new Set(byDay.size ? pointInTimeUniverse({ byDay, today, listOn }).symbols : today);
  const symbols = [...new Set(pin.symbols)].filter((symbol) => listed.has(symbol)).sort();
  await screenerStore.hasData([...symbols, BENCHMARK]);
  return { key: "replay", symbols, byDay, listOn, today, lastDay: pin.to, window };
}

async function compute(info: KeyInfo, progress: { done: number; total: number }): Promise<Computed> {
  const started = Date.now();
  const bars = new Map<string, DailyBar[]>();
  for (const symbol of [...info.symbols, BENCHMARK]) {
    const through = barsThrough(symbol, info.lastDay);
    if (through.length) bars.set(symbol, through);
    await yieldToEventLoop();
  }
  const pit = info.byDay.size ? pointInTimeUniverse({ byDay: info.byDay, today: info.today, listOn: info.listOn }) : null;
  const benchmark = bars.get(BENCHMARK) ?? [];
  const symbols = info.symbols.filter((symbol) => (bars.get(symbol)?.length ?? 0) > 0);
  if (symbols.length && benchmark.length < 200 && hubEndOfDay()) {
    throw new Error("The daily plan needs NIFTY's daily history to tell the market state. The Market Data Hub has no broker connected (end-of-day data), and NSE's index closes aren't in it yet (market-data-hub#23); screens and backtests work meanwhile.");
  }
  if (!symbols.length || benchmark.length < 200) throw new Error(`Not enough stored daily history yet: the evidence needs the F&O stocks' and NIFTY's daily bars, read from the Market Data Hub. ${screenerStore.progress.message}`.trim());

  progress.total = new Set(symbols.flatMap((symbol) => bars.get(symbol)!.map((bar) => bar.t))).size;
  const scan = await scanSignals({
    symbols,
    getBars: (symbol) => bars.get(symbol) ?? [],
    benchmark,
    isMember: pit?.isMember,
    pause: async () => {
      progress.done += 1;
      await yieldToEventLoop();
    },
  });
  // Each session's lot (in the bars' shares) where known, else today's; through asOf.
  const timeline = await asOfSpan(info.window.from, info.window.to, { symbols, results: false });
  const lots = orElse(timeline.at(timeline.history.today).lots, {});
  const pitLots = pointInTimeLots(timeline, lots);
  const states = marketStates(benchmark);
  const trades = replaySignals(scan, { costs: COST_PRESETS[COST_PRESET].model, lots, lotOn: pitLots.lotOn, states });
  const dates = scan.dates.filter((day) => day >= (scan.firstSignalDate ?? 0));
  const table = summarizeEvidence(trades, { dates, symbols: scan.symbols, lastState: states.get(benchmark.at(-1)!.t) ?? null });
  const noHistory = pit ? pit.symbols.filter((symbol) => !info.today.includes(symbol) && !(bars.get(symbol)?.length ?? 0)) : [];
  const lotNote = Object.keys(lots).length ? pitLots.note(dates) : "Lot sizes couldn't be loaded: costs assume ~₹5 lakh of shares.";
  const note = `${universeNote({ sessions: dates, byDay: info.byDay, listOn: info.listOn, noHistory })} ${lotNote}`;
  const hashed = await hashDataset({
    bars,
    benchmark: BENCHMARK,
    membership: info.byDay.size ? info.byDay : null,
    membershipWindow: info.byDay.size ? info.window : null,
    lots,
    universe: info.today,
    hub: hubVersion(),
    pause: yieldToEventLoop,
  });
  const data = withDataPart(hashed, "lotHistory", Object.keys(lots).length ? lotHistoryPart(timeline.history, symbols) : null);
  const computedAt = Date.now();
  const stamp = makeStamp({ kind: "evidence", code: codeVersion(ENGINE), data, params: { universe: "fno", costPreset: COST_PRESET }, result: { table, note }, createdAt: computedAt });
  const ms = computedAt - started;
  log.info("Strategy evidence computed", { stocks: scan.symbols, sessions: scan.dates.length, trades: trades.length, ms });
  return { key: info.key, table, computedAt, ms, note, stamp };
}

function start(info: KeyInfo) {
  const pending = { key: info.key, startedAt: Date.now(), done: 0, total: 0 };
  state.pending = pending;
  void compute(info, pending)
    .then(async (result) => {
      state.current = result;
      state.error = null;
      await mkdir(path.dirname(CACHE_FILE), { recursive: true });
      await writeFile(CACHE_FILE, JSON.stringify(result));
    })
    .catch((error: Error) => {
      log.error("Strategy evidence failed", { error });
      state.error = { key: info.key, message: error.message, at: Date.now() };
    })
    .finally(() => {
      state.pending = null;
    });
}

/** For the health page: the table in memory (the session it runs through, when computed), a computation running, the last failure. */
export function evidenceHealth(): { through: number | null; computedAt: number | null; pending: { startedAt: number; done: number; total: number } | null; error: { message: string; at: number } | null } {
  const through = Number(state.current?.key.split(":")[0]);
  return {
    through: Number.isFinite(through) && through > 0 ? through : null,
    computedAt: state.current?.computedAt ?? null,
    pending: state.pending ? { startedAt: state.pending.startedAt, done: state.pending.done, total: state.pending.total } : null,
    error: state.error ? { message: state.error.message, at: state.error.at } : null,
  };
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
    stamp: current!.stamp,
  };
}

/**
 * "Re-run this": compute a stamped evidence table again from scratch (not from
 * the cache) on the stored bars up to its last session. The answer carries its
 * own stamp; the browser compares the two.
 */
export async function replayEvidence(body: unknown): Promise<EvidenceReplayResponse> {
  const stamp = parseStamp(body, "evidence");
  if (!stamp) return { status: "error", error: "That isn't an evidence stamp this version can replay." };
  try {
    const result = await compute(await pinnedInfo(pinOf(stamp)), { done: 0, total: 0 });
    return { status: "ready", table: result.table, universeNote: result.note, ms: result.ms, stamp: result.stamp };
  } catch (error) {
    return { status: "error", error: (error as Error).message };
  }
}
