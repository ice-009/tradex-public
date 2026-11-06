import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/core/types";
import { rAt, trackTrade, withLivePrice, type TrackedTrade } from "./tracker";

const DAY = 86_400_000;
// Monday 2 Nov 2026 (IST day key) and IST clock times on it.
const MON = Date.UTC(2026, 10, 2);
const at = (day: number, hh: number, mm = 0) => day + (hh * 60 + mm) * 60_000 - 5.5 * 3_600_000;
const bar = (day: number, c: number, extra: Partial<DailyBar> = {}): DailyBar => ({ t: day, o: c, h: c + 1, l: c - 1, c, v: 1, ...extra });
const trade = (patch: Partial<TrackedTrade> = {}): TrackedTrade => ({ entryPrice: 100, plannedEntry: 100, stop: 95, target: 110, exitRule: "stop-target", holdSessions: 10, entryDay: MON, ...patch });

describe("open trade tracker", () => {
  it("tells a BTST trade to hold overnight, then to sell at the open", () => {
    const btst = trade({ exitRule: "next-open", holdSessions: 1, target: null });
    const history = [bar(MON, 100)];
    expect(trackTrade(btst, history, at(MON, 15, 25)).action).toBe("overnight");
    const morning = trackTrade(btst, history, at(MON + DAY, 8, 50));
    expect(morning).toMatchObject({ action: "sell-open", text: "Sell at today's open", urgent: true });
    expect(trackTrade(btst, history, at(MON + DAY, 10, 0)).text).toMatch(/Sell now/);
  });

  it("counts the sessions of the hold and the R at the live price", () => {
    const history = [bar(MON, 100), bar(MON + DAY, 101), bar(MON + 2 * DAY, 102)];
    const track = trackTrade(trade(), history, at(MON + 3 * DAY, 11, 0), 105);
    expect(track.session).toBe(3);
    expect(track.r).toBeCloseTo(1, 6);
    expect(track.action).toBe("hold");
    // Before the open the last close is used and today doesn't count yet.
    expect(trackTrade(trade(), history, at(MON + 3 * DAY, 8, 0))).toMatchObject({ session: 2, live: false, price: 102 });
    expect(rAt(trade({ entryPrice: 101 }), 106)).toBeCloseTo(1, 6);
  });

  it("flags a stop or target that was hit", () => {
    const stopped = [bar(MON, 100), bar(MON + DAY, 96, { l: 94.5 })];
    expect(trackTrade(trade(), stopped, at(MON + 2 * DAY, 9, 0)).action).toBe("stop");
    const won = [bar(MON, 100), bar(MON + DAY, 109, { h: 111 })];
    expect(trackTrade(trade(), won, at(MON + 2 * DAY, 9, 0)).action).toBe("target");
    expect(trackTrade(trade(), [bar(MON, 100)], at(MON + DAY, 11, 0), 94).action).toBe("stop");
  });

  it("says when the time exit is due", () => {
    const short = trade({ holdSessions: 2, target: null, exitRule: "time" });
    const history = [bar(MON, 100), bar(MON + DAY, 101)];
    expect(trackTrade(short, history, at(MON + 2 * DAY, 12, 0)).text).toBe("Time exit: sell at today's close (3:15–3:30 PM)");
    expect(trackTrade(short, [...history, bar(MON + 2 * DAY, 101)], at(MON + 3 * DAY, 8, 0)).action).toBe("time");
  });

  it("shows the trailing level and exits on a close below it", () => {
    const turtle = trade({ exitRule: "trail-low:10", holdSessions: 25, target: null, stop: 80 });
    const before = Array.from({ length: 10 }, (_, i) => bar(MON - (10 - i) * DAY, 95 + i, { l: 90 + i }));
    const holding = trackTrade(turtle, [...before, bar(MON, 100, { l: 99 })], at(MON + DAY, 11, 0), 101);
    expect(holding.trailStop).toBe(91);
    expect(holding.text).toBe("Hold · trail stop now 91.00");
    const broke = trackTrade(turtle, [...before, bar(MON, 100, { l: 99 }), bar(MON + DAY, 90, { l: 89.5 })], at(MON + 2 * DAY, 8, 0));
    expect(broke.action).toBe("trail");
  });

  it("re-checks a stored track against the live price", () => {
    const stored = trackTrade(trade(), [bar(MON, 100)], at(MON + DAY, 8, 0));
    expect(stored.action).toBe("hold");
    expect(withLivePrice(stored, trade(), 94)).toMatchObject({ action: "stop", urgent: true, live: true });
    expect(withLivePrice(stored, trade(), 111).action).toBe("target");
    expect(withLivePrice(stored, trade(), 102)).toMatchObject({ action: "hold", r: 0.4 });
    expect(withLivePrice(stored, trade(), null)).toBe(stored);
  });
});
