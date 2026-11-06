import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/core/types";
import { scanSignals, type Signal } from "./signals";

const DAY = 86_400_000;
const T0 = Date.UTC(2025, 0, 6);

/** Deterministic random walk (seeded LCG) so screens fire on synthetic data. */
function walk(seed: number, n: number): DailyBar[] {
  let state = seed;
  const rand = () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296);
  let close = 200 + seed % 300;
  const bars: DailyBar[] = [];
  for (let i = 0; i < n; i += 1) {
    const drift = (rand() - 0.47) * 0.05;
    const open = close * (1 + (rand() - 0.5) * 0.01);
    const next = open * (1 + drift);
    const high = Math.max(open, next) * (1 + rand() * 0.015);
    const low = Math.min(open, next) * (1 - rand() * 0.015);
    bars.push({ t: T0 + i * DAY, o: open, h: high, l: low, c: next, v: Math.round(2e6 * (0.5 + rand() * (rand() > 0.9 ? 4 : 1))), dp: 30 + rand() * 40 });
    close = next;
  }
  return bars;
}

const key = (signal: Signal) => `${signal.date}|${signal.symbol}|${signal.screenId}|${signal.score.toFixed(6)}|${signal.entry.toFixed(6)}|${signal.stop.toFixed(6)}`;

describe("signal scan", () => {
  const symbols = Array.from({ length: 12 }, (_, i) => `S${i}`);
  const data = new Map(symbols.map((symbol, i) => [symbol, walk(i * 7919 + 13, 160)]));
  const benchmark = walk(4242, 160);

  it("has no look-ahead: changing future bars doesn't change past signals", async () => {
    const cutoff = T0 + 120 * DAY;
    const before = await scanSignals({ symbols, getBars: (s) => data.get(s)!, benchmark });
    // Replace every bar after the cutoff with something wildly different.
    const altered = new Map(
      [...data].map(([symbol, bars]) => [symbol, bars.map((bar) => (bar.t > cutoff ? { ...bar, o: bar.o * 3, h: bar.h * 3.2, l: bar.l * 0.4, c: bar.c * 2.5, v: bar.v * 9 } : bar))]),
    );
    const after = await scanSignals({ symbols, getBars: (s) => altered.get(s)!, benchmark: benchmark.map((bar) => (bar.t > cutoff ? { ...bar, c: bar.c * 2 } : bar)) });
    const past = (scan: typeof before) => [...scan.byDate.values()].flat().filter((s) => s.date <= cutoff).map(key).sort();
    expect(past(before).length).toBeGreaterThan(5);
    expect(past(after)).toEqual(past(before));
    // ...and the future did change, so the test can tell the difference.
    const future = (scan: typeof before) => [...scan.byDate.values()].flat().filter((s) => s.date > cutoff).map(key).sort();
    expect(future(after)).not.toEqual(future(before));
  });

  it("starts signalling only after the warm-up and records the signal session's close", async () => {
    const scan = await scanSignals({ symbols, getBars: (s) => data.get(s)!, benchmark });
    expect(scan.firstSignalDate).toBe(T0 + 59 * DAY);
    for (const signal of [...scan.byDate.values()].flat()) {
      const bars = data.get(signal.symbol)!;
      expect(bars[signal.index].t).toBe(signal.date);
      expect(signal.close).toBe(bars[signal.index].c);
      expect(signal.entry).toBeGreaterThan(signal.stop);
    }
  });

  it("gives no signal to a stock on sessions it wasn't in the universe", async () => {
    const all = await scanSignals({ symbols, getBars: (s) => data.get(s)!, benchmark });
    const cutoff = T0 + 110 * DAY;
    // S0–S5 join the universe only after the cutoff (point-in-time membership).
    const isMember = (symbol: string, date: number) => Number(symbol.slice(1)) >= 6 || date > cutoff;
    const pit = await scanSignals({ symbols, getBars: (s) => data.get(s)!, benchmark, isMember });
    const signals = [...pit.byDate.values()].flat();
    expect(signals.some((s) => Number(s.symbol.slice(1)) < 6 && s.date <= cutoff)).toBe(false);
    expect(signals.some((s) => Number(s.symbol.slice(1)) < 6 && s.date > cutoff)).toBe(true);
    expect(pit.signals).toBeLessThan(all.signals);
  });
});
