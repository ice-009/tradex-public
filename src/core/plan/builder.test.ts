import { describe, expect, it } from "vitest";
import type { ScreenerRow } from "@/core/screener/screens";
import { buildPlan, DEFAULT_PLAN_SETTINGS, type PlanInput } from "./builder";
import type { EvidenceBucket, ScreenEvidence } from "./evidence";
import { entryKind, entryText, exitRuleFor, exitText } from "./instructions";

const bucket = (mean: number, eligible: boolean, ranks = false): EvidenceBucket => ({
  n: 500,
  days: 300,
  mean,
  t: eligible ? 4 : 0.5,
  first: { n: 300, mean },
  last: { n: 200, mean },
  splitDate: 0,
  recent: { n: 100, mean: mean / 2 },
  costR: 0.05,
  score: { top: 0.3, mid: 0.2, bottom: 0.1, t: ranks ? 3 : 0.5, ranks },
  eligible,
});
const evidence = (id: string, up: [number, boolean], down: [number, boolean], ranks = false): ScreenEvidence => ({
  screenId: id,
  all: bucket(up[0], up[1] && down[1], ranks),
  up: bucket(up[0], up[1], ranks),
  down: bucket(down[0], down[1], ranks),
  verdict: up[1] && down[1] ? "any" : up[1] ? "uptrend" : "none",
});
const row = (symbol: string, entry: number, stop: number, extra: Partial<ScreenerRow> = {}): ScreenerRow =>
  ({ symbol, name: symbol, industry: "", date: 0, live: true, close: entry, changePct: 1, volRatio: 2, deliveryPct: null, rsi14: 60, rsRank: 80, score: 50, tags: [], plan: { entry, stop, target: null, exit: "" }, ...extra }) as ScreenerRow;

const EVIDENCE = {
  "pos-turtle-adx": evidence("pos-turtle-adx", [0.33, true], [-0.12, false], true),
  "btst-closing-strength": evidence("btst-closing-strength", [0.08, true], [0.04, true]),
  "res-drift": evidence("res-drift", [0.2, true], [0.08, true]),
  "swing-nr7": evidence("swing-nr7", [-0.25, false], [-0.3, false]),
};

const input = (patch: Partial<PlanInput> = {}): PlanInput => ({
  results: {},
  evidence: EVIDENCE,
  state: "up",
  banned: new Set(),
  open: [],
  lots: { AAA: 100, BBB: 100, CCC: 100, DDD: 100, EEE: 100, FFF: 100, GGG: 100 },
  settings: DEFAULT_PLAN_SETTINGS,
  ...patch,
});

describe("daily plan", () => {
  it("takes only screens eligible in the market state, ranked by expected R", () => {
    const plan = buildPlan(
      input({
        results: {
          "swing-nr7": [row("AAA", 100, 98)],
          "btst-closing-strength": [row("BBB", 100, 98)],
          "pos-turtle-adx": [row("CCC", 100, 95)],
        },
      }),
    );
    expect(plan.ideas.map((idea) => idea.symbol)).toEqual(["CCC", "BBB"]);
    expect(plan.eligible).not.toContain("swing-nr7");

    const down = buildPlan(input({ state: "down", results: { "btst-closing-strength": [row("BBB", 100, 98)], "pos-turtle-adx": [row("CCC", 100, 95)] } }));
    expect(down.ideas.map((idea) => idea.symbol)).toEqual(["BBB"]);
  });

  it("makes one idea per stock from its best eligible match", () => {
    const plan = buildPlan(input({ results: { "btst-closing-strength": [row("AAA", 100, 98)], "pos-turtle-adx": [row("AAA", 100, 95)] } }));
    expect(plan.ideas).toHaveLength(1);
    expect(plan.ideas[0].screenId).toBe("pos-turtle-adx");
    expect(plan.ideas[0].alsoMatched).toEqual(["btst-closing-strength"]);
  });

  it("breaks ties by score only where the score ranks trades", () => {
    const rows = [row("AAA", 100, 95, { score: 10 }), row("BBB", 100, 95, { score: 90 })];
    expect(buildPlan(input({ results: { "pos-turtle-adx": rows } })).ideas.map((idea) => idea.symbol)).toEqual(["BBB", "AAA"]);
    expect(buildPlan(input({ results: { "res-drift": rows } })).ideas.map((idea) => idea.symbol)).toEqual(["AAA", "BBB"]);
  });

  it("leaves out banned and held stocks and stocks without futures", () => {
    const plan = buildPlan(
      input({
        results: { "res-drift": [row("AAA", 100, 95), row("BBB", 100, 95), row("CCC", 100, 95), row("ZZZ", 100, 95)] },
        banned: new Set(["AAA"]),
        open: [{ symbol: "BBB", notional: 100_000 }],
      }),
    );
    expect(plan.ideas.map((idea) => idea.symbol)).toEqual(["CCC"]);
    expect(plan.skipped).toEqual({ banned: ["AAA"], held: ["BBB"], noLot: ["ZZZ"] });
    expect(plan.freeSlots).toBe(4);
  });

  it("sizes in whole lots from the risk budget and shows ideas too big for it", () => {
    // ₹5,000 budget: risk 5 × 100 = ₹500 a lot → 10 lots, but 4× leverage on ₹5 lakh caps notional at ₹20 lakh = 200 lots of ₹100.
    const plan = buildPlan(input({ results: { "res-drift": [row("AAA", 100, 95), row("BBB", 1000, 900)] } }));
    expect(plan.ideas).toHaveLength(1);
    expect(plan.ideas[0].symbol).toBe("AAA");
    expect(plan.ideas[0].size).toMatchObject({ status: "ok", lots: 10, qty: 1000, risk: 5000 });
    expect(plan.unsized.map((idea) => idea.symbol)).toEqual(["BBB"]);
    expect(plan.unsized[0].size).toMatchObject({ status: "too-big", lots: 0, oneLotRisk: 10_000 });
  });

  it("respects the leverage cap", () => {
    const plan = buildPlan(input({ results: { "res-drift": [row("AAA", 1000, 999)] }, open: [{ symbol: "XXX", notional: 1_950_000 }] }));
    // Budget allows 50 lots, but only ₹50,000 of room is left: 0 lots of ₹1 lakh.
    expect(plan.ideas).toHaveLength(0);
    expect(plan.unsized[0].size.status).toBe("no-room");
  });

  it("fills only the free slots and keeps the rest aside", () => {
    const rows = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"].map((symbol) => row(symbol, 100, 99));
    const plan = buildPlan(input({ results: { "res-drift": rows }, settings: { ...DEFAULT_PLAN_SETTINGS, maxOpen: 3 } }));
    expect(plan.ideas.map((idea) => idea.symbol)).toEqual(["AAA", "BBB", "CCC"]);
    expect(plan.more.map((idea) => idea.symbol)).toEqual(["DDD", "EEE", "FFF", "GGG"]);
  });

  it("writes plain entry and exit instructions", () => {
    expect(entryText(entryKind({ exit: "next-open" }, { entry: 100, stop: 98 }, 100), 100)).toBe("Buy 3:15–3:25 PM near ₹100.00, sell at tomorrow's open");
    expect(entryText(entryKind({}, { entry: 105, stop: 98 }, 100), 105)).toBe("Buy-stop at ₹105.00 next session");
    expect(entryText(entryKind({}, { entry: 100, stop: 98 }, 100), 100)).toBe("Buy 3:15–3:25 PM near ₹100.00");
    expect(exitRuleFor({ id: "pos-turtle-adx" }, { target: null })).toBe("trail-low:10");
    expect(exitRuleFor({ id: "res-drift" }, { target: 110 })).toBe("stop-target");
    expect(exitText("trail-low:10", { stop: 95, target: null }, 25)).toMatch(/close below the 10-day low.*25 sessions/);
  });
});
