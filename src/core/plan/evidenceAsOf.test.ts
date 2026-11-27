import { describe, expect, it } from "vitest";
import { COST_PRESETS } from "@/core/backtest/costs";
import { scanSignals } from "@/core/backtest/signals";
import { barsThrough } from "@/core/reference/timeMachine";
import { HOLD_BARS } from "@/core/screener/backtest";
import { SCREEN_MAP } from "@/core/screener/screens";
import type { DailyBar } from "@/core/types";
import { marketStates, replaySignals, type EvidenceTrade } from "./evidence";

// The plan's evidence as of a past day (the Time Machine, #31): computed on
// the bars up to that day's close, it counts only trades that had closed by
// then — and each of those is exactly the trade a run on all the bars has.

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

/** Seeded random walk, so the screens fire. */
function walk(seed: number, n: number): DailyBar[] {
  let state = seed;
  const rand = () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296);
  let close = 200 + (seed % 300);
  return Array.from({ length: n }, (_, i) => {
    const open = close * (1 + (rand() - 0.5) * 0.01);
    const next = open * (1 + (rand() - 0.47) * 0.05);
    const out = { t: T0 + i * DAY, o: open, h: Math.max(open, next) * (1 + rand() * 0.015), l: Math.min(open, next) * (1 - rand() * 0.015), c: next, v: Math.round(2e6 * (0.5 + rand() * (rand() > 0.9 ? 4 : 1))), dp: 30 + rand() * 40 };
    close = next;
    return out;
  });
}

describe("the evidence of a past day", () => {
  it("counts only trades whose whole holding period ended by the day; each is the full run's trade", async () => {
    const symbols = Array.from({ length: 12 }, (_, i) => `S${i}`);
    const data = new Map(symbols.map((symbol, i) => [symbol, walk(i * 7919 + 13, 220)]));
    const benchmark = walk(4242, 220);
    const cut = T0 + 180 * DAY;
    const options = { costs: COST_PRESETS["futures-2026"].model, lots: {}, states: marketStates(benchmark) };
    const through = (bars: DailyBar[], day: number) => (Number.isFinite(day) ? barsThrough(bars, day, (bar) => bar.t) : bars);
    const run = async (day: number) => replaySignals(await scanSignals({ symbols, getBars: (s) => through(data.get(s)!, day), benchmark: through(benchmark, day) }), options);
    const full = await run(Infinity);
    const past = await run(cut);
    expect(past.length).toBeGreaterThan(0);

    const key = (trade: EvidenceTrade) => `${trade.date}|${trade.symbol}|${trade.screenId}`;
    const fullByKey = new Map(full.map((trade) => [key(trade), trade]));
    // Nothing after the day changed a trade it counts.
    for (const trade of past) expect(fullByKey.get(key(trade))).toEqual(trade);
    // The trades it leaves out were still inside their holding period at the day's close.
    const counted = new Set(past.map(key));
    const left = full.filter((trade) => !counted.has(key(trade)) && trade.date <= cut);
    expect(left.length).toBeGreaterThan(0);
    for (const trade of left) expect(trade.date + HOLD_BARS[SCREEN_MAP[trade.screenId].group] * DAY).toBeGreaterThan(cut);
    // And no trade starts after the day.
    expect(past.every((trade) => trade.date <= cut)).toBe(true);
  });
});
