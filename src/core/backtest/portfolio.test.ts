import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/core/types";
import { simulatePlan } from "@/core/screener/backtest";
import { COST_PRESETS, legCosts } from "./costs";
import { runPortfolio, sizePosition, type BacktestConfig } from "./portfolio";
import { seriesOf, type Signal, type SignalScan } from "./signals";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5);
const day = (i: number) => T0 + i * DAY;

/** Flat bars at 100 (range 99–101) for n sessions, with overrides by index. */
function flat(n: number, overrides: Record<number, Partial<DailyBar>> = {}): DailyBar[] {
  return Array.from({ length: n }, (_, i) => ({ t: day(i), o: 100, h: 101, l: 99, c: 100, v: 1000, ...overrides[i] }));
}

function scanOf(series: Record<string, DailyBar[]>, signals: Signal[]): SignalScan {
  const byDate = new Map<number, Signal[]>();
  for (const signal of signals) byDate.set(signal.date, [...(byDate.get(signal.date) ?? []), signal]);
  const dates = [...new Set(Object.values(series).flatMap((bars) => bars.map((bar) => bar.t)))].sort((a, b) => a - b);
  return {
    dates,
    firstSignalDate: dates[0],
    firstByScreen: {},
    byDate,
    series: new Map(Object.entries(series).map(([symbol, bars]) => [symbol, seriesOf(bars)])),
    benchmark: series.NIFTY ?? [],
    symbols: Object.keys(series).length,
    signals: signals.length,
  };
}

const signal = (symbol: string, index: number, extra: Partial<Signal> = {}): Signal => ({
  symbol,
  screenId: "swing-ema-pullback",
  date: day(index),
  index,
  score: 50,
  close: 100,
  entry: 100,
  stop: 95,
  target: 110,
  ...extra,
});

const base: BacktestConfig = {
  screenIds: ["swing-ema-pullback", "btst-closing-strength"],
  from: null,
  to: null,
  holdBars: null,
  capital: 100_000,
  riskPct: 1,
  maxPositions: 5,
  maxLeverage: 10,
  entry: "signal-close",
  costs: COST_PRESETS.none.model,
  lots: null,
  oosFraction: 0.3,
};

describe("position sizing", () => {
  it("sizes whole shares from the stop distance", () => {
    expect(sizePosition(1_000, 5, null)).toEqual({ qty: 200, lots: null });
    expect(sizePosition(1_000, 3, null)).toEqual({ qty: 333, lots: null });
  });

  it("sizes whole lots, and rounds to zero when one lot risks too much", () => {
    expect(sizePosition(10_000, 25, 250)).toEqual({ qty: 250, lots: 1 });
    expect(sizePosition(10_000, 10, 250)).toEqual({ qty: 1000, lots: 4 });
    expect(sizePosition(10_000, 25, 500)).toEqual({ qty: 0, lots: 0 });
  });
});

describe("portfolio simulation", () => {
  it("takes a target at the target price and books R and the equity curve", () => {
    const bars = flat(30, { 1: { h: 111, c: 108 } });
    const result = runPortfolio(scanOf({ AAA: bars }, [signal("AAA", 0)]), base);
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    // 1% of ₹1,00,000 = ₹1,000 risk / ₹5 a share = 200 shares.
    expect(trade.qty).toBe(200);
    expect(trade.exitReason).toBe("target");
    expect(trade.exitPrice).toBe(110);
    expect(trade.pnl).toBeCloseTo(2_000, 9);
    expect(trade.r).toBeCloseTo(2, 9);
    expect(trade.holdDays).toBe(1);
    expect(result.curve[0].equity).toBe(100_000);
    expect(result.curve[1].equity).toBeCloseTo(102_000, 9);
    expect(result.curve.at(-1)!.equity).toBeCloseTo(102_000, 9);
  });

  it("counts a bar touching both stop and target as the stop, and fills a gap at the open", () => {
    const both = runPortfolio(scanOf({ AAA: flat(30, { 1: { h: 112, l: 94 } }) }, [signal("AAA", 0)]), base);
    expect(both.trades[0].exitReason).toBe("stop");
    expect(both.trades[0].r).toBeCloseTo(-1, 9);
    const gap = runPortfolio(scanOf({ AAA: flat(30, { 2: { o: 92, h: 93, l: 90, c: 91 } }) }, [signal("AAA", 0)]), base);
    expect(gap.trades[0].exitPrice).toBe(92);
    expect(gap.trades[0].r).toBeCloseTo(-1.6, 9);
  });

  it("marks open positions to the close and exits at the holding horizon", () => {
    const bars = flat(30, { 3: { c: 104 }, 10: { c: 103 } });
    const result = runPortfolio(scanOf({ AAA: bars }, [signal("AAA", 0)]), base);
    expect(result.curve[3].equity).toBeCloseTo(100_000 + 200 * 4, 9);
    expect(result.trades[0].exitReason).toBe("time");
    expect(result.trades[0].exitDate).toBe(day(10)); // swing hold = 10 sessions
    expect(result.trades[0].exitPrice).toBe(103);
    const short = runPortfolio(scanOf({ AAA: bars }, [signal("AAA", 0)]), { ...base, holdBars: 3 });
    expect(short.trades[0].exitDate).toBe(day(3));
  });

  it("matches the track record's simulatePlan R with no costs", () => {
    const bars = flat(40, { 2: { h: 104, l: 97, c: 103 }, 4: { o: 104, h: 107, l: 103, c: 106 }, 6: { o: 108, h: 112, l: 107, c: 111 } });
    const sig = signal("AAA", 1, { entry: 100, stop: 96, target: 110, close: 100 });
    const result = runPortfolio(scanOf({ AAA: bars }, [sig]), base);
    const expected = simulatePlan(bars, 1, sig, 10)!;
    expect(result.trades[0].exitReason).toBe(expected.kind);
    expect(result.trades[0].r).toBeCloseTo(expected.r, 9);
  });

  it("enters at the next open by default-style next-open mode, skipping gaps past a level", () => {
    const bars = flat(30, { 1: { o: 101, h: 102, l: 100.5, c: 101 } });
    const result = runPortfolio(scanOf({ AAA: bars }, [signal("AAA", 0)]), { ...base, entry: "next-open" });
    expect(result.trades[0].entryDate).toBe(day(1));
    expect(result.trades[0].entryPrice).toBe(101);
    const gapped = runPortfolio(scanOf({ AAA: flat(30, { 1: { o: 94, l: 93 } }) }, [signal("AAA", 0)]), { ...base, entry: "next-open" });
    expect(gapped.trades).toHaveLength(0);
    expect(gapped.skipped.gapped).toBe(1);
  });

  it("holds BTST overnight: buys the signal close and sells the next open, even in next-open mode", () => {
    // The next session gaps up to 102, then falls through the stop — the trade is already out at the open.
    const bars = flat(10, { 1: { o: 102, h: 103, l: 90, c: 91 } });
    const btst = signal("AAA", 0, { screenId: "btst-closing-strength", target: null });
    const result = runPortfolio(scanOf({ AAA: bars }, [btst]), { ...base, entry: "next-open" });
    expect(result.trades[0].entryDate).toBe(day(0));
    expect(result.trades[0].entryPrice).toBe(100);
    expect(result.trades[0].exitDate).toBe(day(1));
    expect(result.trades[0].exitPrice).toBe(102);
    expect(result.trades[0].exitReason).toBe("time");
    expect(result.trades[0].r).toBeCloseTo(simulatePlan(bars, 0, btst, 1, "next-open")!.r, 9);
  });

  it("books a BTST gap below the stop at the open", () => {
    const bars = flat(10, { 1: { o: 93, h: 96, l: 92, c: 95 } });
    const btst = signal("AAA", 0, { screenId: "btst-closing-strength", target: null });
    const result = runPortfolio(scanOf({ AAA: bars }, [btst]), base);
    expect(result.trades[0].exitPrice).toBe(93);
    expect(result.trades[0].exitReason).toBe("stop");
  });

  it("drops a buy-stop that doesn't trade through the next session", () => {
    const sig = signal("AAA", 0, { entry: 102, stop: 97, target: 112 });
    const missed = runPortfolio(scanOf({ AAA: flat(30) }, [sig]), base);
    expect(missed.trades).toHaveLength(0);
    expect(missed.skipped.notTriggered).toBe(1);
    const filled = runPortfolio(scanOf({ AAA: flat(30, { 1: { o: 101, h: 103 } }) }, [sig]), base);
    expect(filled.trades[0].entryPrice).toBe(102);
  });

  it("respects max positions (best score first) and one position per stock", () => {
    const bars = flat(30);
    const signals = [
      signal("AAA", 0, { score: 10 }),
      signal("BBB", 0, { score: 90 }),
      signal("CCC", 0, { score: 50 }),
      signal("BBB", 0, { score: 80, screenId: "btst-closing-strength" }),
    ];
    const result = runPortfolio(scanOf({ AAA: bars, BBB: bars, CCC: bars }, signals), { ...base, maxPositions: 2 });
    expect(result.trades.map((t) => t.symbol).sort()).toEqual(["BBB", "CCC"]);
    expect(result.trades.find((t) => t.symbol === "BBB")!.screenId).toBe("swing-ema-pullback");
    expect(result.skipped.held).toBe(1);
    expect(result.skipped.noSlot).toBe(1);
    expect(Math.max(...result.curve.map((p) => p.open))).toBe(2);
  });

  it("interleaves several screens by their own rank, since their scores aren't comparable", () => {
    const bars = flat(30);
    const signals = [
      signal("AAA", 0, { score: 95 }),
      signal("BBB", 0, { score: 90 }),
      signal("CCC", 0, { score: 20, screenId: "btst-closing-strength" }),
    ];
    const result = runPortfolio(scanOf({ AAA: bars, BBB: bars, CCC: bars }, signals), { ...base, maxPositions: 2 });
    expect(result.trades.map((t) => t.symbol).sort()).toEqual(["AAA", "CCC"]);
  });

  it("takes a new trade once a slot frees up", () => {
    const bars = flat(30, { 1: { l: 94 } });
    const signals = [signal("AAA", 0), signal("BBB", 0, { score: 10 }), signal("BBB", 2, { score: 10 })];
    const result = runPortfolio(scanOf({ AAA: bars, BBB: flat(30) }, signals), { ...base, maxPositions: 1 });
    expect(result.trades.map((t) => `${t.symbol}@${(t.entryDate - T0) / DAY}`)).toEqual(["AAA@0", "BBB@2"]);
  });

  it("deducts charges and slippage exactly", () => {
    const costs = COST_PRESETS["futures-2026"].model;
    const result = runPortfolio(scanOf({ AAA: flat(30, { 1: { h: 111 } }) }, [signal("AAA", 0)]), { ...base, costs });
    const trade = result.trades[0];
    const entry = 100 * 1.0005;
    const exit = 110 * 0.9995;
    const charges = legCosts("buy", entry, 200, costs).total + legCosts("sell", exit, 200, costs).total;
    expect(trade.entryPrice).toBeCloseTo(entry, 9);
    expect(trade.costs).toBeCloseTo(charges, 9);
    expect(trade.pnl).toBeCloseTo((exit - entry) * 200 - charges, 9);
    expect(result.curve.at(-1)!.equity).toBeCloseTo(100_000 + trade.pnl, 9);
    expect(result.costs.total + result.costs.slippage).toBeCloseTo(charges + (0.05 + 0.055) * 200, 6);
  });

  it("splits trades into in-sample and out-of-sample by signal date", () => {
    const bars = flat(100);
    const signals = [5, 20, 40, 60, 75, 90].map((i) => signal("AAA", i, { stop: 95, target: 200 }));
    const result = runPortfolio(scanOf({ AAA: bars }, signals), { ...base, holdBars: 3, oosFraction: 0.3 });
    expect(result.split.date).toBe(day(70));
    expect(result.trades.filter((t) => t.sample === "in").map((t) => (t.signalDate - T0) / DAY)).toEqual([5, 20, 40, 60]);
    expect(result.split.outOfSample.trades.trades).toBe(2);
    expect(result.split.inSample.equity.sessions + result.split.outOfSample.equity.sessions).toBe(100);
    expect(result.warnings.some((w) => w.includes("too few"))).toBe(true);
  });

  it("closes what is still open at the end of the period", () => {
    const result = runPortfolio(scanOf({ AAA: flat(30) }, [signal("AAA", 25)]), { ...base, to: day(27) });
    expect(result.trades[0].exitReason).toBe("end");
    expect(result.trades[0].exitDate).toBe(day(27));
  });

  it("builds a NIFTY buy-and-hold curve on the same capital", () => {
    const nifty = flat(10).map((bar, i) => ({ ...bar, c: 100 + i }));
    const result = runPortfolio(scanOf({ AAA: flat(10), NIFTY: nifty }, []), { ...base, from: day(1) });
    // Base is the session before the period: NIFTY 100 → 109 at the end.
    expect(result.curve[0].bench).toBeCloseTo(101_000, 6);
    expect(result.curve.at(-1)!.bench).toBeCloseTo(109_000, 6);
    expect(result.equity.benchReturn).toBeCloseTo(0.09, 9);
  });
});
