import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/core/types";
import { barsFactor, olsFromSums, residualMomentum, type FactorReturn } from "./residual";

const DAY = 86_400_000;
const T0 = Date.UTC(2015, 0, 1);

function rng(seed: number) {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
}
function gauss(next: () => number) {
  return () => Math.sqrt(-2 * Math.log(Math.max(next(), 1e-12))) * Math.cos(2 * Math.PI * next());
}

function barsFrom(returns: number[], dates: number[]): DailyBar[] {
  let close = 100;
  return dates.map((t, i) => {
    if (i > 0) close *= 1 + returns[i - 1];
    return { t, o: close, h: close, l: close, c: close, v: 1 };
  });
}

/** Plain OLS of y on [1, X] by the normal equations (Gauss–Jordan), for checking. */
function ols(y: number[], X: number[][]): number[] {
  const k = X[0].length + 1;
  const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  y.forEach((yi, i) => {
    const row = [1, ...X[i]];
    for (let a = 0; a < k; a += 1) {
      for (let b = 0; b < k; b += 1) A[a][b] += row[a] * row[b];
      A[a][k] += row[a] * yi;
    }
  });
  for (let c = 0; c < k; c += 1) {
    const pivot = A[c][c];
    for (let j = c; j <= k; j += 1) A[c][j] /= pivot;
    for (let r = 0; r < k; r += 1) {
      if (r === c) continue;
      const f = A[r][c];
      for (let j = c; j <= k; j += 1) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((row) => row[k]);
}

/** Residual momentum by brute force: regress over the window, sum (and scale) the formation residuals. */
function bruteForce(y: number[], X: number[][], i: number, window: number, lookback: number, skip: number, scale: boolean) {
  // Observation j is the return from bar j − 1 to bar j, stored at index j − 1.
  const reg = Array.from({ length: window }, (_, k) => i - window + 1 + k);
  const coef = ols(
    reg.map((j) => y[j - 1]),
    reg.map((j) => X[j - 1]),
  );
  const form = Array.from({ length: lookback - skip }, (_, k) => i - lookback + 1 + k);
  const eps = form.map((j) => y[j - 1] - coef[0] - X[j - 1].reduce((sum, x, a) => sum + coef[a + 1] * x, 0));
  const sum = eps.reduce((a, b) => a + b, 0);
  if (!scale) return sum;
  const mean = sum / eps.length;
  const sd = Math.sqrt(eps.reduce((a, e) => a + (e - mean) ** 2, 0) / (eps.length - 1));
  return sum / sd;
}

function synthetic(n: number, seed = 3) {
  const normal = gauss(rng(seed));
  const dates = Array.from({ length: n }, (_, i) => T0 + i * DAY);
  const market = Array.from({ length: n - 1 }, () => 0.0003 + 0.01 * normal());
  const sector = Array.from({ length: n - 1 }, (_, i) => 0.5 * market[i] + 0.008 * normal());
  const stock = Array.from({ length: n - 1 }, (_, i) => 0.0002 + 1.3 * market[i] + 0.7 * sector[i] + 0.015 * normal());
  return { dates, market, sector, stock };
}

const seriesFactor = (dates: number[], returns: number[]): FactorReturn => {
  const at = new Map(dates.map((t, i) => [t, i]));
  return (prev, day) => {
    const i = at.get(day);
    return i !== undefined && i > 0 && dates[i - 1] === prev ? returns[i - 1] : null;
  };
};

describe("olsFromSums", () => {
  it("matches plain OLS for one and two factors", () => {
    const { market, sector, stock } = synthetic(200);
    const sums = (xs: number[][]) => {
      const k = xs[0].length;
      const sx = new Array(k).fill(0);
      const sxx = Array.from({ length: k }, () => new Array(k).fill(0));
      const sxy = new Array(k).fill(0);
      let sy = 0;
      xs.forEach((x, i) => {
        sy += stock[i];
        for (let a = 0; a < k; a += 1) {
          sx[a] += x[a];
          sxy[a] += x[a] * stock[i];
          for (let b = 0; b < k; b += 1) sxx[a][b] += x[a] * x[b];
        }
      });
      return olsFromSums(xs.length, sy, sx, sxx, sxy)!;
    };
    const one = market.map((m) => [m]);
    const two = market.map((m, i) => [m, sector[i]]);
    const [a1, b1] = ols(stock, one);
    const fit1 = sums(one);
    expect(fit1.alpha).toBeCloseTo(a1, 12);
    expect(fit1.beta[0]).toBeCloseTo(b1, 10);
    const [a2, b2, c2] = ols(stock, two);
    const fit2 = sums(two);
    expect(fit2.alpha).toBeCloseTo(a2, 12);
    expect(fit2.beta[0]).toBeCloseTo(b2, 9);
    expect(fit2.beta[1]).toBeCloseTo(c2, 9);
    // Recovers the betas it was built with, roughly.
    expect(fit2.beta[0]).toBeGreaterThan(1);
    expect(fit2.beta[1]).toBeGreaterThan(0.3);
  });

  it("returns null for a singular design", () => {
    expect(olsFromSums(10, 1, [2], [[0.4]], [0.1])).toBeNull(); // Σx² = n x̄²: no variance
    // Second factor = 2 × the first: collinear.
    expect(olsFromSums(3, 0.3, [0.6, 1.2], [[0.14, 0.28], [0.28, 0.56]], [0.07, 0.14])).toBeNull();
  });
});

describe("residualMomentum", () => {
  const n = 160;
  const opts = { window: 90, lookback: 40, skip: 5 };
  const { dates, market, sector, stock } = synthetic(n);
  const bars = barsFrom(stock, dates);
  const mkt = seriesFactor(dates, market);
  const sec = seriesFactor(dates, sector);

  it("equals a brute-force rolling regression (market only, scaled and not)", () => {
    for (const scale of [true, false]) {
      const values = residualMomentum(bars, [mkt], "X", { ...opts, scale });
      expect(Number.isNaN(values[opts.window - 1])).toBe(true);
      for (const i of [opts.window, 120, n - 1]) {
        expect(values[i]).toBeCloseTo(bruteForce(stock, market.map((m) => [m]), i, opts.window, opts.lookback, opts.skip, scale), 8);
      }
    }
  });

  it("equals a brute-force rolling regression (market + sector)", () => {
    const values = residualMomentum(bars, [mkt, sec], "X", { ...opts, scale: true });
    for (const i of [opts.window, 133, n - 1]) {
      expect(values[i]).toBeCloseTo(bruteForce(stock, market.map((m, j) => [m, sector[j]]), i, opts.window, opts.lookback, opts.skip, true), 8);
    }
  });

  it("is ~0 for a stock that is only its beta to the market, however strong its past return", () => {
    const pure = market.map((m) => 0.001 + 1.5 * m);
    const values = residualMomentum(barsFrom(pure, dates), [mkt], "X", { ...opts, scale: false });
    for (let i = opts.window; i < n; i += 1) expect(Math.abs(values[i])).toBeLessThan(1e-12);
  });

  it("ranks a stock-specific winner above a high-beta stock in a market rally", () => {
    const rally = market.map((m, i) => m + (i > 100 ? 0.004 : 0));
    const marketBars = seriesFactor(dates, rally);
    const highBeta = rally.map((m, i) => 2 * m + 0.002 * Math.sin(i));
    const specific = rally.map((m, i) => 0.8 * m + (i > 100 ? 0.002 : 0) + 0.002 * Math.cos(i));
    const at = n - 1;
    const hb = residualMomentum(barsFrom(highBeta, dates), [marketBars], "HB", { ...opts, scale: true })[at];
    const sp = residualMomentum(barsFrom(specific, dates), [marketBars], "SP", { ...opts, scale: true })[at];
    // The high-beta stock's raw return is larger, but its residual isn't.
    expect(highBeta.slice(at - opts.lookback, at - opts.skip).reduce((a, b) => a + b, 0)).toBeGreaterThan(specific.slice(at - opts.lookback, at - opts.skip).reduce((a, b) => a + b, 0));
    expect(sp).toBeGreaterThan(hb);
  });

  it("leaves out data errors and sessions a factor didn't trade, and needs enough observations", () => {
    const broken = [...stock];
    broken[50] = 1.2; // a +120% day: a missed split
    const values = residualMomentum(barsFrom(broken, dates), [mkt], "X", { ...opts, scale: false });
    // Bar 51's return is dropped: same as regressing without that observation, so the value is finite.
    expect(Number.isFinite(values[n - 1])).toBe(true);
    const sparse: FactorReturn = (prev, day, symbol) => (Math.floor((day - T0) / DAY) % 3 === 0 ? null : mkt(prev, day, symbol));
    // A third of the market's days missing: below the 80% observations the regression needs.
    expect(Number.isNaN(residualMomentum(bars, [sparse], "X", { ...opts, scale: true })[n - 1])).toBe(true);
    expect(Number.isFinite(residualMomentum(bars, [sparse], "X", { ...opts, scale: true, minObs: 50, minFormation: 20 })[n - 1])).toBe(true);
  });

  it("falls back to the market-only regression when the sector factor is missing", () => {
    const none: FactorReturn = () => null;
    const both = residualMomentum(bars, [mkt, none], "X", { ...opts, scale: true });
    const one = residualMomentum(bars, [mkt], "X", { ...opts, scale: true });
    expect(both[n - 1]).toBeCloseTo(one[n - 1], 12);
  });

  it("barsFactor needs a close on both sessions", () => {
    const factor = barsFactor([
      { t: 1, o: 1, h: 1, l: 1, c: 100, v: 0 },
      { t: 2, o: 1, h: 1, l: 1, c: 110, v: 0 },
    ]);
    expect(factor(1, 2, "X")).toBeCloseTo(0.1, 12);
    expect(factor(2, 3, "X")).toBeNull();
  });
});
