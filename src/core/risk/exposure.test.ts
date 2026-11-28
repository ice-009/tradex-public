import { describe, expect, it } from "vitest";
import { factorReturns } from "@/test/riskSynthetic";
import { OTHER_RHO, SAME_INDUSTRY_RHO, combinedRisk, linked, pairRho, portfolioExposure, riskPosition, type RiskPosition } from "./exposure";
import { buildRiskModel, type RiskModel } from "./model";

/** A model with a fixed correlation matrix (vol 1% a day, beta 1). */
function fixedModel(symbols: string[], corr: number[][]): RiskModel {
  const vol = 0.01;
  return {
    symbols,
    index: Object.fromEntries(symbols.map((symbol, i) => [symbol, i])),
    from: 0,
    to: 0,
    sessions: 20,
    cov: corr.map((row) => row.map((value) => value * vol * vol)),
    corr,
    vol: Object.fromEntries(symbols.map((symbol) => [symbol, vol])),
    beta: Object.fromEntries(symbols.map((symbol) => [symbol, 1])),
    shrinkage: 0,
    meanCorrelation: 0,
    returns: Object.fromEntries(symbols.map((symbol, i) => [symbol, Array.from({ length: 20 }, (_, t) => (t === i ? -0.05 : 0.001))])),
    excluded: [],
  };
}

const position = (symbol: string, industry: string, kind: RiskPosition["kind"] = "open", qty = 100, price = 100, stop = 90) => riskPosition({ symbol, kind, industry, qty, price, stop });

describe("risk arithmetic", () => {
  it("a long's notional and risk to its stop (none once under it)", () => {
    expect(position("A", "Bank")).toMatchObject({ notional: 10_000, risk: 1_000 });
    expect(position("A", "Bank", "open", 100, 85, 90).risk).toBe(0);
  });

  it("combines risks through correlations: the sum at ρ 1, the root sum of squares at ρ 0", () => {
    expect(combinedRisk([3, 4], () => 1)).toBeCloseTo(7, 12);
    expect(combinedRisk([3, 4], () => 0)).toBeCloseTo(5, 12);
    expect(combinedRisk([1, 1, 1, 1, 1], () => 0.8)).toBeCloseTo(Math.sqrt(21), 12);
  });

  it("falls back to the industry when the model can't say", () => {
    const model = fixedModel(["A", "B"], [
      [1, 0.2],
      [0.2, 1],
    ]);
    expect(pairRho(model, { symbol: "A", industry: "Bank" }, { symbol: "B", industry: "Bank" })).toEqual({ rho: 0.2, assumed: false });
    expect(pairRho(model, { symbol: "A", industry: "Bank" }, { symbol: "C", industry: "Bank" })).toEqual({ rho: SAME_INDUSTRY_RHO, assumed: true });
    expect(pairRho(null, { symbol: "A", industry: "Bank" }, { symbol: "C", industry: "IT" })).toEqual({ rho: OTHER_RHO, assumed: true });
    expect(pairRho(null, { symbol: "A", industry: "" }, { symbol: "C", industry: "" }).rho).toBe(OTHER_RHO);
  });

  it("links pairs over the threshold, or same-industry pairs from 0.3", () => {
    expect(linked({ industry: "Bank" }, { industry: "IT" }, 0.55, 0.5)).toBe(true);
    expect(linked({ industry: "Bank" }, { industry: "IT" }, 0.45, 0.5)).toBe(false);
    expect(linked({ industry: "Bank" }, { industry: "Bank" }, 0.35, 0.5)).toBe(true);
    expect(linked({ industry: "Bank" }, { industry: "Bank" }, 0.2, 0.5)).toBe(false);
  });
});

describe("portfolio exposure", () => {
  const model = fixedModel(
    ["HDFC", "ICICI", "INFY"],
    [
      [1, 0.8, 0.1],
      [0.8, 1, 0.1],
      [0.1, 0.1, 1],
    ],
  );
  const book = [position("HDFC", "Bank"), position("ICICI", "Bank", "idea"), position("INFY", "IT", "idea", 50)];
  const exposure = portfolioExposure(book, model, { capital: 100_000, threshold: 0.5 });

  it("sums notional and risk, and the correlated risk is between √Σr² and Σr", () => {
    expect(exposure.notional).toBe(25_000);
    expect(exposure.grossRisk).toBe(2_500);
    const expected = Math.sqrt(1_000 ** 2 * 2 + 500 ** 2 + 2 * 0.8 * 1_000 * 1_000 + 2 * 0.1 * 1_000 * 500 * 2);
    expect(exposure.correlatedRisk).toBeCloseTo(expected, 6);
    expect(exposure.effectiveBets).toBeCloseTo(2_500 ** 2 / expected ** 2, 10);
    expect(exposure.effectiveBets).toBeGreaterThan(1);
    expect(exposure.effectiveBets).toBeLessThan(3);
  });

  it("breaks risk down by sector and finds the cluster", () => {
    expect(exposure.sectors.map((sector) => [sector.industry, sector.count, sector.risk])).toEqual([
      ["Bank", 2, 2_000],
      ["IT", 1, 500],
    ]);
    expect(exposure.sectors[0].share).toBeCloseTo(0.8, 12);
    expect(exposure.clusters).toHaveLength(1);
    expect(exposure.clusters[0].symbols).toEqual(["HDFC", "ICICI"]);
    expect(exposure.clusters[0].correlatedRisk).toBeCloseTo(Math.sqrt(2 * 1e6 + 1.6e6), 6);
  });

  it("measures beta, ₹ volatility and the historical tail", () => {
    expect(exposure.betaNotional).toBe(25_000);
    expect(exposure.netBeta).toBeCloseTo(0.25, 12);
    expect(exposure.dailyVol).toBeGreaterThan(0);
    // Worst day of 20 (5%): one stock's −5% day while the others make 0.1%.
    expect(exposure.tailLoss).toBeCloseTo(10_000 * (1 - Math.exp(-0.05)) - 10_000 * (Math.exp(0.001) - 1) - 5_000 * (Math.exp(0.001) - 1), 4);
    expect(exposure.matrix.symbols).toEqual(["HDFC", "ICICI", "INFY"]);
    expect(exposure.matrix.rho[0][1]).toBe(0.8);
    expect(exposure.uncovered).toEqual([]);
  });

  it("lists positions the model doesn't hold and assumes their ρ", () => {
    const out = portfolioExposure([...book, position("AXIS", "Bank", "idea")], model, { capital: 100_000, threshold: 0.5 });
    expect(out.uncovered).toEqual(["AXIS"]);
    expect(out.matrix.assumed[0][3]).toBe(true);
    expect(out.clusters[0].symbols).toEqual(["HDFC", "ICICI", "AXIS"]);
  });

  it("works on a model from real-shaped returns, and on nothing", () => {
    const { rows, market } = factorReturns({ t: 120, groups: [0, 0, 1], a: 0.3, b: 0.4 });
    const built = buildRiskModel({ sessions: rows.map((_, i) => i), benchmark: market, returns: { A: rows.map((r) => r[0]), B: rows.map((r) => r[1]), C: rows.map((r) => r[2]) } });
    const out = portfolioExposure([position("A", "X"), position("B", "X"), position("C", "Y")], built, { capital: 1e6, threshold: 0.5 });
    expect(out.dailyVol).toBeGreaterThan(0);
    expect(out.tailLoss).toBeGreaterThan(0);
    const empty = portfolioExposure([], null, { capital: 1e6, threshold: 0.5 });
    expect(empty).toMatchObject({ grossRisk: 0, correlatedRisk: 0, effectiveBets: 0, dailyVol: null, tailLoss: null, betaNotional: null });
  });
});
