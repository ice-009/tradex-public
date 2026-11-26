import type { DailyBar } from "@/core/types";

// Relative Rotation Graph (RRG) style sector rotation, from daily closes. Pure.
//
// The original RRG (Julius de Kempenaer, RRG Research) is proprietary: its
// JdK RS-Ratio and JdK RS-Momentum formulas aren't published. This is a
// transparent, documented APPROXIMATION in the same spirit — both axes are
// normalised so they centre on 100 and measure in standard deviations — not
// the original, and its readings won't match RRG Research's charts.
//
// THE FORMULAS. For a sector series S and a benchmark B (NIFTY 500 here), on
// the sessions both have, with parameters smooth (s), window (w) and lag (k):
//
//   RS_t          = 100 · S_t / B_t                      relative strength
//   X_t           = EMA_s(RS)_t                          smoothed RS (α = 2 / (s + 1), seeded with RS_0)
//   RS-Ratio_t    = 100 + (X_t − mean_w(X)_t) / sd_w(X)_t
//                   — where RS stands against its own last w sessions: above 100
//                     the sector is outperforming the benchmark by more than usual
//   D_t           = RS-Ratio_t − RS-Ratio_{t−k}          the trend of RS-Ratio
//   RS-Momentum_t = 100 + (D_t − mean_w(D)_t) / sd_w(D)_t
//                   — above 100 RS-Ratio is rising faster than usual
//
// mean_w / sd_w are the mean and (sample) standard deviation of the last w
// values, the current one included: nothing from after t is used. Defaults
// s = 10, w = 63 (a quarter), k = 10 sessions: RRG's weekly charts' scale on
// daily bars. The first RS-Momentum comes on session s + 2w + k − 2 (the
// 147th with the defaults; `rrgWarmup`).
//
// QUADRANTS (x = RS-Ratio, y = RS-Momentum, split at 100):
//   Leading    ratio ≥ 100, momentum ≥ 100   outperforming and gaining
//   Weakening  ratio ≥ 100, momentum < 100   outperforming, losing pace
//   Lagging    ratio < 100, momentum < 100   underperforming and losing
//   Improving  ratio < 100, momentum ≥ 100   underperforming, gaining
// A sector whose relative strength cycles moves clockwise through them:
// Improving → Leading → Weakening → Lagging → Improving.

export type Quadrant = "leading" | "weakening" | "lagging" | "improving";

export const QUADRANTS: readonly Quadrant[] = ["leading", "weakening", "lagging", "improving"];

export const QUADRANT_LABEL: Record<Quadrant, string> = { leading: "Leading", weakening: "Weakening", lagging: "Lagging", improving: "Improving" };

export interface RrgParams {
  /** EMA span smoothing RS (sessions). */
  smooth: number;
  /** Normalisation window for both axes (sessions). */
  window: number;
  /** Sessions over which RS-Ratio's change is taken (momentum). */
  lag: number;
}

export const RRG_DEFAULTS: RrgParams = { smooth: 10, window: 63, lag: 10 };

/** Index (0-based session) of the first RS-Momentum value: s + 2w + k − 3. */
export const rrgWarmup = ({ smooth, window, lag }: RrgParams = RRG_DEFAULTS) => smooth + 2 * window + lag - 3;

export interface RrgPoint {
  /** Day key of the session. */
  t: number;
  ratio: number;
  momentum: number;
  quadrant: Quadrant;
}

export function quadrantOf(ratio: number, momentum: number): Quadrant {
  if (ratio >= 100) return momentum >= 100 ? "leading" : "weakening";
  return momentum >= 100 ? "improving" : "lagging";
}

/** 100 × sector / benchmark on the sessions both have (by day key), oldest first. */
export function relativeStrength(sector: readonly DailyBar[], benchmark: readonly DailyBar[]): { t: number[]; rs: number[] } {
  const bench = new Map<number, number>();
  for (const bar of benchmark) if (bar.c > 0) bench.set(bar.t, bar.c);
  const t: number[] = [];
  const rs: number[] = [];
  for (const bar of sector) {
    const b = bench.get(bar.t);
    if (!b || !(bar.c > 0)) continue;
    t.push(bar.t);
    rs.push((100 * bar.c) / b);
  }
  return { t, rs };
}

/** Exponential moving average seeded with the first value. */
export function ema(values: readonly number[], span: number): Float64Array {
  const out = new Float64Array(values.length);
  const alpha = 2 / (span + 1);
  for (let i = 0; i < values.length; i += 1) out[i] = i === 0 ? values[0] : alpha * values[i] + (1 - alpha) * out[i - 1];
  return out;
}

/**
 * 100 + the z-score of each value against the last `window` values (itself
 * included); NaN where the window holds a NaN or doesn't vary.
 */
export function rollingScore(values: ArrayLike<number>, window: number): Float64Array {
  const out = new Float64Array(values.length).fill(Number.NaN);
  for (let i = window - 1; i < values.length; i += 1) {
    let sum = 0;
    let ok = true;
    for (let j = i - window + 1; j <= i; j += 1) {
      if (!Number.isFinite(values[j])) {
        ok = false;
        break;
      }
      sum += values[j];
    }
    if (!ok) continue;
    const mean = sum / window;
    let sq = 0;
    for (let j = i - window + 1; j <= i; j += 1) sq += (values[j] - mean) ** 2;
    const sd = Math.sqrt(sq / (window - 1));
    if (sd > 1e-12 * Math.max(1, Math.abs(mean))) out[i] = 100 + (values[i] - mean) / sd;
  }
  return out;
}

/** RS-Ratio and RS-Momentum for every session of an RS series (NaN during the warm-up). */
export function rrgSeries(rs: readonly number[], params: RrgParams = RRG_DEFAULTS): { ratio: Float64Array; momentum: Float64Array } {
  const { smooth, window, lag } = params;
  const smoothed = ema(rs, smooth);
  // The EMA leans on its seed for its first `smooth` sessions: leave them out.
  smoothed.fill(Number.NaN, 0, Math.min(rs.length, smooth - 1));
  const ratio = rollingScore(smoothed, window);
  const change = new Float64Array(rs.length).fill(Number.NaN);
  for (let i = lag; i < rs.length; i += 1) change[i] = ratio[i] - ratio[i - lag];
  const momentum = rollingScore(change, window);
  return { ratio, momentum };
}

/** Every session's RRG point for a sector against the benchmark (sessions in the warm-up left out). */
export function rrgPoints(sector: readonly DailyBar[], benchmark: readonly DailyBar[], params: RrgParams = RRG_DEFAULTS): RrgPoint[] {
  const { t, rs } = relativeStrength(sector, benchmark);
  const { ratio, momentum } = rrgSeries(rs, params);
  const out: RrgPoint[] = [];
  for (let i = 0; i < t.length; i += 1) {
    if (Number.isFinite(ratio[i]) && Number.isFinite(momentum[i])) out.push({ t: t[i], ratio: ratio[i], momentum: momentum[i], quadrant: quadrantOf(ratio[i], momentum[i]) });
  }
  return out;
}

/**
 * The sector's trail: the newest point and one every `every` sessions before
 * it, `count` points in all, oldest first (RRG's tail; with every = 5 a
 * weekly timeline).
 */
export function rrgTrail(points: readonly RrgPoint[], count: number, every = 5): RrgPoint[] {
  const out: RrgPoint[] = [];
  for (let i = points.length - 1; i >= 0 && out.length < count; i -= every) out.push(points[i]);
  return out.reverse();
}

/** Clockwise order of the quadrants: how far (in quarter turns, 0–3) `to` is from `from`. */
export function rotationSteps(from: Quadrant, to: Quadrant): number {
  const order: Quadrant[] = ["improving", "leading", "weakening", "lagging"];
  return (order.indexOf(to) - order.indexOf(from) + 4) % 4;
}

/** A sector's place on the RRG now, with its weekly trail (the panel's quadrant chart and rotation timeline). */
export interface SectorRrg {
  ratio: number;
  momentum: number;
  quadrant: Quadrant;
  /** Day key of the newest point. */
  asOf: number;
  /** One point every 5 sessions, oldest first, the newest last. */
  trail: RrgPoint[];
}

/** The sector's newest RRG point and its last `weeks` weekly points; null with too little history. */
export function sectorRrg(sector: readonly DailyBar[], benchmark: readonly DailyBar[], weeks = 26, params: RrgParams = RRG_DEFAULTS): SectorRrg | null {
  const points = rrgPoints(sector, benchmark, params);
  const last = points.at(-1);
  if (!last) return null;
  const round = (point: RrgPoint): RrgPoint => ({ ...point, ratio: Math.round(point.ratio * 1000) / 1000, momentum: Math.round(point.momentum * 1000) / 1000 });
  return { ratio: round(last).ratio, momentum: round(last).momentum, quadrant: last.quadrant, asOf: last.t, trail: rrgTrail(points, weeks, 5).map(round) };
}
