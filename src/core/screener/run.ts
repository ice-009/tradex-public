// Pure screener pipeline: features → screen matches, market overview and RS
// percentiles. No I/O — the backend service (src/server/services/screener.ts)
// loads the bars and calls these.

import type { DailyBar } from "@/core/types";
import { computeFeatures, rankRelativeStrength, volAdjustedMomentum, type Features } from "./features";
import { factsFrom } from "./score";
import { SCREENS, type MarketOverview, type MarketRow, type ScreenContext, type ScreenerRow, type SectorStat } from "./screens";
import { warningsFor } from "./warnings";

export interface MemberInfo {
  name: string;
  industry: string;
}

/** Rows per mover list in the market overview. */
export const MOVERS = 15;
/** Minimum 20-day average turnover (₹ cr) to appear in the market overview. */
export const MIN_TURNOVER_CR = 5;

const finite = (value: number) => (Number.isFinite(value) ? value : null);

const median = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export interface FeatureSets {
  /** Features including today's live bar where there is one (RS ranked). */
  live: Features[];
  /** Features on stored end-of-day bars only (RS ranked); same objects as `live` when there are no live bars. */
  eod: Features[];
}

/**
 * Features for every symbol with enough history, in two flavours: with today's live bar
 * (intraday screens) and end-of-day only (screens that read a closed session).
 */
export function buildFeatureSets(symbols: string[], storedBars: (symbol: string) => DailyBar[], liveBars: Map<string, DailyBar>): FeatureSets {
  const live: Features[] = [];
  const eod: Features[] = [];
  for (const symbol of symbols) {
    const stored = storedBars(symbol);
    if (stored.length < 30) continue;
    const today = liveBars.get(symbol);
    const latest = computeFeatures(symbol, today ? [...stored, today] : stored, Boolean(today));
    live.push(latest);
    eod.push(liveBars.size > 0 ? computeFeatures(symbol, stored, false) : latest);
  }
  rankRelativeStrength(live);
  if (liveBars.size > 0) rankRelativeStrength(eod);
  return { live, eod };
}

/** Every screen over the universe: screen id → matching rows, best score first. */
export function runScreens(sets: FeatureSets, ctx: ScreenContext, members: Map<string, MemberInfo>): Record<string, ScreenerRow[]> {
  const results: Record<string, ScreenerRow[]> = {};
  for (const screen of SCREENS) {
    const pool = screen.basis === "eod" ? sets.eod : sets.live;
    results[screen.id] = pool
      .filter((f) => screen.rules.every((rule) => rule.test(f, ctx)))
      .map((f) => ({
        symbol: f.symbol,
        name: members.get(f.symbol)?.name ?? f.symbol,
        industry: members.get(f.symbol)?.industry ?? "",
        date: f.date,
        live: f.live,
        close: f.close,
        changePct: f.changePct,
        volRatio: screen.id === "pos-base-breakout" ? f.volRatio50 : f.volRatio20,
        deliveryPct: finite(f.deliveryPct),
        rsi14: f.rsi14,
        rsRank: f.rsRank,
        score: screen.score(f),
        tags: screen.tags?.(f) ?? [],
        plan: screen.plan(f),
        warnings: warningsFor(f),
        facts: factsFrom(f),
      }))
      .sort((a, b) => b.score - a.score);
  }
  return results;
}

/** Top movers and sector stats for the whole universe (every stock, not only screen matches). */
export function marketOverview(features: Features[], members: Map<string, MemberInfo>): MarketOverview {
  const rows: MarketRow[] = features
    .filter((f) => Number.isFinite(f.changePct) && f.turnoverCr20 >= MIN_TURNOVER_CR)
    .map((f) => ({
      symbol: f.symbol,
      name: members.get(f.symbol)?.name ?? f.symbol,
      industry: members.get(f.symbol)?.industry || "Other",
      close: f.close,
      changePct: f.changePct,
      volRatio: f.volRatio20,
      ret5: f.ret5,
      ret21: f.ret21,
      ofHigh52: (f.close / f.high52) * 100,
    }));
  const by = (key: (row: MarketRow) => number, dir: 1 | -1) =>
    rows
      .filter((row) => Number.isFinite(key(row)))
      .sort((a, b) => (key(a) - key(b)) * dir)
      .slice(0, MOVERS);

  const groups = new Map<string, MarketRow[]>();
  for (const row of rows) groups.set(row.industry, [...(groups.get(row.industry) ?? []), row]);
  const sectors: SectorStat[] = [...groups.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([sector, list]) => ({
      sector,
      count: list.length,
      change: median(list.map((row) => row.changePct)),
      ret5: median(list.map((row) => row.ret5)),
      ret21: median(list.map((row) => row.ret21)),
      breadth: list.filter((row) => row.changePct > 0).length / list.length,
      symbols: list.sort((a, b) => b.changePct - a.changePct).map((row) => row.symbol),
    }))
    .sort((a, b) => b.change - a.change);

  return {
    gainers: by((row) => row.changePct, -1),
    losers: by((row) => row.changePct, 1),
    active: by((row) => row.volRatio, -1),
    highs: rows.filter((row) => row.ofHigh52 >= 98).sort((a, b) => b.ret21 - a.ret21).slice(0, MOVERS),
    sectors,
  };
}

/** Relative-strength score from daily bars: the same volatility-adjusted momentum computeFeatures ranks on. NaN under ~6 months. */
export function rsScore(bars: DailyBar[]) {
  return volAdjustedMomentum(bars.map((bar) => bar.c));
}

/** 1–99 percentile of `score` within ascending-sorted `peers` (50 when it can't be ranked). */
export function rsPercentile(score: number, sortedPeers: number[]) {
  if (sortedPeers.length < 2 || !Number.isFinite(score)) return 50;
  const below = sortedPeers.filter((value) => value < score).length;
  return Math.min(99, Math.round(1 + (98 * below) / (sortedPeers.length - 1)));
}
