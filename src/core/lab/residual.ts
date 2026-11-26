import type { DailyBar } from "@/core/types";

// Residual momentum (Blitz, Huij & Martens 2011, "Residual momentum", Journal
// of Empirical Finance 18(3)): rank stocks by the part of their past return the
// factors don't explain. Each month they regress a stock's returns over the
// last 36 months on the factors, and score it by the sum of its residuals over
// months t − 12 … t − 2 divided by the residuals' standard deviation over the
// same months. Raw momentum loads on the factors (after a rally the winners are
// the high-beta stocks, which then crash in the rebound); the residual doesn't.
// Pure.
//
// Here on daily returns: at the close of bar i, OLS of the stock's daily
// return on the factors' daily returns over the `window` sessions up to i
// (default 756 ≈ 36 months), then the residuals ε = r − α − β·f summed over the
// formation window — the returns from close i − lookback to close i − skip
// (default 252 − 21 = months t − 12 … t − 2, as 12−1 momentum) — and, when
// `scale` is on, divided by their standard deviation over that window (the
// paper's version). Everything is window sums: prefix sums of r, f, r², f², r·f
// (and the cross terms for two factors) make each bar O(1).
//
// An observation (one daily return) counts only when the stock traded on both
// sessions and so did every factor, and no move is beyond `maxMove` (a missed
// split or a bad print, as the Lab's data-error guard). With two factors whose
// regression is singular (a constant or collinear second factor) the market-only
// regression is used.

export interface ResidualOptions {
  /** Regression window in sessions (default 756 ≈ 36 months). */
  window: number;
  /** Formation window: returns from close i − lookback … */
  lookback: number;
  /** … to close i − skip (default 252 − 21: months t − 12 … t − 2). */
  skip: number;
  /** Divide the residual sum by the residuals' standard deviation over the formation window. */
  scale: boolean;
  /** Fewest valid observations in the regression window (default 80% of it). */
  minObs?: number;
  /** Fewest valid observations in the formation window (default 80% of it). */
  minFormation?: number;
  /** Largest believable one-session move (default 0.5). */
  maxMove?: number;
}

export const DEFAULT_RESIDUAL: ResidualOptions = { window: 756, lookback: 252, skip: 21, scale: true };

/**
 * A factor's return between two sessions of the calendar, or null when it
 * didn't trade on both. `prev` and `day` are consecutive sessions of the stock.
 */
export type FactorReturn = (prev: number, day: number, symbol: string) => number | null;

/** A factor's returns from its bars: close(day) / close(prev) − 1 when it has both. */
export function barsFactor(bars: readonly DailyBar[]): FactorReturn {
  const close = new Map(bars.map((bar) => [bar.t, bar.c]));
  return (prev, day) => {
    const a = close.get(prev);
    const b = close.get(day);
    return a && b && a > 0 && b > 0 ? b / a - 1 : null;
  };
}

/** OLS of y on 1 + k factors from window sums. Returns α and β, or null when singular. */
export function olsFromSums(
  n: number,
  sy: number,
  sx: readonly number[],
  sxx: readonly (readonly number[])[],
  sxy: readonly number[],
): { alpha: number; beta: number[] } | null {
  const k = sx.length;
  if (n <= k + 1) return null;
  // Centred moments: C = Σxx' − n x̄x̄', c = Σxy − n x̄ ȳ.
  const mx = sx.map((value) => value / n);
  const my = sy / n;
  const C = sxx.map((row, a) => row.map((value, b) => value - n * mx[a] * mx[b]));
  const c = sxy.map((value, a) => value - n * mx[a] * my);
  let beta: number[];
  if (k === 1) {
    if (!(C[0][0] > 1e-14 * n)) return null;
    beta = [c[0] / C[0][0]];
  } else if (k === 2) {
    const det = C[0][0] * C[1][1] - C[0][1] * C[1][0];
    // Singular or nearly so (relative to the variances): no reliable split between the factors.
    if (!(C[0][0] > 1e-14 * n && C[1][1] > 1e-14 * n) || !(Math.abs(det) > 1e-8 * C[0][0] * C[1][1])) return null;
    beta = [(c[0] * C[1][1] - c[1] * C[0][1]) / det, (C[0][0] * c[1] - C[1][0] * c[0]) / det];
  } else throw new Error("olsFromSums handles one or two factors");
  const alpha = my - beta.reduce((sum, b, a) => sum + b * mx[a], 0);
  return { alpha, beta };
}

/**
 * Residual momentum of one stock at every bar (NaN where it can't be computed),
 * against one factor (`factors.length === 1`, CAPM) or two (market + sector).
 */
export function residualMomentum(bars: readonly DailyBar[], factors: readonly FactorReturn[], symbol: string, options: ResidualOptions = DEFAULT_RESIDUAL): Float64Array {
  const n = bars.length;
  const out = new Float64Array(n).fill(Number.NaN);
  const k = factors.length;
  if (k < 1 || k > 2) throw new Error("residualMomentum takes one or two factors");
  const { window, lookback, skip, scale } = options;
  const maxMove = options.maxMove ?? 0.5;
  const formation = lookback - skip;
  const minObs = options.minObs ?? Math.ceil(0.8 * window);
  const minFormation = options.minFormation ?? Math.ceil(0.8 * formation);
  if (n <= window || formation < 3 || window < lookback) return out;

  // Prefix sums over bars: P[i] holds the sums of the observations (returns) of bars 1 … i.
  // Each observation is the return from bar j − 1 to bar j.
  const cnt = new Int32Array(n);
  // Two-factor sums double as the market-only fallback (factor 0 alone) when the sector
  // factor is missing on a day: separate counts for "all factors valid" and "market valid".
  const cnt1 = new Int32Array(n);
  const S = Array.from({ length: 10 }, () => new Float64Array(n));
  const S1 = Array.from({ length: 5 }, () => new Float64Array(n));
  // S: y, yy, x0, x1, x0x0, x0x1, x1x1, x0y, x1y (index 9 unused). S1: market-only y, yy, x0, x0x0, x0y.
  for (let j = 1; j < n; j += 1) {
    for (const series of S) series[j] = series[j - 1];
    for (const series of S1) series[j] = series[j - 1];
    cnt[j] = cnt[j - 1];
    cnt1[j] = cnt1[j - 1];
    const a = bars[j - 1].c;
    const b = bars[j].c;
    if (!(a > 0 && b > 0)) continue;
    const y = b / a - 1;
    if (Math.abs(y) > maxMove) continue;
    const x0 = factors[0](bars[j - 1].t, bars[j].t, symbol);
    if (x0 === null || !Number.isFinite(x0) || Math.abs(x0) > maxMove) continue;
    cnt1[j] += 1;
    S1[0][j] += y;
    S1[1][j] += y * y;
    S1[2][j] += x0;
    S1[3][j] += x0 * x0;
    S1[4][j] += x0 * y;
    const x1 = k === 2 ? factors[1](bars[j - 1].t, bars[j].t, symbol) : 0;
    if (x1 === null || !Number.isFinite(x1) || Math.abs(x1) > maxMove) continue;
    cnt[j] += 1;
    S[0][j] += y;
    S[1][j] += y * y;
    S[2][j] += x0;
    S[3][j] += x1;
    S[4][j] += x0 * x0;
    S[5][j] += x0 * x1;
    S[6][j] += x1 * x1;
    S[7][j] += x0 * y;
    S[8][j] += x1 * y;
  }
  const win = (series: Float64Array | Int32Array, from: number, to: number) => series[to] - series[from];

  for (let i = window; i < n; i += 1) {
    const r0 = i - window; // regression: observations of bars r0 + 1 … i
    const f0 = i - lookback; // formation: observations of bars f0 + 1 … i − skip
    const f1 = i - skip;
    let fit: { alpha: number; beta: number[] } | null = null;
    let twoFactor = false;
    if (k === 2 && win(cnt, r0, i) >= minObs && win(cnt, f0, f1) >= minFormation) {
      fit = olsFromSums(
        win(cnt, r0, i),
        win(S[0], r0, i),
        [win(S[2], r0, i), win(S[3], r0, i)],
        [
          [win(S[4], r0, i), win(S[5], r0, i)],
          [win(S[5], r0, i), win(S[6], r0, i)],
        ],
        [win(S[7], r0, i), win(S[8], r0, i)],
      );
      twoFactor = fit !== null;
    }
    if (!fit) {
      if (win(cnt1, r0, i) < minObs || win(cnt1, f0, f1) < minFormation) continue;
      fit = olsFromSums(win(cnt1, r0, i), win(S1[0], r0, i), [win(S1[2], r0, i)], [[win(S1[3], r0, i)]], [win(S1[4], r0, i)]);
      if (!fit) continue;
    }
    const { alpha, beta } = fit;
    let m: number, sy: number, syy: number, e: number, e2: number;
    if (twoFactor) {
      m = win(cnt, f0, f1);
      sy = win(S[0], f0, f1);
      syy = win(S[1], f0, f1);
      const s0 = win(S[2], f0, f1);
      const s1 = win(S[3], f0, f1);
      const [b0, b1] = beta;
      e = sy - m * alpha - b0 * s0 - b1 * s1;
      // Σ(y − α − b0 x0 − b1 x1)², expanded into window sums.
      e2 =
        syy -
        2 * alpha * sy -
        2 * b0 * win(S[7], f0, f1) -
        2 * b1 * win(S[8], f0, f1) +
        m * alpha * alpha +
        2 * alpha * b0 * s0 +
        2 * alpha * b1 * s1 +
        b0 * b0 * win(S[4], f0, f1) +
        2 * b0 * b1 * win(S[5], f0, f1) +
        b1 * b1 * win(S[6], f0, f1);
    } else {
      m = win(cnt1, f0, f1);
      sy = win(S1[0], f0, f1);
      syy = win(S1[1], f0, f1);
      const s0 = win(S1[2], f0, f1);
      const [b0] = beta;
      e = sy - m * alpha - b0 * s0;
      e2 = syy - 2 * alpha * sy - 2 * b0 * win(S1[4], f0, f1) + m * alpha * alpha + 2 * alpha * b0 * s0 + b0 * b0 * win(S1[3], f0, f1);
    }
    if (!scale) {
      out[i] = e;
      continue;
    }
    const variance = (e2 - (e * e) / m) / (m - 1);
    if (variance > 1e-16) out[i] = e / Math.sqrt(variance);
  }
  return out;
}
