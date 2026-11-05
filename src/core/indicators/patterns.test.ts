import { describe, expect, it } from "vitest";
import type { Bar } from "@/core/types";
import { detectPatterns } from "./patterns";

const DAY = 864e5;

function bars(closes: number[], vol: (i: number) => number = () => 1e6): Bar[] {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { time: i * DAY, open: o, high: Math.max(o, c) * 1.004, low: Math.min(o, c) * 0.996, close: c, volume: vol(i) };
  });
}
const lerp = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * (i + 1)) / n);
function path(...legs: Array<[number, number, number]>) {
  const out = [legs[0][0]];
  for (const [, b, n] of legs) out.push(...lerp(out[out.length - 1], b, n));
  return out;
}
const uptrend = path([60, 60, 1], [60, 100, 80]);

const cases: Record<string, { closes: number[]; vol?: (i: number, n: number) => number }> = {
  "asc-triangle": { closes: path([100, 100, 1], [100, 120, 20], [120, 108, 8], [108, 120, 8], [120, 112, 8], [112, 120, 8], [120, 116, 6], [116, 119.5, 4]) },
  "double-bottom": { closes: path([150, 150, 1], [150, 100, 40], [100, 112, 10], [112, 100.5, 10], [100.5, 110, 6]) },
  "bull-flag": { closes: [...uptrend, ...path([100, 100, 1], [100, 101, 10], [101, 120, 6], [120, 114, 6])], vol: (i, n) => (i > n - 7 ? 5e5 : 1e6) },
  rectangle: { closes: [...uptrend, ...path([100, 100, 1], [100, 110, 6], [110, 101, 8], [101, 110, 8], [110, 101, 8], [101, 109.5, 8])] },
  vcp: {
    closes: [...uptrend, ...path([100, 100, 1], [100, 125, 15], [125, 103, 10], [103, 125, 10], [125, 112, 8], [112, 125, 8], [125, 119, 6], [119, 124.5, 5])],
    vol: (i, n) => (i > n - 12 ? 4e5 : 1e6),
  },
  "cup-handle": { closes: [...uptrend, ...path([100, 100, 1], [100, 130, 10], [130, 106, 18], [106, 104, 14], [104, 106, 14], [106, 129, 18], [129, 123, 5], [123, 127, 3])] },
};

describe("chart pattern detector", () => {
  it.each(Object.entries(cases))("finds %s with sane levels", (kind, { closes, vol }) => {
    const result = detectPatterns(bars(closes, vol ? (i) => vol(i, closes.length) : undefined));
    const hit = result.patterns.find((pattern) => pattern.kind === kind);
    expect(hit, `found: ${result.patterns.map((p) => p.kind).join(",") || "none"}`).toBeDefined();
    expect(hit!.stop).toBeLessThan(closes[closes.length - 1]);
    expect(hit!.target).toBeGreaterThan(hit!.breakout);
  });

  it("stays quiet on most random walks", () => {
    let seed = 3;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let price = 100;
    let withPattern = 0;
    for (let t = 0; t < 200; t += 1) {
      const closes: number[] = [];
      for (let i = 0; i < 260; i += 1) closes.push((price *= 1 + (rnd() - 0.5) * 0.03));
      if (detectPatterns(bars(closes)).patterns.length) withPattern += 1;
    }
    expect(withPattern / 200).toBeLessThan(0.25);
  });
});
