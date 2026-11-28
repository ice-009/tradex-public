import { describe, expect, it } from "vitest";
import type { RiskModel } from "./model";
import { DEFAULT_CORRELATION_SETTINGS, correlationCut, type BookEntry } from "./sizing";

function model(symbols: string[], rho: (a: string, b: string) => number): RiskModel {
  const corr = symbols.map((a) => symbols.map((b) => (a === b ? 1 : rho(a, b))));
  return { symbols, index: Object.fromEntries(symbols.map((s, i) => [s, i])), from: 0, to: 0, sessions: 120, cov: corr, corr, vol: {}, beta: {}, shrinkage: 0, meanCorrelation: 0, returns: {}, excluded: [] };
}

const R = 5_000; // risk per trade
const settings = DEFAULT_CORRELATION_SETTINGS; // 2× budget, ρ 0.5
const open = (symbol: string, risk = R, industry = "Financial Services"): BookEntry => ({ symbol, industry, kind: "open", risk });
const idea = (symbol: string, lots: number, oneLotRisk: number, industry = "Financial Services") => ({ symbol, industry, lots, oneLotRisk });

describe("correlation cut", () => {
  it("leaves an idea alone when nothing it moves with is held", () => {
    const m = model(["HDFCBANK", "INFY"], () => 0.15);
    expect(correlationCut(idea("INFY", 2, 2_500, "IT"), [open("HDFCBANK")], R, settings, m)).toBeNull();
    expect(correlationCut(idea("INFY", 2, 2_500, "IT"), [], R, settings, m)).toBeNull();
  });

  it("leaves it alone while the cluster stays under the budget", () => {
    // One open bank (1 R) + this one (1 R) at ρ 0.82: √(2 + 1.64) ≈ 1.91 R ≤ 2 R.
    const m = model(["HDFCBANK", "ICICIBANK"], () => 0.82);
    expect(correlationCut(idea("ICICIBANK", 2, 2_500), [open("HDFCBANK")], R, settings, m)).toBeNull();
  });

  it("cuts lots to fit the budget, and says why", () => {
    // Open HDFCBANK at 1.5 R; ICICIBANK at ρ 0.82 may add x with x² + 2·0.82·1.5R·x + (1.5R)² ≤ (2R)².
    const m = model(["HDFCBANK", "ICICIBANK"], () => 0.82);
    const cut = correlationCut(idea("ICICIBANK", 2, 2_500), [open("HDFCBANK", 1.5 * R)], R, settings, m)!;
    const maxX = -0.82 * 1.5 * R + Math.sqrt((0.82 * 1.5 * R) ** 2 + (2 * R) ** 2 - (1.5 * R) ** 2);
    expect(cut.lotsAfter).toBe(Math.floor(maxX / 2_500));
    expect(cut.lotsAfter).toBe(1);
    expect(cut.text).toBe("1 lot instead of 2: 0.82 correlated with your open HDFCBANK");
    expect(cut.clusterRisk).toBeLessThanOrEqual(cut.budget);
    expect(cut.budget).toBe(2 * R);
  });

  it("skips an idea whose cluster is already at the budget", () => {
    const m = model(["HDFCBANK", "ICICIBANK", "AXISBANK"], () => 0.8);
    const book: BookEntry[] = [open("HDFCBANK"), { ...open("ICICIBANK"), kind: "idea" }];
    const cut = correlationCut(idea("AXISBANK", 2, 2_500), book, R, settings, m)!;
    expect(cut.lotsAfter).toBe(0);
    expect(cut.peers.map((peer) => peer.symbol)).toEqual(["HDFCBANK", "ICICIBANK"]);
    expect(cut.text).toMatch(/^Skipped: 0\.80 correlated with your open HDFCBANK and 1 more/);
  });

  it("five bank longs carry about two trades' risk, not five", () => {
    const banks = ["B1", "B2", "B3", "B4", "B5"];
    const m = model(banks, () => 0.45);
    const book: BookEntry[] = [];
    const lots: number[] = [];
    for (const symbol of banks) {
      const cut = correlationCut(idea(symbol, 10, R / 10), book, R, settings, m);
      const n = cut ? cut.lotsAfter : 10;
      lots.push(n);
      if (n) book.push({ symbol, industry: "Financial Services", kind: "idea", risk: (n * R) / 10 });
    }
    expect(lots).toEqual([10, 10, 4, 0, 0]);
  });

  it("counts the whole cluster, not only the stocks linked to the idea directly", () => {
    // A–B and B–C are linked (0.6), A–C isn't (0.1, other industries): C still joins A's cluster through B.
    const rho: Record<string, number> = { "A:B": 0.6, "B:C": 0.6, "A:C": 0.1 };
    const m = model(["A", "B", "C"], (a, b) => rho[`${a}:${b}`] ?? rho[`${b}:${a}`]);
    const book: BookEntry[] = [open("A", R, "X"), { ...open("B", R, "Y"), kind: "idea" }];
    const cut = correlationCut(idea("C", 10, R / 10, "Z"), book, R, settings, m)!;
    const maxX = -(0.6 + 0.1) * R + Math.sqrt(((0.6 + 0.1) * R) ** 2 + (2 * R) ** 2 - (2 + 1.2) * R ** 2);
    expect(cut.lotsAfter).toBe(Math.floor(maxX / (R / 10)));
    expect(cut.peers.map((peer) => peer.symbol)).toEqual(["B"]);
    expect(cut.cluster).toEqual(["A"]);
    expect(cut.text).toBe(`${cut.lotsAfter} lots instead of 10: 0.60 correlated with the plan's B and 1 more`);
  });

  it("links same-industry stocks from ρ 0.3, others from the threshold", () => {
    const m = model(["A", "B"], () => 0.35);
    expect(correlationCut(idea("B", 2, R), [open("A", 2 * R)], R, settings, m)?.lotsAfter).toBe(0);
    expect(correlationCut(idea("B", 2, R, "IT"), [open("A", 2 * R)], R, settings, m)).toBeNull();
  });

  it("falls back to the industry for a stock without history", () => {
    const cut = correlationCut(idea("NEWBANK", 2, R), [open("HDFCBANK", 2 * R)], R, settings, null)!;
    expect(cut.lotsAfter).toBe(0);
    expect(cut.peers[0]).toMatchObject({ symbol: "HDFCBANK", assumed: true, rho: 0.6 });
    expect(cut.text).toContain("same industry as your open HDFCBANK");
  });
});
