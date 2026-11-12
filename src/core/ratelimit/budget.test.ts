import { describe, expect, it } from "vitest";
import { BROKER_PLANS, freshCaps, shareOfCaps, sweepIntervalMs } from "./budget";

describe("sweepIntervalMs", () => {
  it("spreads a 9-call sweep over a full Standard session", () => {
    // 436 instruments = 9 quote calls; background day share = 3,325; 375 minutes.
    const ms = sweepIntervalMs({ requestsPerSweep: 9, remainingToday: 3_325, minutesLeft: 375, backgroundPerMinute: 20 })!;
    expect(ms).toBeGreaterThanOrEqual(60_000);
    expect(ms).toBeLessThan(120_000);
    // Never more than the sweep's share of the minute.
    expect((9 * 60_000) / ms).toBeLessThanOrEqual(20 * 0.6);
  });

  it("speeds up when there's budget to spare late in the day", () => {
    const early = sweepIntervalMs({ requestsPerSweep: 9, remainingToday: 3_325, minutesLeft: 375, backgroundPerMinute: 20 })!;
    const late = sweepIntervalMs({ requestsPerSweep: 9, remainingToday: 3_000, minutesLeft: 30, backgroundPerMinute: 20 })!;
    expect(late).toBeLessThan(early);
  });

  it("stops when the day's budget is spent", () => {
    expect(sweepIntervalMs({ requestsPerSweep: 9, remainingToday: 10, minutesLeft: 100, backgroundPerMinute: 20 })).toBeNull();
  });
});

describe("shareOfCaps", () => {
  it("gives each priority its share of the hub's day and minute", () => {
    const caps = freshCaps(BROKER_PLANS.standard);
    expect(caps).toEqual({ dayCap: 4_750, usedToday: 0, minuteCap: 40 });
    expect(shareOfCaps(caps, "background")).toEqual({ remainingToday: 3_325, perMinute: 20 });
    expect(shareOfCaps(caps, "user")).toEqual({ remainingToday: 4_750, perMinute: 40 });
    expect(shareOfCaps({ ...caps, usedToday: 4_000 }, "background").remainingToday).toBe(0);
  });
});
