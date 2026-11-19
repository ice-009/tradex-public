import "server-only";

import type { ScreenerResponse, TrackResult } from "@/contracts/api";
import { computeFeatures } from "@/core/screener/features";
import { runTrackRecord } from "@/core/screener/backtest";
import { buildFeatureSets, marketOverview, runScreens } from "@/core/screener/run";
import { emptyFresh, freshKey, updateFresh, type FreshState } from "@/core/screener/fresh";
import { marketRegime } from "@/core/screener/regime";
import { sectorIndexStat, sectorSources, strengthRanks, type SectorIndexStat } from "@/core/screener/sectorIndex";
import { latestOiFacts } from "@/server/providers/foData";
import { DEEP_HISTORY_DAYS } from "@/server/providers/dailyBars";
import { getFnoBan, getIndexCatalog } from "@/server/providers/reference";
import { updateBtstRecord } from "@/server/services/btstRecord";
import type { ScreenerRow } from "@/core/screener/screens";
import { DAY_MS, SESSION_CLOSE_MIN, SESSION_OPEN_MIN, istParts } from "@/core/market/session";
import type { DailyBar } from "@/core/types";
import { screenerStore } from "@/server/providers/dailyStore";
import { UNIVERSES, getUniverse, isUniverseId, type UniverseId } from "@/server/providers/universe";
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

export async function runScreener(universeId: UniverseId, useLive: boolean): Promise<ScreenerResponse> {
  const members = await getUniverse(universeId);
  const symbols = members.map((member) => member.symbol);
  const catalog = await getIndexCatalog();
  const needFrom = istParts().day - (DEEP_HISTORY_DAYS - SECTOR_HISTORY_SLACK_DAYS) * DAY_MS;
  const sources = sectorSources(catalog, members.map((member) => member.industry || "Other"), needFrom);
  const sectorSymbols = [...new Set([...sources.values()].map((source) => source.symbol))];
  screenerStore.ensureFresh([...symbols, BENCHMARK, ...sectorSymbols]);
  await screenerStore.hasData([...symbols, BENCHMARK, ...sectorSymbols]);

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
  const stored = (symbol: string) => screenerStore.getBars(symbol);
  const sets = buildFeatureSets(covered, stored, live);
  const benchToday = live.get(BENCHMARK);
  // No NIFTY bars (a hub in end-of-day mode has no index history yet): relative strength and the regime go without it.
  const benchBars = benchToday ? [...stored(BENCHMARK), benchToday] : stored(BENCHMARK);
  const nifty = benchBars.length ? computeFeatures(BENCHMARK, benchBars, Boolean(benchToday)) : { ret126: NaN, close: NaN, sma50: NaN, sma200: NaN };
  const memberBySymbol = new Map(members.map((member) => [member.symbol, member]));

  const results = runScreens(sets, { niftyRet126: nifty.ret126 }, memberBySymbol);
  stampFirstSeen(universeId, results);
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
  const indexStats = new Map<string, SectorIndexStat>();
  for (const [industry, source] of sources) {
    const bars = stored(source.symbol);
    if (bars.length) indexStats.set(industry, sectorIndexStat(source, bars, stored(BENCHMARK)));
  }
  for (const sector of market.sectors) {
    const stat = indexStats.get(sector.sector);
    if (stat) sector.index = stat;
  }
  const sectorPct = strengthRanks(new Map(market.sectors.map((sector) => [sector.sector, sector.index && Number.isFinite(sector.index.ret21) ? sector.index.ret21 : sector.ret21])));
  const ban = await getFnoBan();
  const banned = new Set(ban.available ? ban.symbols : []);
  // Futures OI from the hub's newest F&O bhavcopy day (GET /v1/fo/oi/day, cached; never waits).
  // Shown next to the setup, never scored: OI buildup showed no edge on its own in testing.
  const oi = latestOiFacts();
  for (const rows of Object.values(results)) {
    for (const row of rows) {
      const fact = oi?.bySymbol.get(row.symbol);
      if (fact) row.oi = fact;
      if (row.facts) {
        row.facts.sectorPct = sectorPct.get(row.industry || "Other") ?? null;
        row.facts.inBan = banned.has(row.symbol);
      }
      if (banned.has(row.symbol) && !row.tags.includes("F&O ban")) row.tags = ["F&O ban", ...row.tags];
    }
  }
  const now = Date.now();
  // BTST live record: matches seen 3:10–3:25 PM, settled at the next open (no extra API calls).
  if (useLive) updateBtstRecord({ results, live, banned, now });
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
    ban: { available: ban.available, tradeDate: ban.tradeDate, symbols: ban.symbols },
  };
}

// Replaying every screen over ~160 sessions is the expensive part, and it only
// changes when a new EOD session lands — so cache per universe + last session.
const globalForTrack = globalThis as unknown as { trackCache?: Map<string, Promise<TrackResult>> };
const trackCache = (globalForTrack.trackCache ??= new Map());

export async function trackRecord(universeId: UniverseId): Promise<TrackResult> {
  const symbols = (await getUniverse(universeId)).map((member) => member.symbol);
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
