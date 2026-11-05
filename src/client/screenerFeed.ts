import { useEffect, useSyncExternalStore } from "react";
import {
  SCREENS,
  SCREEN_GROUPS,
  SCREEN_MAP,
  type ScreenDef,
  type ScreenGroup,
  type ScreenerRow,
} from "@/core/screener/screens";
import type { ResultsEvent, ScreenerResponse, TrackResult as TrackResponse } from "@/contracts/api";
import { api } from "@/client/api";
import { HOLD_BARS } from "@/core/screener/backtest";
import { scoreSetup, type SetupScore, type StockFacts } from "@/core/screener/score";
import type { TradePlan } from "@/core/screener/screens";
import { DAY_MS, isMarketOpen, istParts } from "@/core/market/session";

export { isMarketOpen };

// One shared screener feed for the whole terminal. The screener panel, the
// watchlist badges, the setup card and the chart's plan overlay all read the
// same response, so a stock's setups are visible wherever that stock appears.

const LIVE_REFRESH_MS = 60_000;
const SYNC_POLL_MS = 2_000;
/** After an error (e.g. Fyers not connected yet), try again instead of giving up. */
const ERROR_RETRY_MS = 30_000;

/** One screen a stock matched, with that screen's trade plan. */
export interface SetupHit {
  screen: ScreenDef;
  row: ScreenerRow;
  rr: number | null;
}

/** Every screen one stock matched, merged into a single trade idea. */
export interface TradeIdea {
  symbol: string;
  name: string;
  industry: string;
  close: number;
  changePct: number;
  live: boolean;
  rsi14: number;
  rsRank: number;
  volRatio: number;
  deliveryPct: number | null;
  hits: SetupHit[];
  /** The hit used by default: highest R:R among the highest-scoring horizon. */
  best: SetupHit;
  groups: ScreenGroup[];
}

export function riskReward(row: ScreenerRow) {
  const risk = row.plan.entry - row.plan.stop;
  return row.plan.target !== null && risk > 0 ? (row.plan.target - row.plan.entry) / risk : null;
}

const GROUP_ORDER: Record<ScreenGroup, number> = { results: 0, btst: 1, swing: 2, positional: 3 };

function buildIdeas(data: ScreenerResponse | null): Map<string, TradeIdea> {
  const ideas = new Map<string, TradeIdea>();
  if (!data?.results) return ideas;
  for (const screen of SCREENS) {
    for (const row of data.results[screen.id] ?? []) {
      const hit: SetupHit = { screen, row, rr: riskReward(row) };
      const existing = ideas.get(row.symbol);
      if (existing) {
        existing.hits.push(hit);
        continue;
      }
      ideas.set(row.symbol, {
        symbol: row.symbol,
        name: row.name,
        industry: row.industry,
        close: row.close,
        changePct: row.changePct,
        live: row.live,
        rsi14: row.rsi14,
        rsRank: row.rsRank,
        volRatio: row.volRatio,
        deliveryPct: row.deliveryPct,
        hits: [hit],
        best: hit,
        groups: [],
      });
    }
  }
  for (const idea of ideas.values()) {
    idea.hits.sort((a, b) => (b.rr ?? 0) - (a.rr ?? 0) || b.row.score - a.row.score);
    idea.best = idea.hits[0];
    idea.groups = [...new Set(idea.hits.map((hit) => hit.screen.group))].sort((a, b) => GROUP_ORDER[a] - GROUP_ORDER[b]);
    // A live row carries today's price; prefer it over an EOD-only screen's close.
    const liveHit = idea.hits.find((hit) => hit.row.live);
    if (liveHit) {
      idea.close = liveHit.row.close;
      idea.changePct = liveHit.row.changePct;
      idea.live = true;
    }
  }
  return ideas;
}

// ------------------------------------------------------------------ store

export interface ScreenerFeed {
  universe: string;
  data: ScreenerResponse | null;
  loading: boolean;
  ideas: Map<string, TradeIdea>;
  /** Symbols in the order the screener panel currently shows them (for next/prev idea). */
  order: string[];
  /** Per symbol, the screen whose plan the user picked to see (else the idea's best). */
  focus: Record<string, string>;
  /** Historical replay of every screen (null until loaded). */
  track: TrackResponse | null;
  /** NSE results calendar (best-effort; `available` false when NSE couldn't be reached). */
  results: ResultsFeed | null;
}

export type { ResultsEvent };

export interface ResultsFeed {
  available: boolean;
  events: ResultsEvent[];
  /** Nearest results date per symbol (upcoming first, else the most recent). */
  bySymbol: Map<string, ResultsEvent>;
}

let feed: ScreenerFeed = { universe: "", data: null, loading: false, ideas: new Map(), order: [], focus: {}, track: null, results: null };

const RESULTS_REFRESH_MS = 60 * 60 * 1000;
let resultsLoadedAt = 0;

/** Fetch the results calendar (at most hourly; the server caches NSE for 6 h). */
export async function loadResultsCalendar(force = false) {
  if (!force && Date.now() - resultsLoadedAt < RESULTS_REFRESH_MS) return;
  resultsLoadedAt = Date.now();
  try {
    const json = await api.results();
    const today = istParts().day;
    const bySymbol = new Map<string, ResultsEvent>();
    for (const event of json.events ?? []) {
      const current = bySymbol.get(event.symbol);
      // Prefer the next upcoming date; fall back to the latest past one.
      const better = !current || (event.date >= today ? current.date < today || event.date < current.date : current.date < today && event.date > current.date);
      if (better) bySymbol.set(event.symbol, event);
    }
    setFeed({ results: { available: Boolean(json.available), events: json.events ?? [], bySymbol } });
  } catch {
    setFeed({ results: { available: false, events: [], bySymbol: new Map() } });
  }
}

/** "Results today", "Results in 3 days", "Results 2 days ago" — null when there's nothing close. */
export function resultsNote(event: ResultsEvent | undefined, withinDays = 10): { text: string; soon: boolean } | null {
  if (!event) return null;
  const today = istParts().day;
  const days = Math.round((event.date - today) / DAY_MS);
  if (Math.abs(days) > withinDays) return null;
  const when = new Date(event.date).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  if (days === 0) return { text: `Results today (${when})`, soon: true };
  if (days > 0) return { text: `Results in ${days} day${days === 1 ? "" : "s"} (${when})`, soon: days <= 3 };
  return { text: `Results ${-days} day${days === -1 ? "" : "s"} ago (${when})`, soon: false };
}
const listeners = new Set<() => void>();

function setFeed(patch: Partial<ScreenerFeed>) {
  feed = { ...feed, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getFeed() {
  return feed;
}

/** Select a slice of the feed. Selectors must return existing references. */
export function useScreenerFeed<T>(selector: (current: ScreenerFeed) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(feed),
    () => selector(feed),
  );
}

export function useIdea(symbol: string): TradeIdea | undefined {
  return useScreenerFeed((current) => current.ideas.get(symbol));
}

/** The setup whose plan should be shown for an idea: the one the user focused, else the best. */
export function focusedHit(idea: TradeIdea, focus: Record<string, string>): SetupHit {
  const id = focus[idea.symbol];
  return (id && idea.hits.find((hit) => hit.screen.id === id)) || idea.best;
}

export function focusSetup(symbol: string, screenId: string) {
  if (feed.focus[symbol] === screenId) return;
  setFeed({ focus: { ...feed.focus, [symbol]: screenId } });
}

export function setIdeaOrder(order: string[]) {
  if (order.length === feed.order.length && order.every((symbol, i) => symbol === feed.order[i])) return;
  setFeed({ order });
}

// ------------------------------------------------------------------ polling

let refreshKey = 0;
const refreshListeners = new Set<() => void>();

export function refreshScreener() {
  refreshKey += 1;
  for (const listener of refreshListeners) listener();
}

/**
 * Mount once (in the workspace). Fetches the chosen universe, then keeps
 * polling: fast while history syncs, once a minute during market hours.
 */
export function useScreenerPolling(universe: string) {
  const key = useSyncExternalStore(
    (listener) => {
      refreshListeners.add(listener);
      return () => {
        refreshListeners.delete(listener);
      };
    },
    () => refreshKey,
    () => 0,
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (feed.universe !== universe) setFeed({ universe, data: null, ideas: new Map(), order: [], track: null });
    let trackFor = "";

    // The replay only changes with a new EOD session; fetch it once per universe + session.
    const loadTrack = async (eodDate: number) => {
      const key = `${universe}:${eodDate}`;
      if (trackFor === key) return;
      trackFor = key;
      try {
        const json = await api.track(universe);
        if (!cancelled) setFeed({ track: json });
      } catch {
        if (!cancelled) setFeed({ track: { status: "error", error: "Couldn't load the track record." } });
      }
    };

    void loadResultsCalendar();
    const run = async () => {
      setFeed({ loading: true });
      try {
        const json = await api.screener(universe);
        if (cancelled) return;
        // Keep the last good results on screen while a refresh reports "syncing".
        const keep = json.status === "syncing" && feed.data?.status === "ready";
        setFeed(keep ? { data: { ...feed.data!, syncing: true, progress: json.progress } } : { data: json, ideas: buildIdeas(json) });
        if (json.status === "ready" && json.asOf && !json.syncing) void loadTrack(json.asOf.eodDate);
        const next =
          json.status === "syncing" || json.syncing
            ? SYNC_POLL_MS
            : json.status === "error"
              ? ERROR_RETRY_MS
              : isMarketOpen()
                ? LIVE_REFRESH_MS
                : null;
        if (next) timer = setTimeout(run, next);
      } catch {
        if (!cancelled) {
          setFeed({ data: { status: "error", error: "Couldn't reach the screener." }, ideas: new Map() });
          timer = setTimeout(run, ERROR_RETRY_MS);
        }
      } finally {
        if (!cancelled) setFeed({ loading: false });
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [universe, key]);
}

// ------------------------------------------------------------------ display helpers

export const GROUP_LABEL: Record<ScreenGroup, string> = Object.fromEntries(
  SCREEN_GROUPS.map((group) => [group.id, group.label]),
) as Record<ScreenGroup, string>;

export function screenById(id: string): ScreenDef | undefined {
  return SCREEN_MAP[id];
}

// ------------------------------------------------------------------ scoring

/** Days from today to a symbol's nearest results date (negative = already out), null when unknown. */
export function resultsInDays(symbol: string, results: ResultsFeed | null): number | null {
  const event = results?.bySymbol.get(symbol);
  if (!event) return null;
  const today = istParts().day;
  return Math.round((event.date - today) / DAY_MS);
}

/** Score a plan for a stock: facts from the server, replay record of its setup, results date. */
export function scorePlan(
  symbol: string,
  facts: StockFacts,
  plan: TradePlan,
  options: { screenId?: string; group?: ScreenGroup; warnings?: string[]; track: TrackResponse | null; results: ResultsFeed | null },
): SetupScore {
  const record = options.screenId ? options.track?.screens?.[options.screenId] : undefined;
  return scoreSetup(facts, plan, {
    track: record ? { avgR: record.avgR, signals: record.signals } : null,
    resultsInDays: resultsInDays(symbol, options.results),
    holdDays: options.group ? HOLD_BARS[options.group] : 15,
    warnings: options.warnings,
    buysWeakness: options.screenId ? SCREEN_MAP[options.screenId]?.buysWeakness : false,
  });
}

/** Score of one screener hit (null when the row has no facts, e.g. an older server). */
export function scoreHit(hit: SetupHit, track: TrackResponse | null, results: ResultsFeed | null): SetupScore | null {
  if (!hit.row.facts) return null;
  return scorePlan(hit.row.symbol, hit.row.facts, hit.row.plan, {
    screenId: hit.screen.id,
    group: hit.screen.group,
    warnings: hit.row.warnings,
    track,
    results,
  });
}
