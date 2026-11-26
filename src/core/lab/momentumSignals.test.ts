import { describe, expect, it } from "vitest";
import { volAdjustedMomentum } from "@/core/screener/features";
import { scoreSetup, type StockFacts } from "@/core/screener/score";
import type { DailyBar } from "@/core/types";
import { highPoints, ofHigh52Series, peerFactor, residualWarmupDays, rsPoints, rsRanks, volAdjustedMomentumSeries } from "./momentumSignals";
import { findSignal, LAB_SIGNALS, resolveParams, type SignalContext } from "./signals";

const DAY = 86_400_000;
const T0 = Date.UTC(2015, 0, 1);

function rng(seed: number) {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
}

function walk(n: number, seed: number, drift = 0, dates = Array.from({ length: n }, (_, i) => T0 + i * DAY)): DailyBar[] {
  const next = rng(seed);
  let close = 100;
  return dates.map((t, i) => {
    if (i > 0) close *= 1 + drift + (next() - 0.5) * 0.04;
    return { t, o: close, h: close * (1 + next() * 0.01), l: close * 0.99, c: close, v: 1 };
  });
}

describe("the score's RS factor as a signal", () => {
  it("volAdjustedMomentumSeries matches features.ts volAdjustedMomentum at every bar", () => {
    const bars = walk(400, 11, 0.0005);
    const series = volAdjustedMomentumSeries(bars);
    for (const i of [0, 100, 125, 126, 200, 251, 252, 300, 399]) {
      const expected = volAdjustedMomentum(bars.slice(0, i + 1).map((bar) => bar.c));
      if (Number.isNaN(expected)) expect(Number.isNaN(series[i])).toBe(true);
      else expect(series[i]).toBeCloseTo(expected, 9);
    }
  });

  it("ofHigh52Series is close ÷ the highest high of the last 252 bars", () => {
    const bars = walk(600, 5);
    const series = ofHigh52Series(bars);
    for (const i of [0, 10, 251, 252, 400, 599]) {
      const window = bars.slice(Math.max(0, i - 251), i + 1);
      expect(series[i]).toBeCloseTo(bars[i].c / Math.max(...window.map((bar) => bar.h)), 12);
    }
  });

  it("rsPoints and rsRanks award what score.ts awards", () => {
    const facts = { rsRank: 0, ofHigh52: 1 } as unknown as StockFacts;
    const base: StockFacts = {
      close: 100,
      changePct: 0,
      aboveSma50: true,
      sma50AboveSma200: true,
      sma200Rising: true,
      aboveEma20: true,
      rsRank: 50,
      volRatio20: 1,
      deliveryRatio: null,
      upDownVol20: 1,
      pattern: null,
      bearishPattern: null,
      ext20Atr: 0,
      atr14: 1,
      resistance: null,
      support: null,
      chandelier: 90,
      turnoverCr: 100,
    };
    for (const [rank, ofHigh] of [
      [1, 0.5],
      [37, 0.8],
      [70, 0.9],
      [99, 0.96],
      [50, Number.NaN],
    ]) {
      const part = scoreSetup({ ...base, ...facts, rsRank: rank, ofHigh52: Number.isNaN(ofHigh) ? undefined : ofHigh }, { entry: 100, stop: 95, target: 110, exit: "" }, { holdDays: 10 }).parts.find((p) => p.key === "rs")!;
      expect(rsPoints(rank, ofHigh)).toBeCloseTo(part.points, 10);
    }
    expect(highPoints(0.74)).toBe(0);
    const ranks = rsRanks([
      { symbol: "B", score: 2 },
      { symbol: "A", score: 1 },
      { symbol: "C", score: 3 },
    ]);
    expect([...ranks]).toEqual([
      ["A", 1],
      ["B", 50],
      ["C", 99],
    ]);
    expect(rsRanks([{ symbol: "A", score: 1 }]).get("A")).toBe(50);
  });

  it("score-rs ranks among the day's members only", async () => {
    const symbols = Array.from({ length: 6 }, (_, s) => `S${s}`);
    const bars = new Map(symbols.map((symbol, s) => [symbol, walk(300, 20 + s, (s - 3) * 0.001)]));
    const dates = bars.get("S0")!.map((bar) => bar.t);
    const day = dates[299];
    const signal = findSignal("score-rs")!;
    const all = await signal.build({ dates, symbols, bars, benchmark: [] }, {});
    const some = await signal.build({ dates, symbols, bars, benchmark: [], isMember: (symbol) => symbol !== "S5" }, {});
    expect(all(day, "S5")).not.toBeNull();
    expect(some(day, "S5")).toBeNull();
    // Strongest drift has the top rank: 10 points for the rank plus its 52-week-high points.
    expect(all(day, "S5")).toBeGreaterThan(all(day, "S0")!);
    expect(all(dates[50], "S0")).toBeNull(); // under 126 sessions of history
  });
});

describe("residual momentum signal", () => {
  it("is registered with its parameters, warm-up and industry use", () => {
    const signal = findSignal("residual-momentum")!;
    expect(LAB_SIGNALS.filter((entry) => entry.id === "residual-momentum")).toHaveLength(1);
    const params = resolveParams(signal, { factors: 2 });
    expect(params).toEqual({ factors: 2, scale: 1, window: 756, lookback: 252, skip: 21 });
    expect(signal.usesIndustries?.(params)).toBe(true);
    expect(signal.usesIndustries?.({ ...params, factors: 1 })).toBe(false);
    // 3 years of sessions before the first formation day, in calendar days.
    expect(signal.warmupDays?.(params)).toBe(residualWarmupDays(756));
    expect(residualWarmupDays(756)).toBeGreaterThan(1100);
  });

  it("builds values from the benchmark (and sector peers with factors = 2)", async () => {
    const n = 900;
    const symbols = Array.from({ length: 8 }, (_, s) => `S${s}`);
    const bars = new Map(symbols.map((symbol, s) => [symbol, walk(n, 40 + s, (s - 4) * 0.0003)]));
    const dates = bars.get("S0")!.map((bar) => bar.t);
    const ctx: SignalContext = { dates, symbols, bars, benchmark: walk(n, 99), industryOf: (symbol) => (Number(symbol.slice(1)) % 2 ? "Odd" : "Even") };
    const signal = findSignal("residual-momentum")!;
    for (const factors of [1, 2]) {
      const values = await signal.build(ctx, resolveParams(signal, { factors }));
      expect(values(dates[700], "S0")).toBeNull(); // not 756 sessions yet
      const last = symbols.map((symbol) => values(dates[n - 1], symbol)!);
      last.forEach((value) => expect(Number.isFinite(value)).toBe(true));
      // The stocks' own drifts are idiosyncratic: the highest drift has the highest residual.
      expect(last[7]).toBeGreaterThan(last[0]);
    }
  });
});

describe("peerFactor", () => {
  const dates = [T0, T0 + DAY, T0 + 2 * DAY];
  const bar = (t: number, c: number): DailyBar => ({ t, o: c, h: c, l: c, c, v: 1 });
  const bars = new Map<string, DailyBar[]>([
    ["A", [bar(dates[0], 100), bar(dates[1], 110), bar(dates[2], 110)]],
    ["B", [bar(dates[0], 100), bar(dates[1], 102)]],
    ["C", [bar(dates[0], 100), bar(dates[1], 104)]],
    ["D", [bar(dates[0], 100), bar(dates[1], 106)]],
    ["E", [bar(dates[0], 100), bar(dates[1], 300)]], // +200%: a data error, left out
    ["Z", [bar(dates[0], 100), bar(dates[1], 50)]], // another industry
  ]);
  const industry = (symbol: string) => (symbol === "Z" ? "Other" : symbol === "Q" ? null : "Same");
  const factor = peerFactor({ dates, symbols: [...bars.keys()], bars }, industry, 3);

  it("is the equal-weighted return of the stock's peers, the stock itself left out", () => {
    expect(factor(dates[0], dates[1], "A")).toBeCloseTo((0.02 + 0.04 + 0.06) / 3, 12);
    expect(factor(dates[0], dates[1], "B")).toBeCloseTo((0.1 + 0.04 + 0.06) / 3, 12);
  });

  it("is null with too few peers, without an industry, or across a gap in the calendar", () => {
    expect(factor(dates[1], dates[2], "A")).toBeNull(); // only A traded
    expect(factor(dates[0], dates[1], "Z")).toBeNull(); // no peers
    expect(factor(dates[0], dates[1], "Q")).toBeNull(); // unknown industry
    expect(factor(dates[0], dates[2], "A")).toBeNull(); // not consecutive sessions
  });
});
