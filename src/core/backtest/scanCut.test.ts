import { describe, expect, it } from "vitest";
import { COST_PRESETS } from "@/core/backtest/costs";
import { marketStates, replaySignals } from "@/core/plan/evidence";
import type { DailyBar } from "@/core/types";
import { cutScan } from "./scanCut";
import { scanSignals } from "./signals";

// One scan over a replay block, cut at each day, gives each day exactly the
// trades its own scan (its own look-back, cut at its close) gives.

const DAY = 86_400_000;
const T0 = Date.UTC(2023, 0, 2);

function walk(seed: number, n: number, gapAt: number | null = null): DailyBar[] {
  let state = seed;
  const rand = () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296);
  let close = 200 + (seed % 300);
  const out: DailyBar[] = [];
  for (let i = 0; i < n; i += 1) {
    const open = close * (1 + (rand() - 0.5) * 0.01);
    const next = open * (1 + (rand() - 0.47) * 0.05);
    close = next;
    // A suspended stock: no bars for 370 sessions.
    if (gapAt !== null && i >= gapAt && i < gapAt + 370) continue;
    out.push({ t: T0 + i * DAY, o: open, h: Math.max(open, next) * (1 + rand() * 0.015), l: Math.min(open, next) * (1 - rand() * 0.015), c: next, v: Math.round(2e6 * (0.5 + rand() * (rand() > 0.9 ? 4 : 1))), dp: 30 + rand() * 40 });
  }
  return out;
}

const N = 1100;
const symbols = Array.from({ length: 14 }, (_, i) => `S${i}`);
const data = new Map(symbols.map((symbol, i) => [symbol, walk(i * 7919 + 13, N, symbol === "S13" ? 230 : null)]));
const benchmark = walk(4242, N);
/** S3 leaves the list on day 1000; S13 (suspended for a year) on day 700. */
const isMember = (symbol: string, date: number) => !(symbol === "S3" && date >= T0 + 1000 * DAY) && !(symbol === "S13" && date >= T0 + 700 * DAY);
const LOOKBACK = 400 * DAY;
const WINDOW = 300 * DAY;
const options = { costs: COST_PRESETS["futures-2026"].model, lots: {}, states: marketStates(benchmark) };
const between = (bars: DailyBar[], from: number, to: number) => bars.filter((bar) => bar.t >= from && bar.t <= to);

describe("cutting one block scan at each day", () => {
  it("equals each day's own scan from the day's first counted session", async () => {
    const blockFrom = T0 + 920 * DAY;
    const blockTo = T0 + (N - 1) * DAY;
    const readFrom = blockFrom - WINDOW - LOOKBACK;
    const block = { scan: await scanSignals({ symbols, getBars: (s) => between(data.get(s)!, readFrom, blockTo), benchmark: between(benchmark, readFrom, blockTo), isMember }), isMember };
    let cut = 0;
    let fellBack = 0;
    for (let d = 920; d < N; d += 7) {
      const day = T0 + d * DAY;
      const from = day - WINDOW;
      const input = { symbols, getBars: (s: string) => between(data.get(s)!, from - LOOKBACK, day), benchmark: between(benchmark, from - LOOKBACK, day), isMember };
      const own = await scanSignals(input);
      const fast = cutScan(block, input, day, from);
      if (!fast) {
        fellBack += 1;
        continue;
      }
      cut += 1;
      const first = Math.max(own.firstSignalDate ?? 0, from);
      expect(fast.firstSignalDate).toBe(own.firstSignalDate);
      expect(fast.dates).toEqual(own.dates);
      expect(fast.symbols).toBe(own.symbols);
      const counted = (scan: typeof own) => replaySignals(scan, options).filter((trade) => trade.date >= first);
      expect(counted(fast)).toEqual(counted(own));
    }
    expect(cut).toBeGreaterThan(10);
    // While S13 is listed, its suspension makes its 260-bar windows reach before a day's own look-back: those days scan from scratch.
    expect(fellBack).toBeGreaterThan(0);
  });

  it("refuses a block scanned with another membership", async () => {
    const day = T0 + 1050 * DAY;
    const from = day - WINDOW;
    const scan = await scanSignals({ symbols, getBars: (s) => between(data.get(s)!, from - LOOKBACK - 30 * DAY, T0 + (N - 1) * DAY), benchmark: between(benchmark, from - LOOKBACK - 30 * DAY, T0 + (N - 1) * DAY) });
    const input = { symbols, getBars: (s: string) => between(data.get(s)!, from - LOOKBACK, day), benchmark: between(benchmark, from - LOOKBACK, day), isMember };
    expect(cutScan({ scan }, input, day, from)).toBeNull();
  });
});
