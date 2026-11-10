import { describe, expect, it } from "vitest";
import { resampleIntraday } from "./aggregate";

const MIN = 60_000;
/** 09:15 IST on 2026-11-09 (03:45 UTC). */
const OPEN = Date.UTC(2026, 10, 9, 3, 45);
const bar = (offsetMin: number, close: number, volume = 1) => ({ date: new Date(OPEN + offsetMin * MIN).toISOString(), open: close, high: close + 1, low: close - 1, close, volume });

describe("resampleIntraday", () => {
  it("buckets from the 09:15 session open, stamped with each bucket's start", () => {
    const hours = [0, 60, 120, 180, 240, 300, 360].map((offset, index) => bar(offset, 100 + index, 10));
    const twoHour = resampleIntraday(hours, 120);
    expect(twoHour.map((candle) => candle.date)).toEqual([0, 120, 240, 360].map((offset) => new Date(OPEN + offset * MIN).toISOString()));
    expect(twoHour[0]).toEqual({ date: new Date(OPEN).toISOString(), open: 100, high: 102, low: 99, close: 101, volume: 20 });
    expect(twoHour[3].close).toBe(106); // 15:15 alone
  });

  it("keeps days apart and accepts unsorted input", () => {
    const nextDay = 24 * 60;
    const candles = resampleIntraday([bar(nextDay + 5, 3), bar(0, 1), bar(nextDay, 2), bar(5, 4)], 10);
    expect(candles.map((candle) => [candle.date, candle.open, candle.close])).toEqual([
      [new Date(OPEN).toISOString(), 1, 4],
      [new Date(OPEN + nextDay * MIN).toISOString(), 2, 3],
    ]);
  });
});
