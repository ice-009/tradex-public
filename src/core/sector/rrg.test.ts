import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/core/types";
import { RRG_DEFAULTS, ema, quadrantOf, relativeStrength, rollingScore, rotationSteps, rrgPoints, rrgSeries, rrgTrail, rrgWarmup } from "./rrg";

const DAY = 86_400_000;
const T0 = Date.UTC(2020, 0, 1);
const bars = (closes: number[], start = T0): DailyBar[] => closes.map((c, i) => ({ t: start + i * DAY, o: c, h: c, l: c, c, v: 1 }));

describe("RRG building blocks", () => {
  it("relative strength lines the series up by day and skips sessions either lacks", () => {
    const sector = bars([10, 11, 12, 13]);
    const bench = bars([100, 100, 200]).filter((_, i) => i !== 1);
    const { t, rs } = relativeStrength(sector, bench);
    expect(t).toEqual([T0, T0 + 2 * DAY]);
    expect(rs).toEqual([10, 6]);
  });

  it("EMA is seeded with the first value", () => {
    const out = ema([10, 20, 20], 3);
    expect(out[0]).toBe(10);
    expect(out[1]).toBeCloseTo(15);
    expect(out[2]).toBeCloseTo(17.5);
  });

  it("rolling score is 100 + a z-score over the window, NaN when flat or short", () => {
    const linear = Array.from({ length: 10 }, (_, i) => i);
    const out = rollingScore(linear, 5);
    expect(Number.isNaN(out[3])).toBe(true);
    // Last of 0..4 against its window: (4 − 2) / sd(0..4) = 2 / √2.5.
    expect(out[4]).toBeCloseTo(100 + 2 / Math.sqrt(2.5));
    expect(out[9]).toBeCloseTo(out[4]);
    expect(Number.isNaN(rollingScore([5, 5, 5, 5], 3)[3])).toBe(true);
    expect(Number.isNaN(rollingScore([1, Number.NaN, 3, 4], 3)[3])).toBe(true);
  });

  it("splits the plane into the four quadrants at 100", () => {
    expect(quadrantOf(101, 101)).toBe("leading");
    expect(quadrantOf(101, 99)).toBe("weakening");
    expect(quadrantOf(99, 99)).toBe("lagging");
    expect(quadrantOf(99, 101)).toBe("improving");
    expect(quadrantOf(100, 100)).toBe("leading");
  });
});

describe("RRG on synthetic series", () => {
  const n = 600;
  // Relative strength cycling with a 120-session period around a flat benchmark.
  const cycling = bars(Array.from({ length: n }, (_, i) => 100 * (1 + 0.1 * Math.sin((2 * Math.PI * i) / 120))));
  const flat = bars(Array.from({ length: n }, () => 1000));

  it("starts after the documented warm-up", () => {
    const { ratio, momentum } = rrgSeries(cycling.map((bar) => bar.c / 10));
    const first = momentum.findIndex(Number.isFinite);
    expect(first).toBe(rrgWarmup(RRG_DEFAULTS));
    expect(ratio.findIndex(Number.isFinite)).toBe(RRG_DEFAULTS.smooth + RRG_DEFAULTS.window - 2);
  });

  it("a cycling sector rotates clockwise through all four quadrants", () => {
    const points = rrgPoints(cycling, flat);
    expect(points.length).toBe(n - rrgWarmup(RRG_DEFAULTS));
    const seen = new Set(points.map((point) => point.quadrant));
    expect(seen.size).toBe(4);
    let forward = 0;
    let backward = 0;
    for (let i = 1; i < points.length; i += 1) {
      const step = rotationSteps(points[i - 1].quadrant, points[i].quadrant);
      if (step === 1) forward += 1;
      if (step === 3) backward += 1;
      expect(step).not.toBe(2);
    }
    // Four quadrant changes per 120-session cycle, all clockwise.
    expect(forward).toBeGreaterThanOrEqual(Math.floor((points.length / 120) * 4) - 1);
    expect(backward).toBe(0);
  });

  it("a steadily outperforming sector sits right of 100; an underperformer left", () => {
    const up = bars(Array.from({ length: 300 }, (_, i) => 100 * Math.exp(0.002 * i + 0.01 * Math.sin(i))));
    const down = bars(Array.from({ length: 300 }, (_, i) => 100 * Math.exp(-0.002 * i + 0.01 * Math.sin(i))));
    const flat300 = flat.slice(0, 300);
    const last = (series: DailyBar[]) => rrgPoints(series, flat300).at(-1)!;
    expect(last(up).ratio).toBeGreaterThan(100);
    expect(last(down).ratio).toBeLessThan(100);
  });

  it("uses nothing after the session: values on a cut series match", () => {
    const full = rrgPoints(cycling, flat);
    const cut = rrgPoints(cycling.slice(0, 400), flat);
    const byDay = new Map(full.map((point) => [point.t, point]));
    for (const point of cut) {
      expect(point.ratio).toBeCloseTo(byDay.get(point.t)!.ratio, 10);
      expect(point.momentum).toBeCloseTo(byDay.get(point.t)!.momentum, 10);
    }
  });

  it("the trail is the newest point and one every k sessions before it, oldest first", () => {
    const points = rrgPoints(cycling, flat);
    const trail = rrgTrail(points, 4, 5);
    expect(trail).toHaveLength(4);
    expect(trail.at(-1)).toBe(points.at(-1));
    expect(trail[0]).toBe(points[points.length - 16]);
    expect(rrgTrail(points.slice(0, 3), 4, 5)).toHaveLength(1);
  });
});
