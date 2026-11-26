import type { DailyBar } from "@/core/types";
import type { SignalValues } from "./engine";
import { barsFactor, residualMomentum, type FactorReturn } from "./residual";
import type { LabSignal, ParamSpec, SignalContext } from "./signals";

// Momentum signals for issue #27, kept out of signals.ts (which imports this
// list) so other signal work doesn't collide with it. Pure.
//
//   score-rs           the setup score's relative-strength factor exactly as
//                      src/core/screener/score.ts awards it (15 points): the
//                      day's percentile rank 1–99 of the volatility-adjusted
//                      6/12-month momentum (features.ts volAdjustedMomentum) × 10/99
//                      plus 0–5 points for nearness to the 52-week high. The
//                      baseline the other two are compared with.
//   residual-momentum  Blitz, Huij & Martens (2011), ./residual.ts: the residual
//                      return of months t − 12 … t − 2 from a rolling 36-month
//                      regression on the market (NIFTY; the hub's equal-weight
//                      NIFTY 50 basket before 2012) — or on the market and the
//                      stock's sector — scaled by the residuals' volatility.
//
// The sector factor is the equal-weighted daily return of the stock's industry
// peers in the loaded universe (today's NSE industry classification, from the
// hub's index lists), leaving the stock itself out, on days with at least
// MIN_PEERS peers. Not NSE's sector indices: those start in 2012 (several in
// 2026), hold the stock itself (often at a large weight), and the hub's
// equal-weight sector baskets before 2012 are today's members (survivorship
// bias). A stock without a known industry, or with too few peers, gets the
// market-only regression.

/** Fewest industry peers (the stock itself left out) for a day's sector return. */
export const MIN_PEERS = 3;

/** Calendar days of history before the first formation day a residual regression of `window` sessions needs. */
export const residualWarmupDays = (window: number, lookback = 252) => Math.ceil((Math.max(window, lookback) + 10) * (365 / 245)) + 30;

const sessions = (key: string, label: string, value: number, min: number, max: number): ParamSpec => ({ key, label, default: value, min, max, integer: true });

/** A per-symbol series computed once over all its bars, read by day. */
function perSeries(ctx: SignalContext, compute: (bars: readonly DailyBar[], symbol: string) => Float64Array): (day: number, symbol: string) => number | null {
  const cache = new Map<string, { at: Map<number, number>; values: Float64Array } | null>();
  return (day, symbol) => {
    let entry = cache.get(symbol);
    if (entry === undefined) {
      const bars = ctx.bars.get(symbol);
      entry = bars?.length ? { at: new Map(bars.map((bar, i) => [bar.t, i])), values: compute(bars, symbol) } : null;
      cache.set(symbol, entry);
    }
    const i = entry?.at.get(day);
    if (!entry || i === undefined) return null;
    const value = entry.values[i];
    return Number.isFinite(value) ? value : null;
  };
}

/**
 * The sector factor: each day's equal-weighted return of a stock's industry
 * peers (itself left out), between consecutive sessions of the calendar. Null
 * on a day with fewer than `minPeers` peers, for a stock without an industry,
 * and for a pair of sessions that aren't consecutive in the calendar.
 */
export function peerFactor(ctx: Pick<SignalContext, "dates" | "symbols" | "bars">, industryOf: (symbol: string) => string | null, minPeers = MIN_PEERS, maxMove = 0.5): FactorReturn {
  const D = ctx.dates.length;
  const position = new Map(ctx.dates.map((day, d) => [day, d]));
  const sums = new Map<string, { sum: Float64Array; count: Int32Array }>();
  const own = new Map<string, Float64Array>();
  for (const symbol of ctx.symbols) {
    const industry = industryOf(symbol);
    const bars = ctx.bars.get(symbol);
    if (!industry || !bars?.length) continue;
    let group = sums.get(industry);
    if (!group) sums.set(industry, (group = { sum: new Float64Array(D), count: new Int32Array(D) }));
    const mine = new Float64Array(D).fill(Number.NaN);
    for (let j = 1; j < bars.length; j += 1) {
      const d = position.get(bars[j].t);
      if (d === undefined || d === 0 || ctx.dates[d - 1] !== bars[j - 1].t) continue;
      const a = bars[j - 1].c;
      const b = bars[j].c;
      if (!(a > 0 && b > 0)) continue;
      const r = b / a - 1;
      if (Math.abs(r) > maxMove) continue;
      mine[d] = r;
      group.sum[d] += r;
      group.count[d] += 1;
    }
    own.set(symbol, mine);
  }
  return (prev, day, symbol) => {
    const industry = industryOf(symbol);
    const group = industry ? sums.get(industry) : undefined;
    const d = position.get(day);
    if (!group || d === undefined || d === 0 || ctx.dates[d - 1] !== prev) return null;
    const mine = own.get(symbol)?.[d];
    const self = mine !== undefined && Number.isFinite(mine);
    const peers = group.count[d] - (self ? 1 : 0);
    if (peers < minPeers) return null;
    return (group.sum[d] - (self ? mine : 0)) / peers;
  };
}

/**
 * Volatility-adjusted momentum (features.ts `volAdjustedMomentum`, the score's
 * RS input) at every bar, from prefix sums: the mean of the 6- and 12-month
 * return ÷ annualised volatility over the same span (the 6-month one alone with
 * under a year of history). NaN where it isn't defined.
 */
export function volAdjustedMomentumSeries(bars: readonly DailyBar[]): Float64Array {
  const n = bars.length;
  const out = new Float64Array(n).fill(Number.NaN);
  const cnt = new Int32Array(n);
  const sum = new Float64Array(n);
  const sq = new Float64Array(n);
  for (let j = 1; j < n; j += 1) {
    cnt[j] = cnt[j - 1];
    sum[j] = sum[j - 1];
    sq[j] = sq[j - 1];
    const a = bars[j - 1].c;
    const b = bars[j].c;
    if (a > 0 && b > 0) {
      const r = Math.log(b / a);
      cnt[j] += 1;
      sum[j] += r;
      sq[j] += r * r;
    }
  }
  const ratio = (i: number, days: number) => {
    if (i < days) return Number.NaN;
    const ret = (bars[i].c / bars[i - days].c - 1) * 100;
    const m = cnt[i] - cnt[i - days];
    if (m < days * 0.8 || m < 2) return Number.NaN;
    const s = sum[i] - sum[i - days];
    const variance = Math.max(0, (sq[i] - sq[i - days] - (s * s) / m) / (m - 1));
    const vol = Math.sqrt(variance * 252) * 100;
    return Number.isFinite(ret) && vol > 0 ? ret / vol : Number.NaN;
  };
  for (let i = 0; i < n; i += 1) {
    const six = ratio(i, 126);
    if (!Number.isFinite(six)) continue;
    const twelve = ratio(i, 252);
    out[i] = Number.isFinite(twelve) ? (six + twelve) / 2 : six;
  }
  return out;
}

/** Close ÷ the highest high of the last 252 bars (fewer with a shorter history), bar i included: the score's `ofHigh52`. */
export function ofHigh52Series(bars: readonly DailyBar[], length = 252): Float64Array {
  const n = bars.length;
  const out = new Float64Array(n).fill(Number.NaN);
  const deque = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i += 1) {
    while (tail > head && bars[deque[tail - 1]].h <= bars[i].h) tail -= 1;
    deque[tail++] = i;
    while (deque[head] <= i - length) head += 1;
    const high = bars[deque[head]].h;
    if (high > 0) out[i] = bars[i].c / high;
  }
  return out;
}

/** The score's points for nearness to the 52-week high (score.ts). */
export const highPoints = (ofHigh: number) => (!Number.isFinite(ofHigh) ? 2.5 : ofHigh >= 0.95 ? 5 : ofHigh >= 0.85 ? 3 : ofHigh >= 0.75 ? 1 : 0);

/** The score's relative-strength points from a 1–99 rank and close ÷ 52-week high (score.ts). */
export const rsPoints = (rank: number, ofHigh: number) => Math.round(((Math.max(1, Math.min(99, rank)) / 99) * 10 + highPoints(ofHigh)) * 10) / 10;

/** The score's RS rank (features.ts rankRelativeStrength): 1–99 by position among the scored, lowest first. */
export function rsRanks(scores: ReadonlyArray<{ symbol: string; score: number }>): Map<string, number> {
  const sorted = [...scores].sort((a, b) => a.score - b.score || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return new Map(sorted.map((entry, index) => [entry.symbol, sorted.length > 1 ? Math.round(1 + (98 * index) / (sorted.length - 1)) : 50]));
}

/** The score's RS factor as a Lab signal: ranked each day among that day's members with a value. */
function scoreRsValues(ctx: SignalContext): SignalValues {
  const rs = perSeries(ctx, (bars) => volAdjustedMomentumSeries(bars));
  const high = perSeries(ctx, (bars) => ofHigh52Series(bars));
  let cached: { day: number; points: Map<string, number> } | null = null;
  const pointsOn = (day: number) => {
    if (cached?.day === day) return cached.points;
    const scores: Array<{ symbol: string; score: number }> = [];
    for (const symbol of ctx.symbols) {
      if (ctx.isMember && !ctx.isMember(symbol, day)) continue;
      const score = rs(day, symbol);
      if (score !== null) scores.push({ symbol, score });
    }
    const ranks = rsRanks(scores);
    const points = new Map<string, number>();
    for (const [symbol, rank] of ranks) points.set(symbol, rsPoints(rank, high(day, symbol) ?? Number.NaN));
    cached = { day, points };
    return points;
  };
  return (day, symbol) => pointsOn(day).get(symbol) ?? null;
}

export const MOMENTUM_SIGNALS: LabSignal[] = [
  {
    id: "score-rs",
    name: "Score: relative strength (15 pts)",
    group: "built-in",
    kind: "numeric",
    summary:
      "The setup score's relative-strength factor as it awards it: the day's 1–99 rank of volatility-adjusted 6/12-month momentum × 10/99, plus 0–5 points for closing near the 52-week high. The baseline for momentum signals that might replace it.",
    params: [],
    build: (ctx) => scoreRsValues(ctx),
  },
  {
    id: "residual-momentum",
    name: "Residual momentum (Blitz–Huij–Martens)",
    group: "built-in",
    kind: "numeric",
    summary:
      "Residual return of months t−12…t−2 from a rolling 36-month regression of daily returns on the market (NIFTY; its equal-weight stand-in before 2012), or on the market and the stock's sector peers (factors = 2), divided by the residuals' volatility (scale = 1). High = strong stock-specific winners.",
    params: [
      { key: "factors", label: "Factors (1 market, 2 + sector)", default: 1, min: 1, max: 2, integer: true },
      { key: "scale", label: "Scale by residual volatility (1/0)", default: 1, min: 0, max: 1, integer: true },
      sessions("window", "Regression window (sessions)", 756, 252, 1008),
      sessions("lookback", "Look back (sessions)", 252, 63, 252),
      sessions("skip", "Skip latest (sessions)", 21, 0, 63),
    ],
    warmupDays: (params) => residualWarmupDays(params.window ?? 756, params.lookback ?? 252),
    usesIndustries: (params) => params.factors === 2,
    build: (ctx, { factors, scale, window, lookback, skip }) => {
      const market = barsFactor(ctx.benchmark);
      const sector = factors === 2 && ctx.industryOf ? peerFactor(ctx, ctx.industryOf) : null;
      const options = { window, lookback, skip: Math.min(skip, lookback - 3), scale: scale === 1 };
      return perSeries(ctx, (bars, symbol) => residualMomentum(bars, sector ? [market, sector] : [market], symbol, options));
    },
  },
];
