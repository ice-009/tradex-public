import { describe, expect, it } from "vitest";
import { alertKey, inBtstWindow, mutedReason, pendingBtstAlerts } from "./btstAlerts";
import { SCREENS, type ScreenerRow } from "./screens";

// 2026-11-05 is a Thursday; IST = UTC + 5:30.
const ist = (h: number, m: number, date = "2026-11-05") => Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - 330) * 60_000;
const DAY = Date.parse("2026-11-05T00:00:00Z");
const row = (symbol: string, live = true) => ({ symbol, live, score: 50, close: 100, plan: { entry: 100, stop: 98, target: null, exit: "" } }) as unknown as ScreenerRow;
const good = { signals: 40, target: 0, stop: 10, open: 30, sumR: 4, avgR: 0.1 };

describe("BTST alerts", () => {
  it("only runs from 3:10 to 3:25 PM IST on weekdays", () => {
    expect(inBtstWindow(ist(15, 9))).toBe(false);
    expect(inBtstWindow(ist(15, 10))).toBe(true);
    expect(inBtstWindow(ist(15, 25))).toBe(true);
    expect(inBtstWindow(ist(15, 26))).toBe(false);
    expect(inBtstWindow(ist(15, 15, "2026-11-07"))).toBe(false); // Saturday
  });

  it("mutes a screen without a positive track record", () => {
    expect(mutedReason(undefined)).toMatch(/not loaded/);
    expect(mutedReason({ ...good, signals: 5 })).toMatch(/only 5/);
    expect(mutedReason({ ...good, avgR: -0.05 })).toMatch(/-0.05R/);
    expect(mutedReason({ ...good, avgR: 0.03 })).toMatch(/under the ~0.05R costs/);
    expect(mutedReason(good)).toBeNull();
  });

  it("flashes live, unbanned, not-yet-alerted matches of BTST screens with an edge", () => {
    const results = {
      "btst-closing-strength": [row("AAA"), row("BBB", false), row("CCC"), row("DDD")],
      "btst-20d-high": [row("EEE")],
      "swing-rsi2": [row("FFF")],
    };
    const pending = pendingBtstAlerts({
      screens: SCREENS,
      results,
      track: { "btst-closing-strength": good, "btst-20d-high": { ...good, avgR: -0.1 }, "swing-rsi2": good },
      banned: ["CCC"],
      alerted: new Set([alertKey(DAY, "btst-closing-strength", "DDD")]),
      now: ist(15, 12),
    });
    expect(pending.map((alert) => `${alert.screen.id}:${alert.row.symbol}`)).toEqual(["btst-closing-strength:AAA"]);
    expect(pendingBtstAlerts({ screens: SCREENS, results, track: { "btst-closing-strength": good }, banned: [], alerted: new Set(), now: ist(14, 0) })).toEqual([]);
  });
});
