import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/core/types";
import { simulatePlan } from "./backtest";
import { rsPercentile, rsScore } from "./run";

const bar = (o: number, h: number, l: number, c: number, t = 0): DailyBar => ({ t, o, h, l, c, v: 1 });

describe("simulatePlan", () => {
  const signal = bar(100, 101, 99, 100);
  const plan = { entry: 100, stop: 95, target: 110 };

  it("hits the target", () => {
    expect(simulatePlan([signal, bar(100, 104, 99, 103), bar(103, 111, 102, 109)], 0, plan, 10)).toEqual({ kind: "target", r: 2 });
  });

  it("fills a gap-down stop at the open, not the stop", () => {
    expect(simulatePlan([signal, bar(92, 93, 90, 91)], 0, plan, 10)).toEqual({ kind: "stop", r: -1.6 });
  });

  it("marks the position open at the end of the hold", () => {
    expect(simulatePlan([signal, bar(100, 102, 99, 101), bar(101, 103, 100, 102.5)], 0, plan, 2)).toEqual({ kind: "open", r: 0.5 });
  });

  it("skips a buy-stop that never triggers", () => {
    expect(simulatePlan([signal, bar(100, 101.5, 99, 101)], 0, { entry: 102, stop: 97, target: 112 }, 10)).toBeNull();
  });
});

describe("relative strength", () => {
  it("needs ~3 months of bars", () => {
    expect(rsScore(Array.from({ length: 63 }, () => bar(1, 1, 1, 1)))).toBeNaN();
  });

  it("ranks a score as a 1–99 percentile", () => {
    const peers = [1, 2, 3, 4, 5];
    expect(rsPercentile(0, peers)).toBe(1);
    expect(rsPercentile(10, peers)).toBe(99);
    expect(rsPercentile(3.5, peers)).toBe(75);
    expect(rsPercentile(NaN, peers)).toBe(50);
  });
});
