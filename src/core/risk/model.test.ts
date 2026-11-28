import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/core/types";
import { factorReturns } from "@/test/riskSynthetic";
import { MAX_ABS_RETURN, alignedReturns, type ReturnSeries } from "./returns";
import { MIN_SESSIONS, buildRiskModel, correlationOf } from "./model";

const DAY = 86_400_000;
const bar = (t: number, c: number): DailyBar => ({ t, o: c, h: c, l: c, c, v: 1 });
/** Bars from log returns, one per day from day 1. */
const barsFrom = (returns: number[], start = 100): DailyBar[] => {
  const out = [bar(0, start)];
  for (let i = 0; i < returns.length; i += 1) out.push(bar((i + 1) * DAY, out[i].c * Math.exp(returns[i])));
  return out;
};

describe("aligned returns", () => {
  it("lines stocks up on the benchmark's sessions, with gaps as null", () => {
    const nifty = [bar(0, 100), bar(DAY, 101), bar(2 * DAY, 102), bar(3 * DAY, 103)];
    const a = [bar(0, 10), bar(DAY, 11), bar(3 * DAY, 12)]; // no bar on day 2
    const series = alignedReturns({ A: a }, nifty, { lookback: 10 });
    expect(series.sessions).toEqual([DAY, 2 * DAY, 3 * DAY]);
    expect(series.returns.A[0]).toBeCloseTo(Math.log(1.1), 12);
    expect(series.returns.A[1]).toBeNull();
    expect(series.returns.A[2]).toBeNull(); // the session before had no bar
    expect(series.benchmark[2]).toBeCloseTo(Math.log(103 / 102), 12);
  });

  it("uses nothing after `through` (the Time Machine's day)", () => {
    const nifty = [0, 1, 2, 3, 4].map((i) => bar(i * DAY, 100 + i));
    const a = [0, 1, 2, 3, 4].map((i) => bar(i * DAY, i === 4 ? 1_000 : 10 + i));
    const series = alignedReturns({ A: a }, nifty, { lookback: 10, through: 3 * DAY });
    expect(series.sessions.at(-1)).toBe(3 * DAY);
    expect(series.returns.A.every((value) => value !== null && Math.abs(value) < 0.2)).toBe(true);
  });

  it("keeps the last `lookback` sessions and clips bad prints", () => {
    const nifty = barsFrom(new Array(50).fill(0.001));
    const a = barsFrom([...new Array(49).fill(0.001), 0.9]);
    const series = alignedReturns({ A: a }, nifty, { lookback: 20 });
    expect(series.sessions).toHaveLength(20);
    expect(series.returns.A.at(-1)).toBe(MAX_ABS_RETURN);
  });
});

describe("risk model", () => {
  const seriesOf = (columns: Record<string, Array<number | null>>, benchmark: Array<number | null>): ReturnSeries => ({
    sessions: benchmark.map((_, i) => i * DAY),
    benchmark,
    returns: columns,
  });

  it("measures beta to NIFTY and volatility", () => {
    const { rows, market } = factorReturns({ t: 400, groups: [0, 1], a: 0.4, b: 0.2, seed: 2 });
    const noise = factorReturns({ t: 400, groups: [0], a: 0, b: 0, sigma: 0.004, seed: 99 }).rows;
    const stock = market.map((m, i) => 1.5 * m + noise[i][0]);
    const model = buildRiskModel(seriesOf({ HIGH: stock, OTHER: rows.map((row) => row[1]) }, market))!;
    expect(model.beta.HIGH).toBeCloseTo(1.5, 1);
    expect(model.vol.HIGH).toBeGreaterThan(0.015);
    expect(model.sessions).toBe(400);
    expect(correlationOf(model, "HIGH", "HIGH")).toBe(1);
    expect(correlationOf(model, "HIGH", "NOPE")).toBeNull();
    expect(correlationOf(null, "HIGH", "OTHER")).toBeNull();
  });

  it("leaves out stocks with too little history and fills small gaps", () => {
    const { rows, market } = factorReturns({ t: 100, groups: [0, 0, 1], a: 0.3, b: 0.4, seed: 9 });
    const gappy = rows.map((row, i) => (i % 10 === 0 ? null : row[1]));
    const sparse = rows.map((row, i) => (i < 40 ? null : row[2]));
    const model = buildRiskModel(seriesOf({ A: rows.map((row) => row[0]), B: gappy, NEW: sparse }, market))!;
    expect(model.symbols).toEqual(["A", "B"]);
    expect(model.excluded).toEqual(["NEW"]);
    expect(model.returns.B.every(Number.isFinite)).toBe(true);
    expect(correlationOf(model, "A", "B")).toBeGreaterThan(0.4);
  });

  it("needs MIN_SESSIONS sessions, and works without NIFTY", () => {
    const short = seriesOf({ A: new Array(MIN_SESSIONS - 1).fill(0.01) }, new Array(MIN_SESSIONS - 1).fill(0.01));
    expect(buildRiskModel(short)).toBeNull();
    const { rows } = factorReturns({ t: 60, groups: [0, 1], a: 0.3, b: 0.3 });
    const model = buildRiskModel({ sessions: rows.map((_, i) => i), benchmark: [], returns: { A: rows.map((row) => row[0]), B: rows.map((row) => row[1]) } })!;
    expect(model.beta.A).toBeNull();
  });
});
