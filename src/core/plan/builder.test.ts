import { describe, expect, it } from "vitest";
import type { ScreenerRow } from "@/core/screener/screens";
import type { RiskModel } from "@/core/risk/model";
import { DEFAULT_CORRELATION_SETTINGS, type BookEntry } from "@/core/risk/sizing";
import { buildPlan, DEFAULT_PLAN_SETTINGS, type PlanCorrelation, type PlanInput } from "./builder";
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

  it("drops a match whose plan no longer holds at the live price, and the next one takes its slot", () => {
    const rows = ["AAA", "BBB", "CCC"].map((symbol) => row(symbol, 100, 95));
    const settings = { ...DEFAULT_PLAN_SETTINGS, maxOpen: 2 };
    const plan = buildPlan(input({ results: { "res-drift": rows }, settings, prices: { AAA: 94, BBB: 103 } }));
    expect(plan.ideas.map((idea) => idea.symbol)).toEqual(["CCC"]);
    expect(plan.invalid.map((idea) => [idea.symbol, idea.status.kind])).toEqual([
      ["AAA", "stop-broken"],
      ["BBB", "moved"],
    ]);
    // No live price: checked at the scan close, so nothing changes.
    expect(buildPlan(input({ results: { "res-drift": rows }, settings })).ideas.map((idea) => idea.symbol)).toEqual(["AAA", "BBB"]);
  });

  it("keeps a buy-stop below its trigger but drops one the price has fallen far below (the PAYTM case)", () => {
    // Buy-stop 1,962 over a 1,909 scan close, ATR 63: 0.84 ATR to the trigger is a tested next-session order.
    const paytm = row("AAA", 1962, 1805, { close: 1909, facts: { atr14: 63 } as ScreenerRow["facts"] });
    const lots = { AAA: 10 };
    expect(buildPlan(input({ results: { "res-drift": [paytm] }, lots, prices: { AAA: 1904 } })).ideas.map((idea) => idea.symbol)).toEqual(["AAA"]);
    // At 1,860 the trigger is 1.6 ATR away: it won't fill next session.
    const far = buildPlan(input({ results: { "res-drift": [paytm] }, lots, prices: { AAA: 1860 } }));
    expect(far.ideas).toHaveLength(0);
    expect(far.invalid[0].status.kind).toBe("far");
    // Below the stop: invalid.
    expect(buildPlan(input({ results: { "res-drift": [paytm] }, lots, prices: { AAA: 1800 } })).invalid[0].status.kind).toBe("stop-broken");
  });

  it("uses another eligible match of the same stock when the best one's plan has gone stale", () => {
    const plan = buildPlan(
      input({
        results: { "pos-turtle-adx": [row("AAA", 110, 95, { close: 100, facts: { atr14: 2 } as ScreenerRow["facts"] })], "res-drift": [row("AAA", 100, 95)] },
        prices: { AAA: 100 },
      }),
    );
    expect(plan.ideas.map((idea) => idea.screenId)).toEqual(["res-drift"]);
    expect(plan.invalid).toHaveLength(0);
  });

  describe("correlation-aware sizing (#40)", () => {
    const bank = (symbol: string, stop = 95) => row(symbol, 100, stop, { industry: "Financial Services" });
    const it_ = (symbol: string) => row(symbol, 100, 95, { industry: "Information Technology" });
    const RHO: Record<string, number> = { "AAA:BBB": 0.82, "AAA:CCC": 0.8, "BBB:CCC": 0.8, "AAA:HDF": 0.82, "BBB:HDF": 0.8, "CCC:HDF": 0.8 };
    const symbols = ["AAA", "BBB", "CCC", "DDD", "HDF"];
    const corr = symbols.map((a) => symbols.map((b) => (a === b ? 1 : (RHO[`${a}:${b}`] ?? RHO[`${b}:${a}`] ?? 0.1))));
    const model: RiskModel = { symbols, index: Object.fromEntries(symbols.map((s, i) => [s, i])), from: 0, to: 0, sessions: 120, cov: corr, corr, vol: {}, beta: {}, shrinkage: 0, meanCorrelation: 0, returns: {}, excluded: [] };
    const correlation = (open: BookEntry[] = []): PlanCorrelation => ({ ...DEFAULT_CORRELATION_SETTINGS, model, open });
    const results = { "res-drift": [bank("AAA"), bank("BBB"), bank("CCC"), it_("DDD")] };
    const lotsOf = (plan: ReturnType<typeof buildPlan>) => plan.ideas.map((idea) => [idea.symbol, idea.size.lots]);

    it("changes nothing when it is off", () => {
      const off = buildPlan(input({ results }));
      expect(lotsOf(off)).toEqual([
        ["AAA", 10],
        ["BBB", 10],
        ["CCC", 10],
        ["DDD", 10],
      ]);
      expect(off.correlated).toEqual([]);
      expect(off.ideas.some((idea) => idea.correlation)).toBe(false);
      // Same plan with the model given but nothing correlated (every ρ 0.1, no shared industry).
      const unrelated = buildPlan(input({ results: { "res-drift": ["AAA", "BBB", "CCC", "DDD"].map((s, i) => row(s, 100, 95, { industry: `I${i}` })) }, correlation: { ...correlation(), model: { ...model, corr: model.corr.map((r) => r.map((v) => (v === 1 ? 1 : 0.1))) } } }));
      expect(lotsOf(unrelated)).toEqual(lotsOf(off));
    });

    it("cuts or skips ideas that move with an open trade and the ideas above them", () => {
      const plan = buildPlan(input({ results, correlation: correlation([{ symbol: "HDF", industry: "Financial Services", kind: "open", risk: 7_500 }]) }));
      // Open HDF at 1.5 R (₹7,500), budget 2 R (₹10,000): AAA (ρ 0.82) may risk x ≤ −0.82·7500 + √((0.82·7500)² + 10000² − 7500²), in ₹500 lots.
      const maxX = -0.82 * 7_500 + Math.sqrt((0.82 * 7_500) ** 2 + 10_000 ** 2 - 7_500 ** 2);
      expect(plan.ideas[0]).toMatchObject({ symbol: "AAA", size: { lots: Math.floor(maxX / 500), risk: Math.floor(maxX / 500) * 500 } });
      expect(plan.ideas[0].correlation?.text).toBe(`${Math.floor(maxX / 500)} lots instead of 10: 0.82 correlated with your open HDF`);
      // BBB and CCC: the bank cluster is full; skipped, without taking a slot. DDD (IT) untouched.
      expect(plan.correlated.map((idea) => idea.symbol)).toEqual(["BBB", "CCC"]);
      expect(plan.correlated[0].size.lots).toBe(10);
      expect(plan.correlated[0].correlation?.text).toMatch(/^Skipped: 0\.82 correlated with the plan's AAA and 1 more/);
      expect(lotsOf(plan).at(-1)).toEqual(["DDD", 10]);
      expect(plan.ideas.at(-1)?.correlation).toBeUndefined();
    });

    it("lets the next idea take a skipped idea's slot", () => {
      const plan = buildPlan(input({ results, settings: { ...DEFAULT_PLAN_SETTINGS, maxOpen: 2 }, correlation: correlation() }));
      // AAA full, BBB at ρ 0.82 still fits (√3.64 R ≤ 2 R), CCC would be the third: but only 2 slots.
      expect(plan.ideas.map((idea) => idea.symbol)).toEqual(["AAA", "BBB"]);
      // A third bank gets what is left of the budget: ≈ 0.11 R = one ₹500 lot.
      const three = buildPlan(input({ results, settings: { ...DEFAULT_PLAN_SETTINGS, maxOpen: 3 }, correlation: correlation() }));
      expect(lotsOf(three)).toEqual([
        ["AAA", 10],
        ["BBB", 10],
        ["CCC", 1],
      ]);
      expect(three.ideas[2].correlation?.text).toBe("1 lot instead of 10: 0.80 correlated with the plan's AAA and 1 more");
      // With ₹1,000 lots nothing fits: CCC is set aside and DDD takes the slot.
      const wide = { "res-drift": [bank("AAA"), bank("BBB"), bank("CCC", 90), it_("DDD")] };
      const tight = buildPlan(input({ results: wide, settings: { ...DEFAULT_PLAN_SETTINGS, maxOpen: 3 }, correlation: correlation() }));
      expect(tight.ideas.map((idea) => idea.symbol)).toEqual(["AAA", "BBB", "DDD"]);
      expect(tight.correlated.map((idea) => idea.symbol)).toEqual(["CCC"]);
    });
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
