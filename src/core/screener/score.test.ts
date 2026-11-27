import { describe, expect, it } from "vitest";
import { SCORE_FACTORS, scoreSetup, type StockFacts } from "./score";

const facts = (overrides: Partial<StockFacts> = {}): StockFacts => ({
  close: 100,
  changePct: 0.5,
  clv: 0.6,
  aboveSma50: true,
  sma50AboveSma200: true,
  sma200Rising: true,
  aboveEma20: true,
  rsRank: 80,
  volRatio20: 1,
  deliveryRatio: null,
  upDownVol20: 1.2,
  pattern: null,
  bearishPattern: null,
  ext20Atr: 1,
  atr14: 2,
  resistance: null,
  support: null,
  chandelier: 95,
  turnoverCr: 50,
  ofHigh52: 0.97,
  ...overrides,
});
const plan = { entry: 100, stop: 95, target: 110, exit: "" };
const penalty = (score: ReturnType<typeof scoreSetup>, match: RegExp) => score.penalties.find((p) => match.test(p.label))?.points ?? 0;
const rsPoints = (score: ReturnType<typeof scoreSetup>) => score.parts.find((p) => p.key === "rs")!.points;

describe("setup score: market, sector, ban, 52-week high", () => {
  it("penalises long setups in a weak market", () => {
    expect(penalty(scoreSetup(facts(), plan, { holdDays: 10, regime: "healthy" }), /Market/)).toBe(0);
    expect(penalty(scoreSetup(facts(), plan, { holdDays: 10, regime: "caution" }), /Market/)).toBe(-4);
    expect(penalty(scoreSetup(facts(), plan, { holdDays: 10, regime: "risk-off" }), /Market/)).toBe(-10);
  });

  it("penalises a weak sector and a stock in the F&O ban", () => {
    expect(penalty(scoreSetup(facts({ sectorPct: 0.1 }), plan, { holdDays: 10 }), /Weak sector/)).toBe(-4);
    expect(penalty(scoreSetup(facts({ sectorPct: 0.9 }), plan, { holdDays: 10 }), /Weak sector/)).toBe(0);
    expect(penalty(scoreSetup(facts({ inBan: true }), plan, { holdDays: 10 }), /ban/)).toBe(-25);
  });

  it("gives up to 5 of the 15 RS points for nearness to the 52-week high", () => {
    const near = rsPoints(scoreSetup(facts({ ofHigh52: 0.97 }), plan, { holdDays: 10 }));
    const far = rsPoints(scoreSetup(facts({ ofHigh52: 0.6 }), plan, { holdDays: 10 }));
    expect(near - far).toBeCloseTo(5, 5);
    expect(near).toBeLessThanOrEqual(15);
  });
});

describe("gating by report cards (#29)", () => {
  const base = { holdDays: 10, regime: "caution" as const };

  it("is off without a gate: every factor counts, as before", () => {
    const score = scoreSetup(facts(), plan, base);
    expect(score.gating).toBe("off");
    expect(score.parts.every((part) => part.proven === undefined)).toBe(true);
    expect(score.total).toBe(Math.round(score.parts.reduce((sum, part) => sum + part.points, 0) - 4));
    expect(scoreSetup(facts(), plan, { ...base, gate: null }).gating).toBe("off");
  });

  it("marks the score unproven, with the same total, when no factor passes", () => {
    const ungated = scoreSetup(facts(), plan, base);
    const score = scoreSetup(facts(), plan, { ...base, gate: { proven: [] } });
    expect(score.gating).toBe("unproven");
    expect(score.total).toBe(ungated.total);
    expect(score.parts.map((part) => part.points)).toEqual(ungated.parts.map((part) => part.points));
    expect(score.parts.every((part) => part.proven === false)).toBe(true);
  });

  it("counts only proven factors, rescaled to 100, then penalties", () => {
    const score = scoreSetup(facts(), plan, { ...base, gate: { proven: ["trend", "extension"] } });
    expect(score.gating).toBe("on");
    expect(score.parts.filter((part) => part.proven).map((part) => part.key)).toEqual(["trend", "extension"]);
    // Trend 15/15 and not extended 10/10: 100, minus the caution penalty.
    expect(score.total).toBe(96);
    // Trend 3 + 4 = 7 of 15, extension 3 of 10: 10 / 25 → 40, minus 4.
    const weak = scoreSetup(facts({ aboveSma50: false, aboveEma20: false, ext20Atr: 3 }), plan, { ...base, gate: { proven: ["trend", "extension"] } });
    expect(weak.total).toBe(36);
  });

  it("lists every factor with its key, in SCORE_FACTORS order", () => {
    expect(scoreSetup(facts(), plan, base).parts.map((part) => [part.key, part.label, part.max])).toEqual(SCORE_FACTORS.map((factor) => [factor.key, factor.label, factor.max]));
  });
});
