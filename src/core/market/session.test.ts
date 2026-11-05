import { describe, expect, it } from "vitest";
import { daysFromToday, isMarketOpen, istDayKey, istParts } from "./session";

// 2026-11-04 is a Wednesday. IST = UTC + 5:30.
const utc = (h: number, m: number, day = 4) => Date.UTC(2026, 10, day, h, m);

describe("IST session helpers", () => {
  it("uses the IST date, not the UTC date", () => {
    // 20:00 UTC on 3 Nov is already 01:30 IST on 4 Nov.
    expect(istParts(utc(20, 0, 3)).day).toBe(Date.UTC(2026, 10, 4));
    expect(istDayKey("2026-11-03T20:00:00Z")).toBe(Date.UTC(2026, 10, 4));
  });

  it("knows market hours (09:15–15:30 IST, weekdays)", () => {
    expect(isMarketOpen(utc(3, 44))).toBe(false); // 09:14
    expect(isMarketOpen(utc(3, 45))).toBe(true); // 09:15
    expect(isMarketOpen(utc(10, 0))).toBe(true); // 15:30
    expect(isMarketOpen(utc(10, 1))).toBe(false); // 15:31
    expect(isMarketOpen(Date.UTC(2026, 10, 7, 5, 0))).toBe(false); // Saturday
  });

  it("counts calendar days from the IST today", () => {
    expect(daysFromToday(Date.UTC(2026, 10, 6), utc(20, 0, 3))).toBe(2);
  });
});
