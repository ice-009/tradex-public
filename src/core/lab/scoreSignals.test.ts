import { describe, expect, it } from "vitest";
import { WARMUP_SESSIONS, scanSignals, seriesOf, type Signal, type SignalScan } from "@/core/backtest/signals";
import { computeFeatures } from "@/core/screener/features";
import { accumulationPart, extensionPart, factsFrom, patternPart, stopPart, trackPart, trendPart } from "@/core/screener/score";
import type { DailyBar } from "@/core/types";
import { pointInTimeTrack } from "./scoreSignals";
import { findSignal, type SignalContext } from "./signals";

const DAY = 86_400_000;
const T0 = Date.UTC(2021, 0, 4);

function rng(seed: number) {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/** A seeded random walk with ranges and volume (and delivery %), so every feature is defined. */
function walk(n: number, seed: number, drift: number): DailyBar[] {
  const next = rng(seed);
  let close = 200;
  return Array.from({ length: n }, (_, i) => {
    const open = close * (1 + (next() - 0.5) * 0.01);
    close = open * (1 + drift + (next() - 0.5) * 0.04);
    return {
      t: T0 + i * DAY,
      o: open,
      h: Math.max(open, close) * (1 + next() * 0.015),
      l: Math.min(open, close) * (1 - next() * 0.015),
      c: close,
      v: Math.round(1e6 * (0.5 + next() * (next() > 0.9 ? 4 : 1))),
      dp: 30 + next() * 40,
    };
  });
}

function context(stocks = 8, n = 320): SignalContext {
  const bars = new Map<string, DailyBar[]>();
  for (let s = 0; s < stocks; s += 1) bars.set(`S${s}`, walk(n, 100 + s, (s - stocks / 2) * 0.0006));
  return { dates: bars.get("S0")!.map((bar) => bar.t), symbols: [...bars.keys()], bars, benchmark: walk(n, 7, 0.0003) };
}

describe("score factors as Lab signals (#29)", () => {
  it("value a stock exactly as the score's factor functions award it, from the 260-bar window", async () => {
    const ctx = context(3);
    const cases = [
      ["score-trend", trendPart],
      ["score-accumulation", accumulationPart],
      ["score-pattern", patternPart],
      ["score-extension", extensionPart],
    ] as const;
    for (const [id, part] of cases) {
      const values = await findSignal(id)!.build(ctx, {});
      for (const symbol of ctx.symbols) {
        const bars = ctx.bars.get(symbol)!;
        expect(values(bars[WARMUP_SESSIONS - 2].t, symbol)).toBeNull();
        for (const i of [WARMUP_SESSIONS - 1, 150, 259, 260, 319]) {
          const facts = factsFrom(computeFeatures(symbol, bars.slice(Math.max(0, i - 259), i + 1), false));
          expect(values(bars[i].t, symbol)).toBe(part(facts as never).points);
        }
      }
      expect(values(T0, "UNKNOWN")).toBeNull();
    }
  });

  it("value plan factors only on the sessions a screen matched, at the best match", async () => {
    const ctx = context(10, 300);
    const scan = await scanSignals({ symbols: [...ctx.symbols], getBars: (symbol) => ctx.bars.get(symbol)! as DailyBar[], benchmark: ctx.benchmark as DailyBar[] });
    expect(scan.signals).toBeGreaterThan(0);
    const values = await findSignal("score-stop")!.build({ ...ctx, scan }, {});
    const matched = new Set<string>();
    for (const [day, signals] of scan.byDate) {
      for (const signal of signals) {
        const key = `${day}:${signal.symbol}`;
        if (matched.has(key)) continue;
        matched.add(key);
        const best = Math.max(...signals.filter((other) => other.symbol === signal.symbol).map((other) => stopPart(other).points));
        expect(values(day, signal.symbol)).toBe(best);
      }
    }
    for (const day of ctx.dates) for (const symbol of ctx.symbols) if (!matched.has(`${day}:${symbol}`)) expect(values(day, symbol)).toBeNull();
    const rr = await findSignal("score-rr")!.build({ ...ctx, scan }, {});
    const [day, signals] = [...scan.byDate][0];
    expect(rr(day, signals[0].symbol)).not.toBeNull();
  });

  it("score-track reads each screen's record as it stood then: only finished signals of the last 160 sessions", () => {
    const n = 400;
    const bars: DailyBar[] = Array.from({ length: n }, (_, i) => ({ t: T0 + i * DAY, o: 100, h: 100.5, l: 99.5, c: 100, v: 1 }));
    // A BTST screen (held 1 session, out at the next open): every signal's R is (open − entry) / risk = 0 here.
    const signal = (i: number, entry = 100, stop = 98): Signal => ({ symbol: "S", screenId: "btst-20d-high", date: bars[i].t, index: i, score: 1, close: 100, entry, stop, target: null });
    const byDate = new Map<number, Signal[]>();
    for (let i = 10; i < 300; i += 5) byDate.set(bars[i].t, [signal(i, i < 100 ? 99 : 100)]);
    const scan: SignalScan = { dates: bars.map((bar) => bar.t), firstSignalDate: bars[0].t, firstByScreen: {}, byDate, series: new Map([["S", seriesOf(bars)]]), benchmark: bars, symbols: 1, signals: byDate.size };
    const record = pointInTimeTrack(scan);
    // At session 10 its own signal hasn't finished (held to session 11).
    expect(record("btst-20d-high", 10)).toEqual({ avgR: null, signals: 0 });
    expect(record("btst-20d-high", 11)).toEqual({ avgR: 1, signals: 1 });
    // Session 95: signals at 10, 15, … 90 have finished (the one at 95 hasn't): 17 of them, entry 99, stop 98 → R = (100 − 99) / 1 = 1.
    expect(record("btst-20d-high", 95)).toEqual({ avgR: 1, signals: 17 });
    // Session 299: the window is sessions 140 … 299, where R = 0; the signal at 295 finished at 296.
    expect(record("btst-20d-high", 299)).toEqual({ avgR: 0, signals: 32 });
    expect(trackPart(record("btst-20d-high", 299)).points).toBe(4);
    expect(record("swing-nr7", 299)).toEqual({ avgR: null, signals: 0 });
  });
});
