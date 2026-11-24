import { describe, expect, it } from "vitest";
import { deflatedSharpe, expectedMaxSharpe, perPeriodSharpe, probabilisticSharpe, sampleVariance } from "./deflatedSharpe";
import {
  PROMOTION_THRESHOLD,
  annualSharpeOf,
  canonicalJson,
  groupByIdea,
  isIdeaId,
  latestPerTrial,
  periodsPerYearOf,
  promotionVerdict,
  summarizeIdea,
  trialInputError,
  trialKey,
  trialStats,
  variantKeyOf,
  verdictAgainst,
  type Trial,
} from "./trials";

const DAY = 86_400_000;

function trial(over: Partial<Trial> = {}): Trial {
  const params = over.params ?? { lookback: 20 };
  return {
    ideaId: "momentum",
    variantKey: variantKeyOf("mom", params),
    params,
    period: { from: null, to: 20_000 * DAY },
    horizon: 1,
    sharpe: 0.05,
    T: 2_500,
    skew: 0,
    kurt: 3,
    spreadMean: 0.001,
    tStat: 2.5,
    stampHash: "abc",
    runAt: 1_000,
    ...over,
  };
}

describe("variant keys", () => {
  it("canonical params JSON ignores key order and undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: 3 }, z: undefined })).toBe('{"a":{"c":3,"d":[2,{"x":2,"y":1}]},"b":1}');
    expect(variantKeyOf("mom", { b: 2, a: 1 })).toBe(variantKeyOf("mom", { a: 1, b: 2 }));
    expect(variantKeyOf("mom", { a: 1 })).toBe('mom {"a":1}');
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("one trial per variant × horizon; the latest run wins", () => {
    const old = trial({ runAt: 1, sharpe: 0.01 });
    const newer = trial({ runAt: 2, sharpe: 0.02 });
    const other = trial({ horizon: 5 });
    expect(trialKey(old)).toBe(trialKey(newer));
    expect(trialKey(old)).not.toBe(trialKey(other));
    expect(latestPerTrial([old, newer, other]).map((t) => t.sharpe)).toEqual([0.02, 0.05]);
    expect(latestPerTrial([newer, old]).map((t) => t.sharpe)).toEqual([0.02]);
  });

  it("groups by idea", () => {
    const groups = groupByIdea([trial(), trial({ ideaId: "value" }), trial({ horizon: 5 })]);
    expect([...groups.keys()]).toEqual(["momentum", "value"]);
    expect(groups.get("momentum")).toHaveLength(2);
  });
});

describe("input checks", () => {
  it("accepts a good trial and names what's wrong with a bad one", () => {
    expect(trialInputError(trial())).toBeNull();
    expect(trialInputError(trial({ ideaId: "has space" }))).toMatch(/ideaId/);
    expect(trialInputError(trial({ variantKey: "" }))).toMatch(/variantKey/);
    expect(trialInputError(trial({ params: [] as unknown as Record<string, unknown> }))).toMatch(/params/);
    expect(trialInputError(trial({ horizon: 0 }))).toMatch(/horizon/);
    expect(trialInputError(trial({ periodsPerYear: -1 }))).toMatch(/periodsPerYear/);
    expect(trialInputError(trial({ T: 1 }))).toMatch(/T must/);
    expect(trialInputError(trial({ sharpe: NaN }))).toMatch(/finite/);
    expect(trialInputError(trial({ kurt: 0 }))).toMatch(/non-excess/);
    expect(trialInputError(trial({ period: { from: null, to: NaN } }))).toMatch(/period/);
    expect(trialInputError(trial({ stampHash: 1 as unknown as string }))).toMatch(/stampHash/);
    expect(isIdeaId("momentum-12_1:v2")).toBe(true);
    expect(isIdeaId(null)).toBe(false);
    expect(isIdeaId("x".repeat(81))).toBe(false);
  });
});

describe("units", () => {
  it("periods per year default to 252 / horizon", () => {
    expect(periodsPerYearOf({ horizon: 1 })).toBe(252);
    expect(periodsPerYearOf({ horizon: 21 })).toBe(12);
    expect(periodsPerYearOf({ horizon: 5, periodsPerYear: 252 })).toBe(252);
    expect(annualSharpeOf({ sharpe: 0.1, horizon: 1 })).toBeCloseTo(0.1 * Math.sqrt(252), 12);
  });

  it("trials at different horizons are compared annualised", () => {
    const a = trial({ horizon: 1, sharpe: perPeriodSharpe(1, 252) });
    const b = trial({ horizon: 21, sharpe: perPeriodSharpe(1, 12) });
    // Same annual Sharpe → no spread → no luck bar.
    const stats = trialStats([a, b]);
    expect(stats.varianceAnnual).toBeCloseTo(0, 12);
    expect(stats.sr0Annual).toBeCloseTo(0, 6);
  });
});

describe("promotion verdict", () => {
  it("reproduces the paper's example: DSR ≈ 0.9004 after 100 trials fails the 0.95 bar", () => {
    // Bailey & López de Prado (2014): annual SR 2.5, T = 1250 daily, skew −3, kurt 10, N = 100, V = 1/2.
    const candidate = trial({ sharpe: perPeriodSharpe(2.5, 250), T: 1250, skew: -3, kurt: 10, periodsPerYear: 250 });
    const verdict = verdictAgainst(candidate, { n: 100, nEff: 100, varianceAnnual: 0.5, sr0Annual: expectedMaxSharpe(100, 0.5) });
    expect(verdict.dsr).toBeCloseTo(0.9004, 4);
    expect(verdict.sr0Annual).toBeCloseTo(1.7894, 4);
    expect(verdict.passes).toBe(false);
    expect(verdict.reason).toMatch(/^Fails: deflated Sharpe 0\.900 < 0\.95 after 100 trials/);
    // With ten trials of the same spread it would pass.
    expect(verdictAgainst(candidate, { n: 10, nEff: 10, varianceAnnual: 0.5, sr0Annual: expectedMaxSharpe(10, 0.5) }).passes).toBe(true);
  });

  it("is the DSR of the candidate against the variance of every trial's Sharpe", () => {
    const sharpes = [0.02, 0.035, 0.01, 0.06, -0.01];
    const trials = sharpes.map((sharpe, i) => trial({ params: { lookback: 10 * (i + 1) }, sharpe }));
    const candidate = trials[3];
    const verdict = promotionVerdict(trials, candidate);
    const expected = deflatedSharpe(candidate, { nTrials: 5, varianceSR: sampleVariance(sharpes) });
    expect(verdict.n).toBe(5);
    expect(verdict.nEff).toBe(5);
    expect(verdict.dsr).toBeCloseTo(expected.dsr, 12);
    expect(verdict.psr).toBeCloseTo(expected.psr, 12);
    expect(verdict.passes).toBe(verdict.dsr >= PROMOTION_THRESHOLD);
  });

  it("counts the candidate once, ignores other ideas, and lets correlation lower the count", () => {
    const trials = [trial({ params: { a: 1 }, sharpe: 0.03 }), trial({ params: { a: 2 }, sharpe: 0.06 }), trial({ ideaId: "other", params: { a: 3 } })];
    const candidate = { ...trials[1], runAt: 5_000, sharpe: 0.07 }; // a newer run of a trial already recorded
    expect(promotionVerdict(trials, candidate).n).toBe(2);
    const fresh = trial({ params: { a: 9 }, sharpe: 0.065 });
    expect(promotionVerdict(trials, fresh).n).toBe(3);
    const correlated = promotionVerdict(trials, fresh, { avgCorrelation: 0.8 });
    expect(correlated.nEff).toBeCloseTo(0.8 + 0.2 * 3, 12);
    expect(correlated.dsr).toBeGreaterThan(promotionVerdict(trials, fresh).dsr);
    expect(correlated.reason).toMatch(/effective/);
  });

  it("one trial: DSR is PSR against zero", () => {
    const only = trial({ sharpe: 0.08, T: 1000, skew: -0.4, kurt: 6 });
    const verdict = promotionVerdict([], only);
    expect(verdict.n).toBe(1);
    expect(verdict.sr0Annual).toBe(0);
    expect(verdict.dsr).toBe(probabilisticSharpe(only, 0));
    expect(verdict.dsr).toBe(verdict.psr);
    expect(verdict.passes).toBe(true);
    expect(verdict.reason).toMatch(/^Passes/);
    const weak = promotionVerdict([], trial({ sharpe: 0.01, T: 100 }));
    expect(weak.passes).toBe(false);
    expect(weak.reason).toMatch(/chance the true Sharpe ratio is above zero/);
  });

  it("can't-compute is a fail with a reason", () => {
    const verdict = promotionVerdict([], trial({ sharpe: 2, skew: 3, kurt: 1 }));
    expect(verdict.passes).toBe(false);
    expect(verdict.dsr).toBeNaN();
    expect(verdict.reason).toMatch(/Can't compute/);
  });

  it("a custom threshold", () => {
    const only = trial({ sharpe: 0.04, T: 1000 });
    expect(promotionVerdict([], only, { threshold: 0.999999 }).passes).toBe(false);
  });
});

describe("summary", () => {
  it("ranks variants by DSR, counts runs and picks the best", () => {
    const trials = [
      trial({ params: { lookback: 10 }, sharpe: 0.02, runAt: 1 }),
      trial({ params: { lookback: 10 }, sharpe: 0.03, runAt: 2, stampHash: "def" }),
      trial({ params: { lookback: 20 }, sharpe: 0.06, runAt: 3 }),
      trial({ params: { lookback: 20 }, horizon: 5, sharpe: 0.01, runAt: 4 }),
      trial({ ideaId: "other", sharpe: 0.2 }),
    ];
    const summary = summarizeIdea("momentum", trials, { avgCorrelation: 0.25 });
    expect(summary.runs).toBe(4);
    expect(summary.n).toBe(3);
    expect(summary.nEff).toBeCloseTo(0.25 + 0.75 * 3, 12);
    expect(summary.avgCorrelation).toBe(0.25);
    expect(summary.threshold).toBe(PROMOTION_THRESHOLD);
    expect(summary.variants.map((row) => row.sharpe)).toEqual([0.06, 0.03, 0.01]);
    expect(summary.variants[1].runs).toBe(2);
    expect(summary.best?.variantKey).toBe(variantKeyOf("mom", { lookback: 20 }));
    expect(summary.best?.verdict.dsr).toBe(summary.variants[0].dsr);
    expect(summary.variants[0].dsr).toBeGreaterThan(summary.variants[1].dsr);
  });

  it("an idea with no trials", () => {
    const summary = summarizeIdea("nothing", [trial()]);
    expect(summary.n).toBe(0);
    expect(summary.best).toBeNull();
    expect(summary.variants).toEqual([]);
    expect(summary.avgCorrelation).toBeNull();
  });
});
