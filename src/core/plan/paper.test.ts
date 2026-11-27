import { describe, expect, it } from "vitest";
import { COST_PRESETS } from "@/core/backtest/costs";
import { simulatePlan } from "@/core/screener/backtest";
import type { DailyBar } from "@/core/types";
import { gradePaper, paperCosts, paperCsv, summarizePaper, type PaperOrder, type PaperTradeRow } from "./paper";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
const COSTS = COST_PRESETS["futures-2026"].model;
const NONE = COST_PRESETS.none.model;

/** Bars from OHLC tuples, one per day from T0. */
const bars = (rows: Array<[number, number, number, number]>): DailyBar[] => rows.map(([o, h, l, c], i) => ({ t: T0 + i * DAY, o, h, l, c, v: 1000 }));
const order = (patch: Partial<PaperOrder> = {}): PaperOrder => ({ symbol: "S", screenId: "swing-x", entryKind: "close", plannedEntry: 100, stop: 95, target: 110, exitRule: "stop-target", holdSessions: 5, signalDay: T0, quantity: 100, ...patch });

describe("paper fills and exits", () => {
  it("buys a close entry at the signal close and stops out at the stop", () => {
    const series = bars([[99, 101, 98, 100], [100, 102, 96, 101], [100, 101, 94, 95.5]]);
    const grade = gradePaper(order(), series, series.at(-1)!.t, NONE);
    expect(grade).toMatchObject({ status: "closed", entryPrice: 100, exitPrice: 95, exitReason: "stop", gap: false, sessions: 2, grossR: -1 });
  });

  it("fills a gap down through the stop at the open, below the stop", () => {
    const series = bars([[99, 101, 98, 100], [91, 92, 90, 91.5]]);
    const grade = gradePaper(order(), series, series.at(-1)!.t, NONE);
    expect(grade).toMatchObject({ status: "closed", exitPrice: 91, exitReason: "stop", gap: true });
    expect(grade.grossR).toBeCloseTo(-1.8, 10);
  });

  it("takes a gap up through the target at the open", () => {
    const series = bars([[99, 101, 98, 100], [112, 115, 111, 114]]);
    expect(gradePaper(order(), series, series.at(-1)!.t, NONE)).toMatchObject({ exitPrice: 112, exitReason: "target", gap: true, grossR: 2.4 });
  });

  it("counts a session touching both the stop and the target as the stop", () => {
    const series = bars([[99, 101, 98, 100], [100, 111, 94, 105]]);
    expect(gradePaper(order(), series, series.at(-1)!.t, NONE)).toMatchObject({ exitReason: "stop", exitPrice: 95 });
  });

  it("exits at the close after the holding period", () => {
    const series = bars([[99, 101, 98, 100], [100, 102, 99, 101], [101, 103, 100, 102], [102, 104, 101, 103]]);
    const grade = gradePaper(order({ holdSessions: 3 }), series, series.at(-1)!.t, NONE);
    expect(grade).toMatchObject({ status: "closed", exitReason: "time", exitPrice: 103, sessions: 3 });
  });

  it("fills a buy-stop only if the next session trades through it", () => {
    const missed = bars([[99, 101, 98, 100], [100, 101.5, 99, 101]]);
    expect(gradePaper(order({ entryKind: "buy-stop", plannedEntry: 102, stop: 97 }), missed, missed.at(-1)!.t, NONE)).toMatchObject({ status: "unfilled" });
    // Waiting for the next session.
    expect(gradePaper(order({ entryKind: "buy-stop", plannedEntry: 102, stop: 97 }), missed, T0, NONE)).toMatchObject({ status: "pending" });
    // Traded through: filled at the stop level; opened above it: at the open.
    const through = bars([[99, 101, 98, 100], [100, 103, 99, 102.5]]);
    expect(gradePaper(order({ entryKind: "buy-stop", plannedEntry: 102, stop: 97 }), through, through.at(-1)!.t, NONE)).toMatchObject({ status: "open", entryPrice: 102, entryDay: T0 + DAY });
    const gapped = bars([[99, 101, 98, 100], [104, 106, 103, 105]]);
    expect(gradePaper(order({ entryKind: "buy-stop", plannedEntry: 102, stop: 97 }), gapped, gapped.at(-1)!.t, NONE)).toMatchObject({ status: "open", entryPrice: 104 });
  });

  it("stops a buy-stop at the stop level on its fill session (the open came before the fill)", () => {
    const series = bars([[99, 101, 98, 100], [96, 102.5, 95, 96]]);
    expect(gradePaper(order({ entryKind: "buy-stop", plannedEntry: 102, stop: 97 }), series, series.at(-1)!.t, NONE)).toMatchObject({ exitReason: "stop", exitPrice: 97, gap: false });
  });

  it("sells a BTST at the next open, and a gap below the stop is the stop at that open", () => {
    const btst = order({ entryKind: "btst", exitRule: "next-open", holdSessions: 1 });
    const fine = bars([[99, 101, 98, 100], [101.5, 103, 100, 102]]);
    expect(gradePaper(btst, fine, T0, NONE)).toMatchObject({ status: "open", entryPrice: 100 });
    expect(gradePaper(btst, fine, fine.at(-1)!.t, NONE)).toMatchObject({ status: "closed", exitReason: "open", exitPrice: 101.5 });
    const gap = bars([[99, 101, 98, 100], [93, 96, 92, 95]]);
    expect(gradePaper(btst, gap, gap.at(-1)!.t, NONE)).toMatchObject({ exitReason: "stop", exitPrice: 93, gap: true });
  });

  it("exits a trailing rule on a close below the low of the sessions before", () => {
    const series = bars([[99, 101, 98, 100], [100, 103, 99.5, 102], [102, 104, 101, 103], [103, 103.5, 99, 99.2]]);
    const grade = gradePaper(order({ exitRule: "trail-low:2", target: null, holdSessions: 25 }), series, series.at(-1)!.t, NONE);
    expect(grade).toMatchObject({ exitReason: "trail", exitPrice: 99.2 });
  });

  it("charges slippage and costs from costs.ts on both legs", () => {
    const series = bars([[99, 101, 98, 100], [112, 115, 111, 114]]);
    const grade = gradePaper(order(), series, series.at(-1)!.t, COSTS);
    const expected = paperCosts(order(), 100, 112, COSTS);
    expect(grade.pnl).toBeCloseTo(expected.pnl, 8);
    expect(grade.netR).toBeLessThan(grade.grossR!);
    expect(grade.charges).toBeGreaterThan(0);
  });

  it("is taken on a later day than the one graded", () => {
    expect(gradePaper(order({ signalDay: T0 + 5 * DAY }), bars([[1, 1, 1, 1]]), T0, NONE).status).toBe("later");
  });
});

describe("paper grading has no look-ahead", () => {
  it("grading on day d reads only bars up to d: rewriting every later bar changes nothing", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const walk = Array.from({ length: 60 }, (_, i) => {
      const o = 100 + Math.sin(i / 3) * 6 + rand() * 2;
      const c = o + (rand() - 0.5) * 4;
      return { t: T0 + i * DAY, o, h: Math.max(o, c) + rand() * 2, l: Math.min(o, c) - rand() * 2, c, v: 1 };
    });
    const kinds: PaperOrder[] = [order({ target: 108, stop: 96 }), order({ entryKind: "buy-stop", plannedEntry: 101, stop: 96 }), order({ entryKind: "btst", exitRule: "next-open", holdSessions: 1 }), order({ exitRule: "trail-low:3", target: null, holdSessions: 25 })];
    for (const base of kinds) {
      for (let signal = 0; signal < 30; signal += 3) {
        const trade = { ...base, signalDay: T0 + signal * DAY, plannedEntry: base.entryKind === "close" || base.entryKind === "btst" ? walk[signal].c : walk[signal].c * 1.01, stop: walk[signal].c * 0.96 };
        for (let d = signal; d < 50; d += 1) {
          const day = T0 + d * DAY;
          const future = walk.map((bar) => (bar.t > day ? { ...bar, o: bar.o * 3, h: bar.h * 3, l: bar.l * 0.1, c: bar.c * 0.2 } : bar));
          expect(gradePaper(trade, future, day, COSTS)).toEqual(gradePaper(trade, walk, day, COSTS));
          expect(gradePaper(trade, walk.filter((bar) => bar.t <= day), day, COSTS)).toEqual(gradePaper(trade, walk, day, COSTS));
        }
      }
    }
  });

  it("closes each trade exactly as the evidence's replay (simulatePlan) does", () => {
    let seed = 99;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    let close = 500;
    const walk = Array.from({ length: 400 }, (_, i) => {
      const o = close * (1 + (rand() - 0.5) * 0.03);
      const c = o * (1 + (rand() - 0.5) * 0.05);
      close = c;
      return { t: T0 + i * DAY, o, h: Math.max(o, c) * (1 + rand() * 0.02), l: Math.min(o, c) * (1 - rand() * 0.02), c, v: 1 };
    });
    let compared = 0;
    for (let i = 0; i < 360; i += 1) {
      const c = walk[i].c;
      for (const [kind, entry, hold, exit] of [["close", c, 10, undefined], ["buy-stop", c * 1.01, 10, undefined], ["btst", c, 1, "next-open"]] as const) {
        const plan = { entry, stop: c * 0.95, target: c * 1.08 };
        const want = simulatePlan(walk, i, plan, hold, exit);
        const grade = gradePaper(order({ entryKind: kind, plannedEntry: entry, stop: plan.stop, target: plan.target, holdSessions: hold, exitRule: exit ?? "stop-target", signalDay: walk[i].t }), walk, walk.at(-1)!.t, NONE);
        if (!want) {
          expect(grade.status).toBe("unfilled");
          continue;
        }
        expect(grade.status).toBe("closed");
        // simulatePlan's R is on the fill's own risk; compare the exit price.
        const fill = grade.entryPrice!;
        expect(grade.exitPrice!).toBeCloseTo(fill + want.r * (fill - plan.stop), 8);
        expect(want.kind === "open" ? ["time", "open"] : [want.kind]).toContain(grade.exitReason);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(900);
  });
});

describe("the paper session's summary", () => {
  const row = (id: string, signal: number, exit: number, pnl: number, netR: number, expectedR: number | null = 0.2): PaperTradeRow => ({
    ...order({ symbol: id, signalDay: T0 + signal * DAY }),
    id,
    expectedR,
    grade: { status: "closed", entryPrice: 100, entryDay: T0 + signal * DAY, exitPrice: 100, exitDay: T0 + exit * DAY, exitReason: netR > 0 ? "target" : "stop", gap: false, sessions: exit - signal, mark: null, grossR: netR, netR, pnl, charges: 50, text: "" },
  });

  it("counts trades, hit rate, net R, ₹ P&L and the drawdown in exit order", () => {
    const open: PaperTradeRow = { ...row("OPEN", 6, 7, 0, 0), grade: { ...row("OPEN", 6, 7, 0, 0).grade, status: "open", exitDay: null, pnl: 300, netR: null } };
    const later: PaperTradeRow = { ...row("LATER", 9, 9, 0, 0), grade: { ...row("LATER", 9, 9, 0, 0).grade, status: "later" } };
    const summary = summarizePaper([row("A", 0, 2, 1000, 1), row("B", 1, 3, -1500, -1.5), row("C", 2, 4, -500, -0.5), row("D", 3, 5, 2500, 2.5), open, later]);
    expect(summary).toMatchObject({ taken: 5, closed: 4, open: 1, wins: 2, hitRate: 0.5, netR: 1.5, avgNetR: 0.375, pnl: 1500, charges: 200, maxDrawdown: 2000, maxDrawdownR: 2, openPnl: 300 });
    expect(summary.expectedR).toBeCloseTo(0.8, 10);
    expect(summary.byReason).toEqual({ target: 2, stop: 2 });
  });

  it("exports one CSV row per trade", () => {
    const csv = paperCsv([row("B,1", 1, 3, -1500, -1.5), row("A", 0, 2, 1000, 1)]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toMatch(/^symbol,setup,taken/);
    expect(lines[1]).toMatch(/^A,/);
    expect(lines[2]).toMatch(/^"B,1",/);
    expect(lines).toHaveLength(3);
  });
});
