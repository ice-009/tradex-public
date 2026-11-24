import { describe, expect, it } from "vitest";
import {
  EULER_GAMMA,
  annualisedSharpe,
  averageCorrelation,
  correlation,
  deflatedSharpe,
  effectiveTrials,
  expectedMaxSharpe,
  normCdf,
  normInv,
  perPeriodSharpe,
  probabilisticSharpe,
  sampleVariance,
  sharpeSampleOf,
  sharpeStdError,
} from "./deflatedSharpe";

const rel = (actual: number, expected: number) => Math.abs(actual - expected) / Math.abs(expected);

describe("normal distribution", () => {
  // Reference values: Python's 0.5·erfc(−x/√2) and statistics.NormalDist().inv_cdf (Wichura AS241).
  it.each([
    [0, 0.5],
    [1, 0.8413447460685429],
    [-1.96, 0.024997895148220435],
    [-3, 0.0013498980316300957],
    [3.5, 0.9997673709209645],
    [-5, 2.866515718791945e-7],
    [-6, 9.865876450377014e-10],
    [-10, 7.619853024160593e-24],
    [-20, 2.7536241186063314e-89],
  ])("Φ(%d)", (x, expected) => {
    expect(rel(normCdf(x), expected)).toBeLessThan(1e-13);
  });

  it("Φ is symmetric and saturates", () => {
    expect(normCdf(1.234) + normCdf(-1.234)).toBeCloseTo(1, 15);
    expect(normCdf(-40)).toBe(0);
    expect(normCdf(40)).toBe(1);
    expect(normCdf(NaN)).toBeNaN();
  });

  it.each([
    [0.5, 0],
    [0.975, 1.959963984540054],
    [0.99, 2.3263478740408408],
    [0.999, 3.090232306167813],
    [0.02, -2.0537489106318225],
    [1e-10, -6.361340902404057],
    [1 - 1 / (100 * Math.E), 2.680210444966888],
  ])("Φ⁻¹(%d)", (p, expected) => {
    expect(Math.abs(normInv(p) - expected)).toBeLessThan(1e-12);
  });

  it("Φ⁻¹ round-trips and handles the ends", () => {
    for (const p of [1e-300, 1e-15, 0.01, 0.3, 0.7, 0.99, 1 - 1e-12]) expect(rel(normCdf(normInv(p)), p)).toBeLessThan(1e-10);
    expect(normInv(0)).toBe(-Infinity);
    expect(normInv(1)).toBe(Infinity);
    expect(normInv(-0.1)).toBeNaN();
    expect(normInv(1.1)).toBeNaN();
  });
});

describe("deflated Sharpe ratio: Bailey & López de Prado (2014), numerical example", () => {
  // "The Deflated Sharpe Ratio", JPM 40(5), the worked example: a strategy with an
  // annualised Sharpe ratio of 2.5 over 5 years of daily data (T = 1250, 250 days a
  // year), returns with skewness −3 and kurtosis 10, selected from N = 100
  // independent trials whose annualised Sharpe ratios have variance V = 1/2.
  // The paper finds SR₀ ≈ 0.1132 (daily), i.e. ≈ 1.79 annualised, and DSR ≈ 0.9004:
  // not significant at 95% even though the strategy's PSR against zero is ≈ 1.
  const sample = { sharpe: perPeriodSharpe(2.5, 250), T: 1250, skew: -3, kurt: 10 };

  it("expected maximum Sharpe ratio of 100 trials", () => {
    const sr0Annual = expectedMaxSharpe(100, 0.5);
    expect(sr0Annual).toBeCloseTo(1.7894, 4);
    expect(perPeriodSharpe(sr0Annual, 250)).toBeCloseTo(0.1132, 4);
  });

  it("DSR ≈ 0.9004", () => {
    const daily = deflatedSharpe(sample, { nTrials: 100, varianceSR: 0.5 / 250 });
    expect(daily.dsr).toBeCloseTo(0.9004, 4);
    expect(daily.sr0).toBeCloseTo(0.1132, 4);
    expect(daily.psr).toBeGreaterThan(0.9999);
    // Same answer with the benchmark given directly.
    expect(deflatedSharpe(sample, { expectedMax: daily.sr0 }).dsr).toBeCloseTo(daily.dsr, 12);
  });

  it("more trials raise the bar", () => {
    const dsr = (n: number) => deflatedSharpe(sample, { nTrials: n, varianceSR: 0.5 / 250 }).dsr;
    expect(dsr(10)).toBeGreaterThan(dsr(100));
    expect(dsr(100)).toBeGreaterThan(dsr(1000));
  });
});

describe("probabilistic Sharpe ratio", () => {
  it("normal returns: Φ(SR·√(T−1) / √(1 + SR²/2))", () => {
    const s = { sharpe: 0.1, T: 101, skew: 0, kurt: 3 };
    expect(sharpeStdError(s)).toBeCloseTo(Math.sqrt((1 + 0.01 / 2) / 100), 14);
    expect(probabilisticSharpe(s)).toBeCloseTo(normCdf(0.1 / Math.sqrt(1.005 / 100)), 14);
    expect(probabilisticSharpe({ ...s, sharpe: 0 })).toBe(0.5);
  });

  it("negative skew and fat tails widen the error", () => {
    const base = { sharpe: 0.1, T: 500, skew: 0, kurt: 3 };
    expect(probabilisticSharpe({ ...base, skew: -2, kurt: 12 })).toBeLessThan(probabilisticSharpe(base));
  });

  it("undefined inputs give NaN", () => {
    expect(probabilisticSharpe({ sharpe: 0.1, T: 1, skew: 0, kurt: 3 })).toBeNaN();
    expect(probabilisticSharpe({ sharpe: NaN, T: 100, skew: 0, kurt: 3 })).toBeNaN();
    // Impossible moments (kurt < 1 + skew²) can make the variance negative.
    expect(sharpeStdError({ sharpe: 2, T: 100, skew: 3, kurt: 1 })).toBeNaN();
  });
});

describe("edge cases", () => {
  it("N = 1: nothing was selected, so DSR = PSR against zero", () => {
    const s = { sharpe: 0.08, T: 750, skew: -0.5, kurt: 5 };
    const result = deflatedSharpe(s, { nTrials: 1, varianceSR: 0.01 });
    expect(result.sr0).toBe(0);
    expect(result.dsr).toBe(result.psr);
    expect(result.psr).toBe(probabilisticSharpe(s, 0));
  });

  it("expected maximum: zero spread or ≤ 1 trial is 0; bad input is NaN; Euler's γ", () => {
    expect(expectedMaxSharpe(50, 0)).toBe(0);
    expect(expectedMaxSharpe(0.5, 1)).toBe(0);
    expect(expectedMaxSharpe(10, -1)).toBeNaN();
    expect(expectedMaxSharpe(NaN, 1)).toBeNaN();
    expect(EULER_GAMMA).toBeCloseTo(0.5772156649, 10);
    // Fractional (effective) counts are fine and lie between their neighbours.
    expect(expectedMaxSharpe(2.5, 1)).toBeGreaterThan(expectedMaxSharpe(2, 1));
    expect(expectedMaxSharpe(2.5, 1)).toBeLessThan(expectedMaxSharpe(3, 1));
  });

  it("effective number of trials: ρ̄ + (1 − ρ̄)·M", () => {
    expect(effectiveTrials(20, 0)).toBe(20);
    expect(effectiveTrials(20, 1)).toBe(1);
    expect(effectiveTrials(20, 0.5)).toBe(10.5);
    expect(effectiveTrials(20, -0.3)).toBe(20); // no credit for negative correlation
    expect(effectiveTrials(20, null)).toBe(20);
    expect(effectiveTrials(20, NaN)).toBe(20);
    expect(effectiveTrials(1, 0.5)).toBe(1);
    expect(effectiveTrials(0, 0.5)).toBe(0);
  });

  it("correlations", () => {
    expect(correlation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 14);
    expect(correlation([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 14);
    expect(correlation([1, 1, 1], [1, 2, 3])).toBeNaN();
    expect(correlation([1], [1])).toBeNaN();
    expect(averageCorrelation([[1, 2, 3, 4], [2, 4, 6, 8], [4, 3, 2, 1]])).toBeCloseTo(-1 / 3, 14);
    expect(averageCorrelation([[1, 2, 3]])).toBeNaN();
  });

  it("sample moments of a return series", () => {
    const s = sharpeSampleOf([0.01, -0.02, 0.03, 0.0, 0.015]);
    const mean = 0.007;
    const sd = Math.sqrt(sampleVariance([0.01, -0.02, 0.03, 0.0, 0.015]));
    expect(s.T).toBe(5);
    expect(s.sharpe).toBeCloseTo(mean / sd, 12);
    expect(Number.isFinite(s.skew) && Number.isFinite(s.kurt)).toBe(true);
    expect(sharpeSampleOf([1]).sharpe).toBeNaN();
    expect(sharpeSampleOf([1, 1, 1]).sharpe).toBeNaN();
    expect(sampleVariance([5])).toBe(0);
    expect(annualisedSharpe(perPeriodSharpe(1.5, 252), 252)).toBeCloseTo(1.5, 14);
  });
});
