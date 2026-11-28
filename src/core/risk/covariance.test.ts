import { describe, expect, it } from "vitest";
import { factorReturns, isPositiveDefinite } from "@/test/riskSynthetic";
import { shrunkCovariance, toCorrelation } from "./covariance";

describe("sample covariance", () => {
  it("matches the textbook numbers (1/T, means removed)", () => {
    const rows = [
      [1, 2],
      [2, 4],
      [3, 6],
      [4, 9],
    ];
    const { sample } = shrunkCovariance(rows);
    // x: mean 2.5, deviations ±1.5, ±0.5 → var 1.25; y: mean 5.25 → var 6.6875; cov 2.875
    expect(sample[0][0]).toBeCloseTo(1.25, 10);
    expect(sample[1][1]).toBeCloseTo(6.6875, 10);
    expect(sample[0][1]).toBeCloseTo(2.875, 10);
    expect(sample[1][0]).toBe(sample[0][1]);
  });

  it("turns covariance into correlation", () => {
    const corr = toCorrelation([
      [4, 2],
      [2, 9],
    ]);
    expect(corr[0][1]).toBeCloseTo(2 / 6, 10);
    expect(corr[0][0]).toBe(1);
  });
});

describe("Ledoit–Wolf shrinkage toward constant correlation", () => {
  // Three "banks" (group 0, ρ = 0.3 + 0.5 = 0.8 among them) and seven others (ρ = 0.3).
  const groups = [0, 0, 0, 1, 2, 3, 4, 5, 6, 7];

  it("keeps each variance and blends the correlations toward their mean", () => {
    const { rows } = factorReturns({ t: 120, groups, a: 0.3, b: 0.5 });
    const result = shrunkCovariance(rows);
    expect(result.shrinkage).toBeGreaterThan(0);
    expect(result.shrinkage).toBeLessThan(1);
    for (let i = 0; i < groups.length; i += 1) expect(result.cov[i][i]).toBeCloseTo(result.sample[i][i], 14);
    const sampleCorr = toCorrelation(result.sample);
    const shrunk = toCorrelation(result.cov);
    for (let i = 0; i < groups.length; i += 1)
      for (let j = i + 1; j < groups.length; j += 1) {
        // Each shrunk ρ lies between the sample's and the average.
        const lo = Math.min(sampleCorr[i][j], result.meanCorrelation);
        const hi = Math.max(sampleCorr[i][j], result.meanCorrelation);
        expect(shrunk[i][j]).toBeGreaterThanOrEqual(lo - 1e-12);
        expect(shrunk[i][j]).toBeLessThanOrEqual(hi + 1e-12);
        expect(shrunk[i][j]).toBeCloseTo(result.shrinkage * result.meanCorrelation + (1 - result.shrinkage) * sampleCorr[i][j], 10);
      }
  });

  it("shrinks less as the sample grows, and recovers the true correlations", () => {
    const short = shrunkCovariance(factorReturns({ t: 40, groups, a: 0.3, b: 0.5, seed: 11 }).rows);
    const long = shrunkCovariance(factorReturns({ t: 4000, groups, a: 0.3, b: 0.5, seed: 11 }).rows);
    expect(long.shrinkage).toBeLessThan(short.shrinkage);
    expect(long.shrinkage).toBeLessThan(0.05);
    const corr = toCorrelation(long.cov);
    expect(corr[0][1]).toBeCloseTo(0.8, 1);
    expect(corr[0][2]).toBeCloseTo(0.8, 1);
    expect(corr[3][4]).toBeCloseTo(0.3, 1);
    expect(long.meanCorrelation).toBeGreaterThan(0.3);
  });

  it("still separates a real cluster after shrinking 120 sessions", () => {
    const corr = toCorrelation(shrunkCovariance(factorReturns({ t: 120, groups, a: 0.3, b: 0.5, seed: 3 }).rows).cov);
    const bank = (corr[0][1] + corr[0][2] + corr[1][2]) / 3;
    const others = corr[3][4];
    expect(bank).toBeGreaterThan(0.5);
    expect(bank - others).toBeGreaterThan(0.2);
  });

  it("gives a positive-definite matrix where the sample is singular (fewer sessions than stocks)", () => {
    const { rows } = factorReturns({ t: 8, groups: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5], a: 0.3, b: 0.3, seed: 5 });
    const result = shrunkCovariance(rows);
    expect(isPositiveDefinite(result.sample)).toBe(false);
    expect(isPositiveDefinite(result.cov)).toBe(true);
    expect(result.shrinkage).toBeGreaterThan(0.3);
  });

  it("handles one stock and no data", () => {
    expect(shrunkCovariance([[0.01], [0.02], [-0.01]]).shrinkage).toBe(0);
    expect(shrunkCovariance([]).cov).toEqual([]);
  });
});
