import { describe, expect, it } from "vitest";
import type { ScreenerRow } from "@/core/screener/screens";
import { buildPlan, DEFAULT_PLAN_SETTINGS, type PlanInput } from "./builder";
import { bucketOf, type EvidenceBucket, type EvidenceTrade, type ScreenEvidence } from "./evidence";
import { excludedScreens, lakhs, sizeHint } from "./explain";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

const passing: EvidenceBucket = {
  n: 500,
  days: 300,
  mean: 0.07,
  t: 5,
  first: { n: 300, mean: 0.09 },
  last: { n: 200, mean: 0.04 },
  splitDate: 0,
  recent: { n: 100, mean: 0.01 },
  costR: 0.05,
  score: null,
  eligible: true,
};
const btst: ScreenEvidence = { screenId: "btst-20d-high", all: passing, up: passing, down: { ...passing, eligible: false }, verdict: "uptrend" };
const row = (symbol: string, entry: number, stop: number): ScreenerRow =>
  ({ symbol, name: symbol, industry: "", date: 0, live: true, close: entry, changePct: 1, volRatio: 2, deliveryPct: null, rsi14: 60, rsRank: 80, score: 50, tags: [], plan: { entry, stop, target: null, exit: "" } }) as ScreenerRow;
const input = (patch: Partial<PlanInput> = {}): PlanInput => ({
  results: {},
  evidence: { "btst-20d-high": btst },
  state: "up",
  banned: new Set(),
  open: [],
  lots: { TORNTPHARM: 125, HDFCBANK: 550 },
  settings: DEFAULT_PLAN_SETTINGS,
  ...patch,
});

describe("lakhs", () => {
  it("says ₹ the way traders do", () => {
    expect(lakhs(900_000)).toBe("₹9L");
    expect(lakhs(1_150_000)).toBe("₹11.5L");
    expect(lakhs(12_000_000)).toBe("₹1.2Cr");
  });
});

describe("sizeHint", () => {
  // 26 Nov 2026, 10:30: the plan's only match, TORNTPHARM, one lot of 125 losing ₹8,925 at its stop.
  const plan = buildPlan(input({ results: { "btst-20d-high": [row("TORNTPHARM", 4983.3, 4911.9), row("HDFCBANK", 1000, 979.2)] } }));

  it("names the match that needs the least change and the capital or risk % that fits one lot", () => {
    expect(plan.ideas).toEqual([]);
    expect(plan.unsized.map((idea) => idea.symbol)).toEqual(["HDFCBANK", "TORNTPHARM"]);
    const hint = sizeHint(plan, DEFAULT_PLAN_SETTINGS)!;
    expect(hint.symbol).toBe("TORNTPHARM");
    expect(hint.oneLotRisk).toBeCloseTo(8925);
    expect(hint.capital).toBe(900_000); // ₹8,925 ÷ 1% = ₹8.93L, rounded up to ₹10,000
    expect(hint.riskPct).toBe(1.8); // ₹8,925 ÷ ₹5L = 1.785%
  });

  it("is right: the suggested capital or risk sizes the match at one lot", () => {
    const hint = sizeHint(plan, DEFAULT_PLAN_SETTINGS)!;
    const results = { "btst-20d-high": [row("TORNTPHARM", 4983.3, 4911.9)] };
    expect(buildPlan(input({ results, settings: { ...DEFAULT_PLAN_SETTINGS, capital: hint.capital } })).ideas[0]?.size.lots).toBe(1);
    expect(buildPlan(input({ results, settings: { ...DEFAULT_PLAN_SETTINGS, riskPct: hint.riskPct! } })).ideas[0]?.size.lots).toBe(1);
    expect(buildPlan(input({ results, settings: { ...DEFAULT_PLAN_SETTINGS, capital: hint.capital - 10_000 } })).ideas).toEqual([]);
  });

  it("needs capital, not risk, when the leverage cap is what stops it; nothing over the 5% risk cap", () => {
    const results = { "btst-20d-high": [row("TORNTPHARM", 4983.3, 4911.9)] };
    const settings = { ...DEFAULT_PLAN_SETTINGS, capital: 100_000, maxLeverage: 2 };
    const hint = sizeHint(buildPlan(input({ results, settings })), settings)!;
    expect(hint.riskPct).toBeNull(); // 8.9% of ₹1L, and one lot (₹6.2L) is over ₹1L × 2
    expect(hint.capital).toBe(900_000);
    const tight = { ...DEFAULT_PLAN_SETTINGS, riskPct: 2, maxLeverage: 1 };
    const levered = sizeHint(buildPlan(input({ results, settings: tight })), tight)!;
    expect(levered.capital).toBe(630_000); // 2% risk fits, but one lot is ₹6.23L of notional at 1×
    expect(levered.riskPct).toBeNull();
  });

  it("counts open trades against the leverage room", () => {
    const results = { "btst-20d-high": [row("TORNTPHARM", 4983.3, 4911.9)] };
    const settings = { ...DEFAULT_PLAN_SETTINGS, maxLeverage: 1 };
    const plan = buildPlan(input({ results, settings, open: [{ symbol: "XYZ", notional: 400_000 }] }));
    expect(plan.openNotional).toBe(400_000);
    expect(sizeHint(plan, settings)!.capital).toBe(1_030_000);
  });

  it("is null when nothing is unsized", () => {
    expect(sizeHint(buildPlan(input()), DEFAULT_PLAN_SETTINGS)).toBeNull();
  });
});

describe("excludedScreens", () => {
  const trades = (means: number[]): EvidenceTrade[] =>
    means.flatMap((netR, day) => [0, 1].map((k) => ({ screenId: "x", symbol: `S${k}`, date: T0 + day * DAY, score: 0, state: "up" as const, entry: 100, exit: 100, kind: "open" as const, netR, grossR: netR })));
  const evidence = (id: string, netRs: number[]): ScreenEvidence => {
    const bucket = bucketOf(trades(netRs), T0 + 80 * DAY);
    return { screenId: id, all: bucket, up: bucket, down: bucket, verdict: bucket.eligible ? "any" : "none" };
  };
  const noisy = Array.from({ length: 100 }, (_, i) => (i % 2 ? 1.1 : -1));

  it("gives each left-out screen its reason under the evidence rule", () => {
    const screens = {
      "pos-trend-template": evidence("pos-trend-template", [...Array(50).fill(0.8), ...Array(50).fill(-0.6)]),
      "swing-nr7": evidence("swing-nr7", Array(100).fill(-0.3)),
      "res-gap-up": evidence("res-gap-up", [...Array(60).fill(-0.2), ...Array(40).fill(0.3)]),
      "swing-delivery": evidence("swing-delivery", Array(10).fill(0.5)),
      "swing-rsi2": evidence("swing-rsi2", noisy),
      "btst-closing-strength": evidence("btst-closing-strength", Array(100).fill(0.2)),
    };
    const out = excludedScreens(screens, "up", ["btst-closing-strength"]);
    expect(out.map((entry) => [entry.id, entry.reason])).toEqual([
      ["pos-trend-template", "lost-lately"],
      ["swing-rsi2", "noisy"],
      ["res-gap-up", "lost-early"],
      ["swing-delivery", "few"],
      ["swing-nr7", "lost"],
    ]);
    expect(out[0].last).toBeLessThan(0);
    expect(out[0].first).toBeGreaterThan(0);
  });

  it("with no market state, a screen that passes in one state only is out for that", () => {
    const good = evidence("btst-closing-strength", Array(100).fill(0.2));
    const screens = { "btst-closing-strength": { ...good, down: { ...good.down, eligible: false } } };
    expect(excludedScreens(screens, null, []).map((entry) => entry.reason)).toEqual(["one-state"]);
    expect(excludedScreens({}, "up", [])).toEqual([]);
  });
});
