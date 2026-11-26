import { describe, expect, it } from "vitest";
import type { HorizonReport, LabReport, SpreadPair } from "./engine";
import type { SeriesStats } from "./stats";
import { MIN_DAYS, MIN_INDEPENDENT, primaryHorizon, regimeDsr, signalVerdict, type LuckCheck } from "./verdict";

// The report card's verdict rules (verdict.ts) on hand-made reports: every
// number below is what the rule looks at, nothing else.

const stats = (mean: number | null, t: number | null, n: number, over: Partial<SeriesStats> = {}): SeriesStats => ({
  n,
  mean,
  t,
  sd: 0.02,
  sharpe: mean === null ? null : mean / 0.02,
  hitRate: 0.5,
  skewness: 0,
  kurtosis: 3,
  ...over,
});
const pair = (mean: number | null, t: number | null, n: number, over: Partial<SeriesStats> = {}, grossMean = mean === null ? null : mean + 0.002): SpreadPair => ({
  gross: stats(grossMean, t, n, over),
  net: stats(mean, t, n, over),
});

interface Shape {
  horizon?: number;
  net?: [number | null, number | null, number];
  gross?: number | null;
  first?: number;
  last?: number;
  up?: [number, number | null, number, Partial<SeriesStats>?];
  down?: [number, number | null, number, Partial<SeriesStats>?];
  independent?: number;
}

function horizon(shape: Shape = {}): HorizonReport {
  const k = shape.horizon ?? 5;
  const [mean, t, n] = shape.net ?? [0.004, 3.2, 1000];
  const first = shape.first ?? 0.004;
  const last = shape.last ?? 0.004;
  const passes = n >= 30 && first > 0 && last > 0 && t !== null && t > 2 && (mean ?? 0) > 0;
  const up = shape.up ?? [0.005, 3, 600];
  const down = shape.down ?? [0.003, 2.1, 400];
  return {
    horizon: k,
    lag: k - 1,
    quantiles: [],
    spread: pair(mean, t, n, {}, shape.gross === undefined ? (mean === null ? null : mean + 0.002) : shape.gross),
    sharpeAnnual: 1,
    netAtTurnover: mean,
    cost: { long: 0.001, short: 0.001 },
    ic: { mean: 0.02, t: 2, days: n },
    regimes: { up: pair(up[0], up[1], up[2], up[3]), down: pair(down[0], down[1], down[2], down[3]), unknown: 0 },
    split: { splitDate: Date.UTC(2024, 0, 1), first: pair(first, 2, Math.round(n * 0.6)), last: pair(last, 2, Math.round(n * 0.4)) },
    turnover: { buckets: [], long: 0.2, short: 0.2 },
    dsr: { sharpe: 0.2, n: shape.independent ?? Math.floor(n / k), skewness: 0, kurtosis: 3, step: k },
    series: { days: [], net: [] },
    passes,
  };
}

function report(horizons: HorizonReport[], over: Partial<LabReport> = {}): LabReport {
  return {
    engine: "lab/1",
    signal: { id: "test", name: "Test", kind: "numeric", params: {}, variantKey: "test {}" },
    quantiles: 5,
    horizons: horizons.map((h) => h.horizon),
    period: { from: Date.UTC(2021, 0, 1), to: Date.UTC(2025, 11, 31), days: 1200, sessions: 1250, skippedDays: 0 },
    universe: { symbols: 180, perDay: { min: 150, mean: 170, max: 185 } },
    observations: 200_000,
    truncated: 0,
    dataErrors: { maxDailyMove: 0.5, bars: 0, observations: 0, symbols: [] },
    costPerTrade: 0.001,
    occupiedBuckets: 5,
    byHorizon: horizons,
    decay: [],
    dailyTurnover: { buckets: [], long: 0.1, short: 0.1 },
    notes: [],
    ...over,
  };
}

const LUCKY: LuckCheck = { dsr: 0.99, passes: true, n: 8, nEff: 8, sr0Annual: 0.6 };
const UNLUCKY: LuckCheck = { dsr: 0.71, passes: false, n: 40, nEff: 40, sr0Annual: 1.4 };

describe("signal verdict", () => {
  it("works: an edge over the whole period, stable, both regimes positive, survives deflation", () => {
    const verdict = signalVerdict(report([horizon()]), { luck: LUCKY });
    expect(verdict.label).toBe("works");
    expect(verdict.preDeflation).toBe("works");
    expect(verdict.deflation).toBe("passes");
    expect(verdict.horizon).toBe(5);
    expect(verdict.headline).toMatch(/^Works: Q5 beat Q1 by \+0\.400% net per 5-session hold \(t 3\.20\).*both market regimes.*8 trials/);
    expect(verdict.reasons.some((reason) => reason.includes("0.990 ≥ 0.95 after 8 trials"))).toBe(true);
  });

  it("works pre-deflation but fails the DSR: no edge, likely luck after N trials", () => {
    const verdict = signalVerdict(report([horizon()]), { luck: UNLUCKY });
    expect(verdict.label).toBe("no edge");
    expect(verdict.preDeflation).toBe("works");
    expect(verdict.deflation).toBe("fails");
    expect(verdict.dsr).toBe(0.71);
    expect(verdict.headline).toContain("likely luck after 40 trials");
    expect(verdict.reasons.join(" ")).toMatch(/Looks good, but likely luck after 40 trials: deflated Sharpe ratio 0\.710 < 0\.95/);
  });

  it("without a trial record the label stands, marked unchecked", () => {
    const verdict = signalVerdict(report([horizon()]));
    expect(verdict.label).toBe("works");
    expect(verdict.deflation).toBe("unchecked");
    expect(verdict.reasons.join(" ")).toContain("Not checked for luck");
    // A DSR that can't be computed is unchecked too.
    expect(signalVerdict(report([horizon()]), { luck: { ...LUCKY, dsr: NaN, passes: false } }).deflation).toBe("unchecked");
  });

  it("an edge carried by one regime: works in uptrends / downtrends only", () => {
    const upOnly = signalVerdict(report([horizon({ up: [0.008, 3.5, 600], down: [-0.002, -0.8, 400] })]), { luck: LUCKY });
    expect(upOnly.label).toBe("works in uptrends only");
    expect(upOnly.headline).toMatch(/^Works in uptrends only: \+0\.800% net.*−0\.200% when below/);
    const downOnly = signalVerdict(report([horizon({ net: [0.001, 1.1, 1000], up: [-0.001, -0.5, 600], down: [0.006, 2.8, 400] })]), { luck: LUCKY });
    expect(downOnly.label).toBe("works in downtrends only");
    expect(downOnly.preDeflation).toBe("works in downtrends only");
    // The other regime with too few days to judge still allows a regime-only verdict.
    expect(signalVerdict(report([horizon({ net: [0.001, 1.5, 1000], up: [0.006, 2.6, 980], down: [0.01, 1, 20] })])).label).toBe("works in uptrends only");
  });

  it("a regime-only verdict is deflated on the regime's own days", () => {
    const shape: Shape = { net: [0.001, 1.1, 1000], up: [0.008, 3.5, 600, { sharpe: 0.35 }], down: [-0.002, -0.8, 400] };
    const bar = { ...LUCKY, sr0Annual: 0.5 };
    const passes = signalVerdict(report([horizon(shape)]), { luck: bar });
    expect(passes.label).toBe("works in uptrends only");
    expect(passes.dsr).toBeCloseTo(regimeDsr(horizon(shape).regimes.up.net, 5, bar)!, 12);
    expect(passes.deflation).toBe("passes");
    const fails = signalVerdict(report([horizon({ ...shape, up: [0.008, 3.5, 600, { sharpe: 0.1 }] })]), { luck: { ...bar, sr0Annual: 3, n: 60, nEff: 60 } });
    expect(fails.label).toBe("no edge");
    expect(fails.preDeflation).toBe("works in uptrends only");
    expect(fails.headline).toContain("likely luck after 60 trials");
    expect(fails.reasons.join(" ")).toContain("uptrend days' deflated Sharpe ratio");
  });

  it("regimeDsr: null without the moments or with too few independent observations", () => {
    expect(regimeDsr(stats(0.01, 3, 600, { sharpe: null }), 5, LUCKY)).toBeNull();
    expect(regimeDsr(stats(0.01, 3, 6), 5, LUCKY)).toBeNull();
    const strong = regimeDsr(stats(0.01, 3, 600, { sharpe: 0.5 }), 5, LUCKY)!;
    const weak = regimeDsr(stats(0.01, 3, 600, { sharpe: 0.05 }), 5, LUCKY)!;
    expect(strong).toBeGreaterThan(weak);
  });

  it("no edge: t too low, unstable over time, or below zero", () => {
    const low = signalVerdict(report([horizon({ net: [0.001, 1.2, 1000], up: [0.001, 1, 600], down: [0.001, 0.8, 400] })]), { luck: LUCKY });
    expect(low.label).toBe("no edge");
    expect(low.preDeflation).toBe("no edge");
    expect(low.reasons[0]).toContain("t needs to be above 2");
    const unstable = signalVerdict(report([horizon({ last: -0.002, up: [0.004, 1.9, 600] })]), { luck: LUCKY });
    expect(unstable.label).toBe("no edge");
    expect(unstable.headline).toContain("not in both parts of the period");
    expect(unstable.reasons.join(" ")).toContain("Not stable over time");
    // A DSR is still reported for a no-edge verdict when the record has one.
    expect(signalVerdict(report([horizon({ net: [-0.001, -1, 1000] })]), { luck: UNLUCKY })).toMatchObject({ label: "no edge", deflation: "fails", dsr: 0.71 });
  });

  it("too little data: too few days or too few non-overlapping spreads", () => {
    const few = signalVerdict(report([horizon({ net: [0.01, 5, MIN_DAYS - 1] })]), { luck: LUCKY });
    expect(few.label).toBe("too little data");
    expect(few.headline).toContain(`needs ${MIN_DAYS} days and ${MIN_INDEPENDENT} non-overlapping`);
    expect(signalVerdict(report([horizon({ horizon: 63, net: [0.01, 5, 900], independent: 14 })])).label).toBe("too little data");
    expect(signalVerdict(report([])).label).toBe("too little data");
  });

  it("explains costs eating a gross edge, a reliably negative spread and data errors", () => {
    const eaten = signalVerdict(report([horizon({ net: [-0.0005, -0.4, 1000], gross: 0.0015 })]));
    expect(eaten.reasons.join(" ")).toContain("Costs eat it: +0.150% before costs, −0.050% after");
    const negative = signalVerdict(
      report([horizon({ net: [-0.004, -3.5, 1000], gross: -0.003, first: -0.004, last: -0.004, up: [-0.004, -3, 600], down: [-0.004, -2.5, 400] })], {
        dataErrors: { maxDailyMove: 0.5, bars: 4, observations: 1000, symbols: [] },
      }),
    );
    expect(negative.label).toBe("no edge");
    const text = negative.reasons.join(" ");
    expect(text).toContain("reliably negative (t −3.50): Q1 beat Q5");
    expect(text).toContain("about +0.200% per 5-session hold"); // −gross − costs = 0.3% − 0.1%
    expect(text).toContain("At or below zero in both parts of the period");
    expect(text).toContain("1,000 observations (0.5%) were left out as data errors");
  });

  it("binary signals: matched stocks vs the rest", () => {
    const verdict = signalVerdict(report([horizon()], { signal: { id: "screen:x", name: "X", kind: "binary", params: {}, variantKey: "screen:x {}" } }));
    expect(verdict.headline).toContain("matched stocks beat the rest");
  });

  it("no regime data: the split is skipped", () => {
    const h = horizon();
    h.regimes = { up: pair(null, null, 0), down: pair(null, null, 0), unknown: 1000 };
    const verdict = signalVerdict(report([h]), { luck: LUCKY });
    expect(verdict.label).toBe("works");
    expect(verdict.reasons.join(" ")).toContain("regime split is skipped");
    expect(verdict.headline).not.toContain("both market regimes");
  });

  it("primary horizon: the one asked for, else the best net t with enough data", () => {
    const r = report([horizon({ horizon: 1, net: [0.001, 2.5, 1200] }), horizon({ horizon: 5, net: [0.004, 3.4, 1200] }), horizon({ horizon: 63, net: [0.03, 9, 1100], independent: 17 })]);
    expect(primaryHorizon(r)?.horizon).toBe(5);
    expect(primaryHorizon(r, 1)?.horizon).toBe(1);
    expect(primaryHorizon(r, 2)?.horizon).toBe(5);
    expect(signalVerdict(r, { horizon: 63 }).label).toBe("too little data");
    expect(primaryHorizon(report([horizon({ horizon: 21, net: [0.01, 4, 10] })]))?.horizon).toBe(21);
    expect(primaryHorizon(report([]))).toBeNull();
  });
});
