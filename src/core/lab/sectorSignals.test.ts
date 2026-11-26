import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/core/types";
import { SECTOR_SIGNALS, sectorMomentum, sectorQuadrant, sectorReversal, type SectorContext, type SectorSeriesInput } from "./sectorSignals";
import { LAB_SIGNALS, findSignal, resolveParams, type SignalContext } from "./signals";

const DAY = 86_400_000;
const T0 = Date.UTC(2020, 0, 1);
const N = 400;
const dates = Array.from({ length: N }, (_, i) => T0 + i * DAY);
const bars = (close: (i: number) => number): DailyBar[] => dates.map((t, i) => ({ t, o: close(i), h: close(i), l: close(i), c: close(i), v: 1 }));
const series = (close: (i: number) => number, syntheticUntil: number | null = null): SectorSeriesInput => ({ bars: bars(close), syntheticUntil, label: "test" });

const bench = series(() => 1000);
const strong = series((i) => 100 * Math.exp(0.002 * i));
const weak = series((i) => 100 * Math.exp(-0.001 * i));
// Relative strength that cycles: it visits every RRG quadrant.
const cycling = series((i) => 100 * (1 + 0.1 * Math.sin((2 * Math.PI * i) / 120)));

function context(sectors: SectorContext | null): SignalContext {
  const symbols = ["AAA", "BBB", "CCC", "ORPHAN"];
  return { dates, symbols, bars: new Map(symbols.map((symbol) => [symbol, bars(() => 10)])), benchmark: bench.bars, sectors };
}

const SECTORS: SectorContext = {
  sectorOf: (symbol) => ({ AAA: "Strong", BBB: "Weak", CCC: "Cycling" })[symbol] ?? null,
  series: new Map([
    ["Strong", strong],
    ["Weak", weak],
    ["Cycling", cycling],
  ]),
  benchmark: bench,
};

describe("sector signals", () => {
  it("are registered in the Lab under their own group, reading the sector series", () => {
    for (const signal of SECTOR_SIGNALS) {
      expect(findSignal(signal.id)).toBe(signal);
      expect(signal.group).toBe("sector");
      expect(signal.usesSectors).toBe(true);
    }
    expect(LAB_SIGNALS.filter((signal) => signal.group === "sector").map((signal) => signal.id)).toEqual(["sector-momentum", "sector-reversal", "sector-rrg"]);
  });

  it("sector momentum is ln(RS now / RS N sessions ago), shared by every stock of the sector", async () => {
    const signal = findSignal("sector-momentum")!;
    const values = await signal.build(context(SECTORS), resolveParams(signal, { lookback: 21 }));
    const day = dates[100];
    expect(values(day, "AAA")).toBeCloseTo(0.002 * 21, 10);
    expect(values(day, "BBB")).toBeCloseTo(-0.001 * 21, 10);
    expect(values(dates[20], "AAA")).toBeNull();
    expect(values(day, "ORPHAN")).toBeNull();
  });

  it("sector reversal is minus the sector's own return", async () => {
    const signal = findSignal("sector-reversal")!;
    const values = await signal.build(context(SECTORS), resolveParams(signal, {}));
    expect(values(dates[50], "AAA")).toBeCloseTo(-(Math.exp(0.002 * 21) - 1), 10);
    expect(values(dates[50], "BBB")).toBeGreaterThan(0);
  });

  it("gives no value anywhere without sector data", async () => {
    for (const signal of SECTOR_SIGNALS) {
      const values = await signal.build(context(null), resolveParams(signal, {}));
      expect(values(dates[300], "AAA")).toBeNull();
    }
  });

  it("synthetic = 0 drops sessions whose look-back touches a basket", () => {
    const spliced = { ...strong, syntheticUntil: dates[99] };
    const all = sectorMomentum(spliced, bench, 21, true);
    const indexOnly = sectorMomentum(spliced, bench, 21, false);
    expect(all.has(dates[110])).toBe(true);
    expect(indexOnly.has(dates[110])).toBe(false);
    expect(indexOnly.has(dates[121])).toBe(true);
    expect(sectorReversal(spliced, 21, false).has(dates[120])).toBe(false);
    expect(sectorMomentum(strong, { ...bench, syntheticUntil: dates[399] }, 21, false).size).toBe(0);
  });

  it("the RRG signal flags its quadrant; Improving-or-Leading is RS-Momentum ≥ 100", () => {
    const params = { smooth: 10, window: 63, lag: 10 };
    const quadrants = [1, 2, 3, 4].map((code) => sectorQuadrant(cycling, bench, code, params, true));
    const either = sectorQuadrant(cycling, bench, 5, params, true);
    const days = [...either.keys()];
    expect(days.length).toBeGreaterThan(100);
    for (const day of days) {
      // Exactly one quadrant per session; 5 = Leading or Improving.
      expect(quadrants.reduce((sum, map) => sum + (map.get(day) ?? 0), 0)).toBe(1);
      expect(either.get(day)).toBe((quadrants[0].get(day) ?? 0) + (quadrants[3].get(day) ?? 0));
    }
    for (const map of quadrants) expect([...map.values()].some((value) => value === 1)).toBe(true);
  });
});
