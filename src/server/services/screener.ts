import "server-only";

import type { ScreenerResponse, TrackResult } from "@/contracts/api";
import { computeFeatures } from "@/core/screener/features";
import { runTrackRecord } from "@/core/screener/backtest";
import { buildFeatureSets, marketOverview, runScreens } from "@/core/screener/run";
import type { DailyBar } from "@/core/types";
import { screenerStore } from "@/server/providers/dailyStore";
import { UNIVERSES, getUniverse, isUniverseId, type UniverseId } from "@/server/providers/universe";

// Screener and track-record orchestration: load bars (dailyStore), hand them
// to the engine (src/core/screener), shape the API response.

export const BENCHMARK = "NIFTY";
/** Below this share of the universe with history, keep showing the sync progress instead of results. */
const MIN_COVERAGE = 0.95;
/** Bump when the replay rules change so a running server drops cached results. */
const TRACK_VERSION = 5;

export function parseUniverse(value: string | null): UniverseId {
  return value && isUniverseId(value) ? value : "nifty200";
}

/** Runs every screen over the universe in one pass; the first call for a universe starts a background history sync. */
export async function runScreener(universeId: UniverseId, useLive: boolean): Promise<ScreenerResponse> {
  const members = await getUniverse(universeId);
  const symbols = members.map((member) => member.symbol);
  screenerStore.ensureFresh([...symbols, BENCHMARK]);
  await screenerStore.hasData([...symbols, BENCHMARK]);

  const covered = symbols.filter((symbol) => screenerStore.getBars(symbol).length > 0);
  const progress = screenerStore.progress;
  const universe = { id: universeId, label: UNIVERSES.find((u) => u.id === universeId)?.label, count: symbols.length, covered: covered.length };

  if (covered.length < symbols.length * MIN_COVERAGE) {
    if (screenerStore.isSyncing()) return { status: "syncing", progress, universe };
    return { status: "error", error: progress.message || "No screener data available yet.", progress, universe };
  }

  const live = useLive ? await screenerStore.getLiveBars([...covered, BENCHMARK]) : new Map<string, DailyBar>();
  const stored = (symbol: string) => screenerStore.getBars(symbol);
  const sets = buildFeatureSets(covered, stored, live);
  const benchToday = live.get(BENCHMARK);
  const nifty = computeFeatures(BENCHMARK, benchToday ? [...stored(BENCHMARK), benchToday] : stored(BENCHMARK), Boolean(benchToday));
  const memberBySymbol = new Map(members.map((member) => [member.symbol, member]));

  return {
    status: "ready",
    syncing: screenerStore.isSyncing(),
    progress,
    universe,
    asOf: { eodDate: Math.max(0, ...sets.eod.map((feature) => feature.date)), live: live.size > 0, computedAt: Date.now() },
    results: runScreens(sets, { niftyRet126: nifty.ret126 }, memberBySymbol),
    market: marketOverview(sets.live, memberBySymbol),
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
      console.info(`Track record for ${universeId}: ${covered.length} stocks × ${replay.sessions} sessions in ${Date.now() - started} ms`);
      return { status: "ready", universe: universeId, ...replay };
    });
    for (const stale of [...trackCache.keys()].filter((entry) => entry.startsWith(`${universeId}:`))) trackCache.delete(stale);
    trackCache.set(key, pending);
    pending.catch(() => trackCache.delete(key));
  }
  return pending;
}
