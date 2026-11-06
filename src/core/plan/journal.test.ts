import { describe, expect, it } from "vitest";
import { COST_PRESETS } from "@/core/backtest/costs";
import { journalSummary, netRealisedR, plannedExitPrice, realisedR, slippageR, type ClosedTrade } from "./journal";

const trade = (patch: Partial<ClosedTrade> = {}): ClosedTrade => ({ screenId: "res-drift", plannedEntry: 100, stop: 95, entryPrice: 100.5, exitPrice: 110, plannedExit: 110, quantity: 500, ...patch });

describe("trade journal", () => {
  it("measures R on the planned risk and slippage against the plan", () => {
    expect(realisedR(trade())).toBeCloseTo(1.9, 6);
    expect(slippageR(trade({ exitPrice: 109 }))).toEqual({ entry: 0.1, exit: 0.2 });
    expect(slippageR(trade({ plannedExit: null })).exit).toBeNull();
  });

  it("takes charges (not slippage again) out of the net R", () => {
    const costs = COST_PRESETS["futures-2026"].model;
    const net = netRealisedR(trade(), costs);
    expect(net).toBeLessThan(1.9);
    expect(net).toBeGreaterThan(1.8);
  });

  it("summarises closed trades", () => {
    const summary = journalSummary([trade(), trade({ exitPrice: 95, plannedExit: 95, screenId: "btst-closing-strength" })], COST_PRESETS.none.model);
    expect(summary.trades).toBe(2);
    expect(summary.wins).toBe(1);
    expect(summary.avgR).toBeCloseTo((1.9 - 1.1) / 2, 6);
    expect(summary.entrySlipR).toBeCloseTo(0.1, 6);
    expect(summary.exitSlipR).toBeCloseTo(0, 6);
    expect(summary.byScreen["res-drift"]).toMatchObject({ trades: 1, wins: 1 });
    expect(summary.pnl).toBeCloseTo(500 * 9.5 - 500 * 5.5, 6);
  });

  it("knows the plan's exit price for each reason", () => {
    const plan = { stop: 95, target: 110 };
    expect(plannedExitPrice("stop", plan, null)).toBe(95);
    expect(plannedExitPrice("target", plan, null)).toBe(110);
    expect(plannedExitPrice("open", plan, { o: 101, c: 102 })).toBe(101);
    expect(plannedExitPrice("time", plan, { o: 101, c: 102 })).toBe(102);
    expect(plannedExitPrice("time", plan, null)).toBeNull();
    expect(plannedExitPrice("manual", plan, { o: 101, c: 102 })).toBeNull();
  });
});
