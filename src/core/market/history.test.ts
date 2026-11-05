import { describe, expect, it } from "vitest";
import { mergeTail, planHistoryFetch } from "./history";

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
