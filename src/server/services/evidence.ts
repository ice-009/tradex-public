import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvidenceReplayResponse, EvidenceResponse } from "@/contracts/api";
import { COST_PRESETS, type CostPresetId } from "@/core/backtest/costs";
import { lotHistoryPart, pointInTimeLots } from "@/core/backtest/lots";
import { scanSignals } from "@/core/backtest/signals";
import { STORE_DAYS, WARMUP_DAYS, clampToArchive, isLongRange, storeStart } from "@/core/backtest/phases";
import { pointInTimeUniverse, universeNote } from "@/core/backtest/universe";
import { marketStates, replaySignals, roundTripPct, summarizeEvidence, type EvidenceTable } from "@/core/plan/evidence";
import { spliceBenchmark } from "@/core/market/longHistory";
import { DAY_MS, istParts } from "@/core/market/session";
import { dayLabel, evidenceWindowStart } from "@/core/reference/timeMachine";
import { hashDataset, makeStamp, withDataPart, type RunStamp } from "@/core/repro/stamp";
import type { DailyBar } from "@/core/types";
import { DEEP_HISTORY_DAYS } from "@/server/providers/dailyBars";
import { screenerStore } from "@/server/providers/dailyStore";
import { asOfSpan, orElse, type ReferenceTimeline } from "@/server/providers/asOf";
import { BENCHMARK_STAND_IN, longWarnings } from "@/server/providers/longBars";
import { longBars } from "@/server/providers/longStore";
import { liveRecord } from "@/server/services/btstRecord";
import { BENCHMARK } from "@/server/services/screener";
import { hubEndOfDay } from "@/server/providers/hub";
import { log } from "@/server/log";
import { codeVersion, hubVersion, parseStamp, pinOf, type ReplayPin } from "./runStamp";
import { pastBars, type PastDay } from "./timeMachine";

// Strategy evidence for the daily plan (rules in src/core/plan/evidence.ts):
// every screen replayed over the F&O list's daily history — the five years the
// Market Data Hub serves, held by the screener's store (dailyStore) — split by
// NIFTY above / below its 200-day average.
//
// The plan always uses that default window. Any other period can be checked
// too (`strategyEvidence(range)`: a market phase, or dates back to 1994): it is
// computed in the background the same way, from the store inside its 5 years
// and from the hub's long history before them (providers/longBars.ts), counts
// only the period's own sessions (what comes before is warm-up), and is kept in
// memory only. Its stamp records the period, so "Re-run this" replays it.
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
// The Time Machine (issue #31, `strategyEvidence(null, past)`) computes the
// table a past day's plan would have had: the same five years, ending that
// day, on bars up to its close only — so every trade counted had closed by
// then (a signal needs its whole holding period inside the bars) — with the
// F&O lists and lots as known by then (the day's own list and lots stand in
// where an earlier session's aren't known, never today's). Kept in memory per
// day; the browser polls "computing" meanwhile, as for the plan's own table.
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
  /**
   * A chosen period (`strategyEvidence(range)`): its first session (trades and
   * sessions before it are warm-up only), where its bars come from, and its
   * warnings. Absent for the plan's default (the store's 5 years).
   */
  range?: { from: number; to: number; barsOf: (symbol: string) => DailyBar[]; notes: string[] };
  /** Time Machine: the past day the table is as of (stand-ins are that day's, never today's). */
  asOf?: number;
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

/**
 * Today's F&O list and the list of each session in `window`, as asOf knows them.
 * `asOf` (Time Machine): that day's list takes today's place as the stand-in for
 * sessions with no list, so nothing from after the day is read.
 */
async function membershipOver(window: { from: number; to: number }, asOf?: number) {
  const timeline = await asOfSpan(window.from, window.to, { results: false, factors: false });
  const stand = asOf === undefined ? timeline.at(timeline.history.today).universe("fno") : timeline.at(asOf).universe("fno");
  const today = orElse(stand, []).map((member) => member.symbol);
  return { today, byDay: timeline.history.fo.byDay, listOn: listOnOf(timeline), standInKnown: stand.known };
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
    const through = info.range ? info.range.barsOf(symbol).filter((bar) => bar.t <= info.lastDay) : barsThrough(symbol, info.lastDay);
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
  // Time Machine: else that day's lot (in the bars' shares), else ~₹5 lakh of shares — never today's.
  const timeline = await asOfSpan(info.window.from, info.window.to, { symbols, results: false });
  const lots = info.asOf === undefined ? orElse(timeline.at(timeline.history.today).lots, {}) : lotsInBarShares(timeline.at(info.asOf), symbols);
  const pitLots = pointInTimeLots(timeline, lots, info.asOf === undefined ? undefined : `${dayLabel(info.asOf)}'s lot sizes`);
  const states = marketStates(benchmark);
  // A chosen period counts its own sessions only: what comes before is warm-up.
  const first = Math.max(scan.firstSignalDate ?? 0, info.range?.from ?? 0);
  const trades = replaySignals(scan, { costs: COST_PRESETS[COST_PRESET].model, lots, lotOn: pitLots.lotOn, states }).filter((trade) => !info.range || trade.date >= first);
  const dates = scan.dates.filter((day) => day >= first);
  if (info.range && dates.length < 2) throw new Error("The period has fewer than two sessions with enough history to replay.");
  const table = summarizeEvidence(trades, { dates, symbols: scan.symbols, lastState: states.get(benchmark.at(-1)!.t) ?? null });
  const noHistory = pit ? pit.symbols.filter((symbol) => !info.today.includes(symbol) && !(bars.get(symbol)?.length ?? 0)) : [];
  const lotNote = Object.keys(lots).length ? pitLots.note(dates) : info.asOf !== undefined ? `Lot sizes for ${dayLabel(info.asOf)} aren't known (NSE's F&O files carry them from 8 Jul 2024): costs assume ~₹5 lakh of shares where a session's own lot isn't known.` : "Lot sizes couldn't be loaded: costs assume ~₹5 lakh of shares.";
  const note = [`${universeNote({ sessions: dates, byDay: info.byDay, listOn: info.listOn, noHistory })} ${lotNote}`, ...(info.range?.notes ?? [])].join(" ");
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
  const stamp = makeStamp({ kind: "evidence", code: codeVersion(ENGINE), data, params: { universe: "fno", costPreset: COST_PRESET, ...(info.range ? { from: info.range.from, to: info.range.to } : {}), ...(info.asOf !== undefined ? { asOf: info.asOf } : {}) }, result: { table, note }, createdAt: computedAt });
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

// ------------------------------------------------------------------ a chosen period

/** A period asked for (day keys; null: the store's start / the newest session). */
export interface EvidenceRange {
  from: number | null;
  to: number | null;
}

interface RangeState {
  current: Computed | null;
  pending: { startedAt: number; done: number; total: number } | null;
  error: { message: string; at: number } | null;
}

/** Periods kept in memory (each one's table; a long period's bars live in longBars). */
const MAX_RANGES = 4;
const globalForRanges = globalThis as unknown as { planEvidenceRanges?: Map<string, RangeState> };
const ranges = (globalForRanges.planEvidenceRanges ??= new Map());

/** A period's first and last session, clamped to NSE's archive and the newest final session. */
function resolveRange(range: EvidenceRange): { from: number; to: number } {
  const lastDay = lastFinalDay();
  return { from: clampToArchive(range.from ?? storeStart(istParts().day)), to: Math.min(range.to ?? lastDay, lastDay) };
}

/**
 * What a chosen period's table is computed from: the F&O list over the period
 * and its warm-up, and the bars — the screener's store inside its 5 years, the
 * hub's long history (providers/longBars.ts) before them, with NIFTY's
 * stand-in before 2012. `pin`: a replay's symbols and last session.
 */
async function rangeInfo(range: { from: number; to: number }, pin: ReplayPin | null): Promise<KeyInfo> {
  const to = pin?.to ?? range.to;
  const readFrom = clampToArchive(range.from - WARMUP_DAYS * DAY_MS);
  const window = pin?.membership ?? { from: readFrom, to };
  const { today, byDay, listOn } = await membershipOver(window);
  let symbols = byDay.size ? pointInTimeUniverse({ byDay, today, listOn }).symbols : [...today].sort();
  if (pin) {
    const allowed = new Set(pin.symbols);
    symbols = symbols.filter((symbol) => allowed.has(symbol));
  }
  const base = { key: `range:${range.from}:${to}`, symbols, byDay, listOn, today, lastDay: to, window };
  if (!isLongRange(range.from, istParts().day)) {
    await screenerStore.hasData([...symbols, BENCHMARK]);
    return { ...base, range: { from: range.from, to, barsOf: (symbol) => screenerStore.getBars(symbol).filter((bar) => bar.t >= readFrom), notes: [] } };
  }
  const set = await longBars.load([...symbols, BENCHMARK, BENCHMARK_STAND_IN], readFrom, to);
  const benchmark = spliceBenchmark(set.bars.get(BENCHMARK) ?? [], set.bars.get(BENCHMARK_STAND_IN) ?? []);
  const scanned = symbols.filter((symbol) => set.bars.has(symbol));
  const notes = longWarnings({ from: readFrom, to, set, standInUntil: benchmark.standInUntil }, scanned.length);
  return { ...base, range: { from: range.from, to, barsOf: (symbol) => (symbol === BENCHMARK ? benchmark.bars : (set.bars.get(symbol) ?? [])), notes } };
}

/** A chosen period's evidence: computed in the background on first ask, like the plan's. Not cached on disk. */
function rangeEvidence(range: EvidenceRange): EvidenceResponse {
  const resolved = resolveRange(range);
  if (resolved.from >= resolved.to) return { status: "error", error: "The period ends before it starts." };
  const key = `${resolved.from}:${resolved.to}`;
  let entry = ranges.get(key);
  const failedLongAgo = entry?.error && Date.now() - entry.error.at >= RETRY_AFTER_ERROR_MS;
  if (!entry || (failedLongAgo && !entry.pending)) {
    const fresh: RangeState = { current: null, pending: { startedAt: Date.now(), done: 0, total: 0 }, error: null };
    entry = fresh;
    ranges.delete(key);
    ranges.set(key, fresh);
    while (ranges.size > MAX_RANGES) ranges.delete(ranges.keys().next().value!);
    void rangeInfo(resolved, null)
      .then((info) => compute(info, fresh.pending!))
      .then((result) => {
        fresh.current = result;
      })
      .catch((error: Error) => {
        log.error("Strategy evidence for a period failed", { error, from: resolved.from, to: resolved.to });
        fresh.error = { message: error.message, at: Date.now() };
      })
      .finally(() => {
        fresh.pending = null;
      });
  }
  if (entry.error && !entry.current) return { status: "error", error: entry.error.message };
  if (!entry.current) {
    const { startedAt, done, total } = entry.pending ?? { startedAt: Date.now(), done: 0, total: 0 };
    return { status: "computing", startedAt, progress: { done, total } };
  }
  const preset = COST_PRESETS[COST_PRESET];
  const current = entry.current;
  return { status: "ready", table: current.table, computedAt: current.computedAt, ms: current.ms, updating: false, universeNote: current.note, costs: { preset: COST_PRESET, label: preset.label, roundTripPct: roundTripPct(preset.model) }, live: null, stamp: current.stamp };
}

/**
 * The evidence table, or "computing" (started in the background on first ask)
 * with its progress. Without a range: the plan's table over the store's 5
 * years. With one: that period's (a market phase, or any dates back to 1994).
 */
export async function strategyEvidence(range: EvidenceRange | null = null, past: PastDay | null = null): Promise<EvidenceResponse> {
  if (past) {
    if (range && (range.from !== null || range.to !== null)) return { status: "error", error: "A chosen period's evidence isn't available in the Time Machine: it could reach past the day shown." };
    return pastEvidence(past.day);
  }
  if (range && (range.from !== null || range.to !== null)) return rangeEvidence(range);
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
    const from = Number(stamp.params.from);
    const to = Number(stamp.params.to);
    const asOf = Number(stamp.params.asOf);
    // A past day's table (Time Machine) replays that day; a chosen period's, that period; the plan's, the store's 5 years.
    const info = Number.isFinite(asOf) ? await pastInfo(asOf, pinOf(stamp)) : Number.isFinite(from) && Number.isFinite(to) ? await rangeInfo({ from, to }, pinOf(stamp)) : await pinnedInfo(pinOf(stamp));
    const result = await compute(info, { done: 0, total: 0 });
    return { status: "ready", table: result.table, universeNote: result.note, ms: result.ms, stamp: result.stamp };
  } catch (error) {
    return { status: "error", error: (error as Error).message };
  }
}

// ------------------------------------------------------------------ a past day (Time Machine)

/** Past days' tables kept in memory (most recently asked last). */
const MAX_PAST_DAYS = 6;
const globalForPast = globalThis as unknown as { planEvidencePast?: Map<number, RangeState> };
const pastTables = (globalForPast.planEvidencePast ??= new Map());

/** A day's lots in the bars' (today-adjusted) shares, for the stocks it knows them for; {} when that day's lots aren't known. */
function lotsInBarShares(snapshot: ReturnType<ReferenceTimeline["at"]>, symbols: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const symbol of symbols) {
    const lot = snapshot.lotInTodayShares(symbol);
    if (lot.known) out[symbol] = lot.value;
  }
  return out;
}

/**
 * What a past day's table is computed from: the five years ending that day
 * (and the features' warm-up before them), every stock that was on an F&O
 * list in that time, its bars up to the day's close read from the hub's long
 * history, and NIFTY (its equal-weight stand-in before 2012).
 */
async function pastInfo(day: number, pin: ReplayPin | null): Promise<KeyInfo> {
  const from = evidenceWindowStart(day, STORE_DAYS);
  const readFrom = clampToArchive(from - WARMUP_DAYS * DAY_MS);
  const window = pin?.membership ?? { from: readFrom, to: day };
  const { today: dayList, byDay, listOn, standInKnown } = await membershipOver(window, day);
  let symbols = byDay.size ? pointInTimeUniverse({ byDay, today: dayList, listOn }).symbols : [...dayList].sort();
  if (pin) {
    const allowed = new Set(pin.symbols);
    symbols = symbols.filter((symbol) => allowed.has(symbol));
  }
  if (!symbols.length) throw new Error(`No F&O list is known for ${dayLabel(day)} or the five years before it.`);
  const set = await pastBars(day, [...symbols, BENCHMARK, BENCHMARK_STAND_IN], readFrom).promise;
  const benchmark = spliceBenchmark(set.bars.get(BENCHMARK) ?? [], set.bars.get(BENCHMARK_STAND_IN) ?? []);
  const notes = [...set.notes];
  if (benchmark.standInUntil !== null) notes.push(`NIFTY's history up to ${dayLabel(benchmark.standInUntil)} isn't in NSE's index file: the market state uses the hub's equal-weight NIFTY 50 basket there (built from today's members).`);
  if (!standInKnown) notes.push(`The F&O list of ${dayLabel(day)} isn't known, so sessions without a list of their own have none to stand in.`);
  const barsOf = (symbol: string) => (symbol === BENCHMARK ? benchmark.bars : (set.bars.get(symbol) ?? []));
  return { key: `asof:${day}`, symbols, byDay, listOn, today: dayList, lastDay: day, window, range: { from, to: day, barsOf, notes }, asOf: day };
}

/** A past day's table: computed in the background on first ask, kept in memory per day. */
function pastEvidence(day: number): EvidenceResponse {
  let entry = pastTables.get(day);
  const failedLongAgo = entry?.error && Date.now() - entry.error.at >= RETRY_AFTER_ERROR_MS;
  if (!entry || (failedLongAgo && !entry.pending)) {
    const fresh: RangeState = { current: null, pending: { startedAt: Date.now(), done: 0, total: 0 }, error: null };
    entry = fresh;
    pastTables.set(day, fresh);
    while (pastTables.size > MAX_PAST_DAYS) pastTables.delete(pastTables.keys().next().value!);
    void pastInfo(day, null)
      .then((info) => compute(info, fresh.pending!))
      .then((result) => {
        fresh.current = result;
      })
      .catch((error: Error) => {
        log.error("Strategy evidence for a past day failed", { error, day: new Date(day).toISOString().slice(0, 10) });
        fresh.error = { message: error.message, at: Date.now() };
      })
      .finally(() => {
        fresh.pending = null;
      });
  } else {
    pastTables.delete(day);
    pastTables.set(day, entry);
  }
  if (entry.error && !entry.current) return { status: "error", error: entry.error.message };
  if (!entry.current) {
    const { startedAt, done, total } = entry.pending ?? { startedAt: Date.now(), done: 0, total: 0 };
    return { status: "computing", startedAt, progress: { done, total } };
  }
  const preset = COST_PRESETS[COST_PRESET];
  const current = entry.current;
  // No live record: it is what the BTST setups did after the day too.
  return { status: "ready", table: current.table, computedAt: current.computedAt, ms: current.ms, updating: false, universeNote: current.note, costs: { preset: COST_PRESET, label: preset.label, roundTripPct: roundTripPct(preset.model) }, live: null, stamp: current.stamp, asOf: day };
}
