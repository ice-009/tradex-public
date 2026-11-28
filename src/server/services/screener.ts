import "server-only";

import type { ScreenerResponse, TrackResult } from "@/contracts/api";
import { ARCHIVE_START } from "@/core/backtest/phases";
import { spliceBenchmark } from "@/core/market/longHistory";
import { dayLabel, isoDay } from "@/core/reference/timeMachine";
import type { UniverseMember } from "@/core/reference/pointInTime";
import { computeFeatures } from "@/core/screener/features";
import { runTrackRecord } from "@/core/screener/backtest";
import { buildFeatureSets, marketOverview, runScreens } from "@/core/screener/run";
import { emptyFresh, freshKey, updateFresh, type FreshState } from "@/core/screener/fresh";
import { marketRegime } from "@/core/screener/regime";
import { sectorIndexStat, sectorSources, strengthRanks, type SectorIndexStat, type SectorSource } from "@/core/screener/sectorIndex";
import { sectorRrg } from "@/core/sector/rrg";
import { RS_BENCHMARK } from "@/core/sector/series";
import { latestOiFacts } from "@/server/providers/foData";
import { optionFactsNow, optionFactsWithin, type OptionFacts } from "@/server/providers/options";
import { DEEP_HISTORY_DAYS } from "@/server/providers/dailyBars";
import { updateBtstRecord } from "@/server/services/btstRecord";
import type { ScreenerRow } from "@/core/screener/screens";
import { DAY_MS, SESSION_CLOSE_MIN, SESSION_OPEN_MIN, istParts } from "@/core/market/session";
import type { DailyBar } from "@/core/types";
import { screenerStore } from "@/server/providers/dailyStore";
import { UNIVERSES, isUniverseId, type UniverseId } from "@/server/providers/universe";
import { asOf, orElse } from "@/server/providers/asOf";
import { BENCHMARK_STAND_IN } from "@/server/providers/longBars";
import { PAST_SCREEN_DAYS, replayBars, scaleBars, scalesOn, storeBarsThrough, storeCovers, type PastBars, type PastDay } from "@/server/services/timeMachine";
import { log } from "@/server/log";

// Screener and track-record orchestration: load bars (dailyStore, filled from
// the Market Data Hub), hand them to the engine (src/core/screener), shape the
// API response.
//
// NIFTY (the market regime's 200-day average, and relative strength's 6-month
// benchmark) and the sector indices come from the hub's daily index history
// (NSE's index file, 2012 on), so they reach back as far as the stocks' bars.
// Sector strength ranks each industry by its sector index's 1-month return —
// a synthetic equal-weight basket where no NSE index has that much history —
// and by the median of the universe's own stocks when the hub has neither.
//
// Reference data (the universe, the sector map, the F&O ban list) is read only
// through the point-in-time engine, as of today (asOf, src/server/providers/asOf.ts).
//
// The Time Machine (issue #31, `runScreener(universe, false, past)`) runs the
// same screens as of a past day's close: bars up to that day only (the store,
// or the hub's long history for that day), prices adjusted only for the
// splits and bonuses by then, that day's F&O list, ban list and sector map;
// no live bar, no OI tag (today's), no first-seen times, no BTST record.

export const BENCHMARK = "NIFTY";
/** A sector index is used when its history starts within this many days of the stocks' window. */
const SECTOR_HISTORY_SLACK_DAYS = 30;
/** Below this share of the universe with history, keep showing the sync progress instead of results. */
const MIN_COVERAGE = 0.95;
/** Bump when the replay rules change so a running server drops cached results. */
const TRACK_VERSION = 6;

export function parseUniverse(value: string | null): UniverseId {
  return value && isUniverseId(value) ? value : "nifty200";
}

/** Runs every screen over the universe in one pass; the first call for a universe starts a background history sync. */
// First-seen times per universe, so new setups can be told apart from the morning's.
const globalForFresh = globalThis as unknown as { screenerFresh?: Map<string, FreshState> };
const freshByUniverse = (globalForFresh.screenerFresh ??= new Map());

function stampFirstSeen(universeId: string, results: Record<string, ScreenerRow[]>) {
  const now = Date.now();
  const keys = Object.entries(results).flatMap(([screenId, rows]) => rows.map((row) => freshKey(screenId, row.symbol)));
  const state = updateFresh(freshByUniverse.get(universeId) ?? emptyFresh(0), istParts(now).day, keys, now);
  freshByUniverse.set(universeId, state);
  for (const [screenId, rows] of Object.entries(results)) for (const row of rows) row.firstSeenAt = state.seen[freshKey(screenId, row.symbol)]?.first;
}

/** Every screen over the universe: live (today, with the forming bar when `useLive`), or as of a past day's close (`past`). */
export async function runScreener(universeId: UniverseId, useLive: boolean, past: PastDay | null = null): Promise<ScreenerResponse> {
  if (past) return runScreenerAsOf(universeId, past);
  const known = await asOf();
  const members = orElse(known.universe(universeId), []);
  const symbols = members.map((member) => member.symbol);
  const catalog = orElse(known.sectors, { available: false, indices: [], sectors: [] });
  const needFrom = istParts().day - (DEEP_HISTORY_DAYS - SECTOR_HISTORY_SLACK_DAYS) * DAY_MS;
  const sources = sectorSources(catalog, members.map((member) => member.industry || "Other"), needFrom);
  const sectorSymbols = [...new Set([...sources.values()].map((source) => source.symbol))];
  // NIFTY 500: the sectors' Relative Rotation Graph benchmark (issue #30).
  const sectorBenchmark = sectorSymbols.length ? [RS_BENCHMARK] : [];
  screenerStore.ensureFresh([...symbols, BENCHMARK, ...sectorBenchmark, ...sectorSymbols]);
  await screenerStore.hasData([...symbols, BENCHMARK, ...sectorBenchmark, ...sectorSymbols]);

  const covered = symbols.filter((symbol) => screenerStore.getBars(symbol).length > 0);
  const progress = screenerStore.progress;
  const universe = { id: universeId, label: UNIVERSES.find((u) => u.id === universeId)?.label, count: symbols.length, covered: covered.length };

  if (covered.length < symbols.length * MIN_COVERAGE) {
    // Reading from the hub, or waiting while the hub downloads symbols it doesn't hold yet.
    if (screenerStore.isSyncing() || progress.queued > 0) return { status: "syncing", progress, universe };
    return { status: "error", error: progress.message || "No screener data available yet.", progress, universe };
  }

  const snapshot = useLive ? await screenerStore.liveSnapshot([...covered, BENCHMARK]) : { bars: new Map<string, DailyBar>(), quotesAt: null, paceMs: null, fromTicks: 0 };
  const live = snapshot.bars;
  const ban = banList(known.ban);
  // Futures OI from the hub's newest F&O bhavcopy day (GET /v1/fo/oi/day, cached; never waits).
  // Shown next to the setup, never scored: OI buildup showed no edge on its own in testing.
  const stored = (symbol: string) => screenerStore.getBars(symbol);
  const { results, market, regime, sets } = screenUniverse({ covered, members, stored, benchmark: stored(BENCHMARK), rrgBenchmark: sectorBenchmark.length ? stored(RS_BENCHMARK) : [], live, sources, ban, oi: latestOiFacts(), options: liveOptionFacts(), firstSeen: (found) => stampFirstSeen(universeId, found) });
  const now = Date.now();
  // BTST live record: matches seen 3:10–3:25 PM, settled at the next open (no extra API calls).
  if (useLive) updateBtstRecord({ results, live, banned: new Set(ban.symbols), now });
  const { minutes, weekday } = istParts(now);
  const marketHours = weekday !== 0 && weekday !== 6 && minutes >= SESSION_OPEN_MIN + 2 && minutes <= SESSION_CLOSE_MIN;

  return {
    status: "ready",
    syncing: screenerStore.isSyncing(),
    progress,
    universe,
    asOf: {
      eodDate: Math.max(0, ...sets.eod.map((feature) => feature.date)),
      live: live.size > 0,
      computedAt: now,
      quotesAt: snapshot.quotesAt,
      paceMs: snapshot.paceMs,
      fromTicks: snapshot.fromTicks,
      stale: useLive && marketHours && live.size === 0,
    },
    results,
    market,
    regime,
    ban,
  };
}

const banList = (fact: Awaited<ReturnType<typeof asOf>>["ban"]) => (fact.known ? { available: true, tradeDate: fact.asOf, symbols: [...fact.value] } : { available: false, tradeDate: null, symbols: [] });

/** NSE's index file starts in Feb 2012: a look-back before it needs NIFTY's equal-weight stand-in. */
const NIFTY_FILE_START = Date.UTC(2012, 1, 1);
/** How long a request waits for a past day's bars before answering "syncing" (the browser polls). */
const PAST_WAIT_MS = 1_500;

type PastUniverse =
  | { status: "pending"; progress: { done: number; total: number } }
  | { status: "error"; error: string }
  | {
      status: "ready";
      members: UniverseMember[];
      symbols: string[];
      sources: Map<string, SectorSource>;
      /** Bars up to the day, prices as adjusted then. */
      barsOf: (symbol: string) => DailyBar[];
      benchmark: DailyBar[];
      ban: ReturnType<typeof banList>;
      notes: string[];
      set: PastBars;
    };

/**
 * A universe as of a past day: its members that day (the F&O list of the day;
 * index lists are today's snapshot, said in the notes), the sector indices with
 * history by then, and every stock's bars up to the day's close.
 */
async function pastUniverse(universeId: UniverseId, past: PastDay): Promise<PastUniverse> {
  const { day } = past;
  const known = await asOf(day);
  const notes: string[] = past.note ? [past.note] : [];
  const listed = known.universe(universeId);
  let members: UniverseMember[];
  if (listed.known) members = [...listed.value];
  else {
    members = [...orElse((await asOf()).universe(universeId), [])];
    notes.push(`${listed.reason} Today's list stands in: stocks that joined it later are included and those that left it are missing (survivorship bias).`);
  }
  if (!members.length) return { status: "error", error: `No ${universeId} list for ${dayLabel(day)}.` };
  notes.push("Industries are today's classification (NSE's index lists); sector indices count only from their first session.");
  const symbols = members.map((member) => member.symbol);
  const from = Math.max(ARCHIVE_START, day - PAST_SCREEN_DAYS * DAY_MS);
  const catalog = orElse(known.sectors, { available: false, indices: [], sectors: [] });
  const sources = sectorSources(catalog, members.map((member) => member.industry || "Other"), from + SECTOR_HISTORY_SLACK_DAYS * DAY_MS);
  const sectorSymbols = [...new Set([...sources.values()].map((source) => source.symbol))];
  const indices = new Set([BENCHMARK, BENCHMARK_STAND_IN, ...(sectorSymbols.length ? [RS_BENCHMARK] : []), ...sectorSymbols]);
  const wanted = [...symbols, ...indices].filter((symbol) => symbol !== BENCHMARK_STAND_IN || from < NIFTY_FILE_START);

  let set: PastBars;
  if (storeCovers(from)) set = await storeBarsThrough(day, wanted);
  else {
    const handle = replayBars(past, wanted, from);
    const ready = handle.ready ?? (await Promise.race([handle.promise.catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), PAST_WAIT_MS))]));
    if (!ready) {
      const again = replayBars(past, wanted, from);
      return again.error ? { status: "error", error: again.error } : { status: "pending", progress: again.progress };
    }
    set = ready;
  }
  const { scaleOf, note } = await scalesOn(day, symbols, indices);
  if (note) notes.push(note);
  notes.push(...set.notes);
  const memo = new Map<string, DailyBar[]>();
  const barsOf = (symbol: string) => {
    let bars = memo.get(symbol);
    if (!bars) memo.set(symbol, (bars = scaleBars(set.bars.get(symbol) ?? [], scaleOf(symbol))));
    return bars;
  };
  const spliced = spliceBenchmark(set.bars.get(BENCHMARK) ?? [], set.bars.get(BENCHMARK_STAND_IN) ?? []);
  if (spliced.standInUntil !== null) notes.push(`NIFTY's history up to ${dayLabel(spliced.standInUntil)} isn't in NSE's index file: the market regime and relative strength use the hub's equal-weight NIFTY 50 basket there (built from today's members).`);
  const ban = banList(known.ban);
  if (!known.ban.known) notes.push(known.ban.reason);
  return { status: "ready", members, symbols, sources, barsOf, benchmark: spliced.bars, ban, notes, set };
}

/** The screener as of a past day's close (the Time Machine). */
async function runScreenerAsOf(universeId: UniverseId, past: PastDay): Promise<ScreenerResponse> {
  const label = UNIVERSES.find((u) => u.id === universeId)?.label;
  const found = await pastUniverse(universeId, past);
  if (found.status === "error") return { status: "error", error: found.error, universe: { id: universeId, label, count: 0, covered: 0 } };
  if (found.status === "pending") {
    const { done, total } = found.progress;
    const message = `Reading daily bars up to ${dayLabel(past.day)} from the Market Data Hub (${done}/${total} symbols)`;
    return { status: "syncing", progress: { phase: "history", done, total, message, queued: 0 }, universe: { id: universeId, label, count: total, covered: 0 } };
  }
  const covered = found.symbols.filter((symbol) => found.barsOf(symbol).length > 0);
  const universe = { id: universeId, label, count: found.symbols.length, covered: covered.length };
  const progress = { phase: "done" as const, done: covered.length, total: found.symbols.length, message: `Daily bars up to ${dayLabel(past.day)} (${found.set.source === "store" ? "stored" : "read from the Market Data Hub for that day"})`, queued: 0 };
  if (found.set.source === "store" && covered.length < found.symbols.length * MIN_COVERAGE && (screenerStore.isSyncing() || screenerStore.progress.queued > 0)) return { status: "syncing", progress: screenerStore.progress, universe };
  if (!covered.length) return { status: "error", error: `No daily bars up to ${dayLabel(past.day)} for ${label ?? universeId}.`, progress, universe };
  const notes = [...found.notes];
  const missing = found.symbols.length - covered.length;
  if (missing) notes.push(`${missing} of the list's ${found.symbols.length} stocks have no daily bars up to that day (not listed yet, or not held by the hub).`);
  notes.push("No live bar, no open-interest tag (the hub keeps today's) and no BTST live record in the Time Machine.");
  // Option facts as of D: the hub's newest option day on or before D, its iv30 ranked against the year before (#36).
  const options = await optionFactsWithin(isoDay(past.day), true, OPTION_FACTS_WAIT_MS);
  const { results, market, regime, sets } = screenUniverse({ covered, members: found.members, stored: found.barsOf, benchmark: found.benchmark, rrgBenchmark: found.sources.size ? found.barsOf(RS_BENCHMARK) : [], live: new Map(), sources: found.sources, ban: found.ban, oi: null, options });
  return {
    status: "ready",
    syncing: false,
    progress,
    universe,
    asOf: { eodDate: Math.max(0, ...sets.eod.map((feature) => feature.date)), live: false, computedAt: Date.now(), quotesAt: null, paceMs: null, fromTicks: 0, stale: false },
    results,
    market,
    regime,
    ban: found.ban,
    timeMachine: { day: past.day, notes },
  };
}

interface ScreenInput {
  covered: string[];
  members: readonly UniverseMember[];
  /** Stored (end-of-day) bars per symbol. */
  stored: (symbol: string) => DailyBar[];
  /** NIFTY's stored bars ([] when the hub has none). */
  benchmark: DailyBar[];
  /** NIFTY 500's bars, the sectors' Relative Rotation Graph benchmark ([]: no RRG). */
  rrgBenchmark: DailyBar[];
  /** Today's forming bar per symbol (empty: end of day, or a past day). */
  live: Map<string, DailyBar>;
  sources: Map<string, SectorSource>;
  ban: { available: boolean; tradeDate: number | null; symbols: string[] };
  oi: ReturnType<typeof latestOiFacts>;
  /** Option facts per symbol (iv30, its rank, the straddle's move): shown, never scored. */
  options?: OptionFacts | null;
  firstSeen?: (results: Record<string, ScreenerRow[]>) => void;
}

/** Every screen over the covered stocks, the market overview, the regime and sector strength, with the ban list and OI tags on the rows. */
function screenUniverse(input: ScreenInput) {
  const { covered, members, stored, live, sources, ban, oi } = input;
  const sets = buildFeatureSets(covered, stored, live);
  const benchToday = live.get(BENCHMARK);
  // No NIFTY bars (a hub in end-of-day mode has no index history yet): relative strength and the regime go without it.
  const benchBars = benchToday ? [...input.benchmark, benchToday] : input.benchmark;
  const nifty = benchBars.length ? computeFeatures(BENCHMARK, benchBars, Boolean(benchToday)) : { ret126: NaN, close: NaN, sma50: NaN, sma200: NaN };
  const memberBySymbol = new Map(members.map((member) => [member.symbol, member]));

  const byScreen = runScreens(sets, { niftyRet126: nifty.ret126 }, memberBySymbol);
  input.firstSeen?.(byScreen);
  const market = marketOverview(sets.live, memberBySymbol);

  // Market regime: NIFTY's trend and how much of the universe is above its 50-day average.
  const regime = marketRegime({
    niftyClose: nifty.close,
    niftySma50: nifty.sma50,
    niftySma200: nifty.sma200,
    aboveSma50: sets.live.filter((f) => f.close > f.sma50).length,
    counted: sets.live.filter((f) => Number.isFinite(f.sma50)).length,
  });
  // Sector strength: each sector's rank (0 weakest – 1 strongest) by its sector index's 1-month
  // return (end of day), or the median 1-month return of its stocks when the hub has no index for it.
  // Each sector index's place on the Relative Rotation Graph against NIFTY 500, with its weekly trail (end of day).
  const indexStats = new Map<string, SectorIndexStat>();
  const rrgBench = input.rrgBenchmark;
  for (const [industry, source] of sources) {
    const bars = stored(source.symbol);
    if (bars.length) indexStats.set(industry, { ...sectorIndexStat(source, bars, input.benchmark), rrg: rrgBench.length ? sectorRrg(bars, rrgBench) : null });
  }
  for (const sector of market.sectors) {
    const stat = indexStats.get(sector.sector);
    if (stat) sector.index = stat;
  }
  const sectorPct = strengthRanks(new Map(market.sectors.map((sector) => [sector.sector, sector.index && Number.isFinite(sector.index.ret21) ? sector.index.ret21 : sector.ret21])));
  const banned = new Set(ban.symbols);
  for (const rows of Object.values(byScreen)) {
    for (const row of rows) {
      const fact = oi?.bySymbol.get(row.symbol);
      if (fact) row.oi = fact;
      const option = input.options?.bySymbol.get(row.symbol);
      if (option) row.options = option;
      if (row.facts) {
        row.facts.sectorPct = sectorPct.get(row.industry || "Other") ?? null;
        row.facts.inBan = banned.has(row.symbol);
      }
      if (banned.has(row.symbol) && !row.tags.includes("F&O ban")) row.tags = ["F&O ban", ...row.tags];
    }
  }
  return { results: byScreen, market, regime, sets };
}

/** How long a Time Machine screener run waits for the day's option facts the first time (then they are cached). */
const OPTION_FACTS_WAIT_MS = 2_000;
/** Option facts older than this aren't shown live (a week of holidays at most), like the OI tag. */
const MAX_OPTION_AGE_MS = 7 * DAY_MS;

/** Today's option facts from the hub's newest option day (never waits: the next run has them). */
function liveOptionFacts(): OptionFacts | null {
  const today = istParts().day;
  const facts = optionFactsNow(isoDay(today), false);
  return facts && today - facts.day <= MAX_OPTION_AGE_MS ? facts : null;
}

// Replaying every screen over ~160 sessions is the expensive part, and it only
// changes when a new EOD session lands — so cache per universe + last session.
const globalForTrack = globalThis as unknown as { trackCache?: Map<string, Promise<TrackResult>> };
const trackCache = (globalForTrack.trackCache ??= new Map());

/** Past days' track records (Time Machine), most recent last. */
const MAX_PAST_TRACKS = 12;
const pastTracks = new Map<string, Promise<TrackResult>>();

/**
 * Every screen's replayed record over the ~160 sessions before today, or (the
 * Time Machine) before a past day: only signals whose whole holding period
 * ended by that day's close count, on bars up to it.
 */
export async function trackRecord(universeId: UniverseId, past: PastDay | null = null): Promise<TrackResult> {
  if (past) {
    const key = `${universeId}:${past.day}:${TRACK_VERSION}`;
    let pending = pastTracks.get(key);
    if (!pending) {
      pending = pastUniverse(universeId, past).then(async (found): Promise<TrackResult> => {
        if (found.status !== "ready") return { status: "error", error: found.status === "error" ? found.error : "The daily bars for that day are still being read." };
        const covered = found.symbols.filter((symbol) => found.barsOf(symbol).length > 0);
        const replay = await runTrackRecord(covered, (symbol) => (symbol === BENCHMARK ? found.benchmark : found.barsOf(symbol)), BENCHMARK);
        return { status: "ready", universe: universeId, ...replay };
      });
      pastTracks.set(key, pending);
      // A failure or "still reading" isn't kept: the next ask tries again.
      void pending.then((result) => result.status === "error" && pastTracks.delete(key)).catch(() => pastTracks.delete(key));
      while (pastTracks.size > MAX_PAST_TRACKS) pastTracks.delete(pastTracks.keys().next().value!);
    }
    return pending;
  }
  const symbols = orElse((await asOf()).universe(universeId), []).map((member) => member.symbol);
  await screenerStore.hasData([...symbols, BENCHMARK]);
  const covered = symbols.filter((symbol) => screenerStore.getBars(symbol).length > 0);
  if (!covered.length) return { status: "error", error: "No history cached for this universe yet." };

  const lastSession = Math.max(...covered.map((symbol) => screenerStore.getBars(symbol).at(-1)?.t ?? 0));
  const key = `${universeId}:${lastSession}:${covered.length}:${TRACK_VERSION}`;
  let pending = trackCache.get(key);
  if (!pending) {
    // Concurrent requests share one replay.
    const started = Date.now();
    pending = runTrackRecord(covered, (symbol) => screenerStore.getBars(symbol), BENCHMARK).then((replay): TrackResult => {
      log.info("Track record", { universe: universeId, stocks: covered.length, sessions: replay.sessions, ms: Date.now() - started });
      return { status: "ready", universe: universeId, ...replay };
    });
    for (const stale of [...trackCache.keys()].filter((entry) => entry.startsWith(`${universeId}:`))) trackCache.delete(stale);
    trackCache.set(key, pending);
    pending.catch(() => trackCache.delete(key));
  }
  return pending;
}
