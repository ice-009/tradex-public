import { describe, expect, it } from "vitest";
import { mergeTail, planHistoryFetch, mergeDailyBars } from "./history";

const DAY = 86_400_000;
const candle = (day: number, close: number) => ({ date: new Date(day * DAY).toISOString(), open: close, high: close, low: close, close, volume: 1 });

describe("incremental history", () => {
  const stored = { coveredFrom: 0, candles: [candle(0, 100), candle(1, 101), candle(2, 102)] };

  it("downloads in full when nothing (or too little) is stored", () => {
    expect(planHistoryFetch(null, 0, DAY)).toEqual({ kind: "full" });
    expect(planHistoryFetch({ ...stored, coveredFrom: 5 * DAY }, 0, DAY)).toEqual({ kind: "full" });
  });

  it("otherwise downloads only from just before the newest candle", () => {
    expect(planHistoryFetch(stored, 0, DAY)).toEqual({ kind: "tail", from: 1 * DAY });
  });

  it("replaces the forming candle and appends new ones", () => {
    const merged = mergeTail(stored.candles, [candle(1, 101), candle(2, 103), candle(3, 104)], 0)!;
    expect(merged.map((c) => c.close)).toEqual([100, 101, 103, 104]);
  });

  it("asks for a full download when closed history was adjusted (split)", () => {
    expect(mergeTail(stored.candles, [candle(1, 50.5), candle(2, 51), candle(3, 52)], 0)).toBeNull();
  });

  it("drops candles older than the window it keeps", () => {
    expect(mergeTail(stored.candles, [candle(2, 102), candle(3, 104)], 1 * DAY)!.map((c) => c.close)).toEqual([101, 102, 104]);
  });
});

describe("mergeDailyBars", () => {
  const day = (n: number) => n * 86_400_000;
  const bar = (n: number, c: number, dp?: number) => ({ t: day(n), o: c, h: c, l: c, c, v: 1, ...(dp === undefined ? {} : { dp }) });

  it("appends new sessions and replaces provisional ones, keeping a known delivery %", () => {
    const merged = mergeDailyBars([bar(1, 100, 40), bar(2, 101)], [bar(2, 101.5), bar(1, 100), bar(3, 102, 55)], 0.015);
    expect(merged).toEqual({ bars: [bar(1, 100, 40), bar(2, 101.5), bar(3, 102, 55)], changed: true });
  });

  it("reports no change when nothing differs", () => {
    expect(mergeDailyBars([bar(1, 100, 40)], [bar(1, 100, 40)], 0.015)).toEqual({ bars: [bar(1, 100, 40)], changed: false });
  });

  it("asks for a full re-read when a stored close moved (split or bonus)", () => {
    expect(mergeDailyBars([bar(1, 100), bar(2, 100)], [bar(2, 50), bar(3, 51)], 0.015)).toBeNull();
  });
});
