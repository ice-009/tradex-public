import { describe, expect, it } from "vitest";
import { COST_PRESETS } from "@/core/backtest/costs";
import { applySightings, liveRecordLine, liveSightings, settleEntry, summarizeLive, tradeQty, upsertEntry, type LiveEntry, type LiveTrade } from "./liveRecord";
import { SCREENS, type ScreenerRow } from "./screens";

// 2026-11-05 is a Thursday; IST = UTC + 5:30.
const ist = (h: number, m: number, date = "2026-11-05") => Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - 330) * 60_000;
const DAY = Date.parse("2026-11-05T00:00:00Z");
const NEXT = Date.parse("2026-11-06T00:00:00Z");
const row = (symbol: string, close: number, live = true) => ({ symbol, live, close, plan: { entry: close, stop: close - 2, target: null, exit: "" } }) as unknown as ScreenerRow;
const model = COST_PRESETS["futures-2026"].model;
const entry = (over: Partial<LiveEntry> = {}): LiveEntry => ({ screenId: "btst-closing-strength", symbol: "AAA", day: DAY, firstSeenAt: ist(15, 12), firstPrice: 100, entryAt: ist(15, 20), entryPrice: 100, stop: 98, ...over });
const bar = (t: number, o: number) => ({ t, o, h: o, l: o, c: o, v: 1 });

describe("BTST live record", () => {
  it("records live, unbanned matches of overnight screens only inside the window", () => {
    const results = {
      "btst-closing-strength": [row("AAA", 100), row("BBB", 50, false), row("CCC", 70)],
      "btst-20d-high": [row("DDD", 200)],
      "swing-rsi2": [row("EEE", 10)],
    };
    const seen = liveSightings({ screens: SCREENS, results, banned: new Set(["CCC"]), now: ist(15, 15) });
    expect(seen).toEqual([
      { screenId: "btst-closing-strength", symbol: "AAA", price: 100, stop: 98 },
      { screenId: "btst-20d-high", symbol: "DDD", price: 200, stop: 198 },
    ]);
    expect(liveSightings({ screens: SCREENS, results, banned: new Set(), now: ist(15, 26) })).toEqual([]);
    expect(liveSightings({ screens: SCREENS, results, banned: new Set(), now: ist(15, 9) })).toEqual([]);
  });

  it("keeps the first sighting and moves the entry to the latest in-window price", () => {
    const first = upsertEntry(undefined, { screenId: "btst-closing-strength", symbol: "AAA", price: 100, stop: 98 }, ist(15, 11))!;
    expect(first).toMatchObject({ day: DAY, firstSeenAt: ist(15, 11), firstPrice: 100, entryAt: ist(15, 11), entryPrice: 100, stop: 98 });
    const later = upsertEntry(first, { screenId: "btst-closing-strength", symbol: "AAA", price: 101.5, stop: 98.5 }, ist(15, 25))!;
    expect(later).toMatchObject({ firstSeenAt: ist(15, 11), firstPrice: 100, entryAt: ist(15, 25), entryPrice: 101.5, stop: 98.5 });
    // After 3:25 PM, too late to act: nothing changes.
    expect(upsertEntry(later, { screenId: "btst-closing-strength", symbol: "AAA", price: 103 }, ist(15, 26))).toBeNull();
    // A price alone never creates a record.
    expect(upsertEntry(undefined, { screenId: "btst-closing-strength", symbol: "AAA", price: 100 }, ist(15, 15))).toBeNull();
  });

  it("follows a setup's price after it stops matching, within the window", () => {
    const today = [entry({ symbol: "AAA" }), entry({ symbol: "BBB", entryPrice: 50, stop: 49 })];
    const changed = applySightings(today, [{ screenId: "btst-closing-strength", symbol: "AAA", price: 101, stop: 99 }, { screenId: "btst-20d-high", symbol: "NEW", price: 10, stop: 9.5 }], new Map([["AAA", 101], ["BBB", 49.5]]), ist(15, 22));
    expect(changed.map((item) => [item.symbol, item.entryPrice, item.stop])).toEqual([
      ["AAA", 101, 99],
      ["NEW", 10, 9.5],
      ["BBB", 49.5, 49],
    ]);
  });

  it("settles at the next session's open, net of the cost model", () => {
    expect(settleEntry(entry(), [bar(DAY, 99)], model, 100)).toBeNull();
    const won = settleEntry(entry(), [bar(DAY - 86_400_000, 90), bar(DAY, 99), bar(NEXT, 102)], model, 500)!;
    expect(won.exitDay).toBe(NEXT);
    expect(won.exitPrice).toBe(102);
    expect(won.grossPct).toBeCloseTo(2, 10);
    // 0.05% slippage a leg + ₹20×2 brokerage, STT 0.05% on the sell, small fees: about 0.2% off.
    expect(won.netPct).toBeLessThan(won.grossPct - 0.15);
    expect(won.netPct).toBeGreaterThan(won.grossPct - 0.25);
    expect(won.gapStop).toBe(false);
    const gapped = settleEntry(entry(), [bar(NEXT, 97)], model, 500)!;
    expect(gapped.gapStop).toBe(true);
    expect(gapped.grossPct).toBeCloseTo(-3, 10);
    expect(settleEntry(entry(), [bar(NEXT, 102)], COST_PRESETS.none.model, 500)!.netPct).toBeCloseTo(2, 10);
  });

  it("sizes one lot when known, else about ₹5 lakh of shares", () => {
    expect(tradeQty(2500, 250)).toBe(250);
    expect(tradeQty(2500, null)).toBe(200);
    expect(tradeQty(0, undefined)).toBe(1);
  });

  it("aggregates settled trades per overnight screen", () => {
    const settled = (net: number, gross: number, gapStop = false) => ({ exitDay: NEXT, exitPrice: 100, grossPct: gross, netPct: net, gapStop });
    const trades: LiveTrade[] = [
      { ...entry({ day: DAY - 86_400_000 }), settled: settled(1, 1.2) },
      { ...entry({ symbol: "BBB" }), settled: settled(-0.5, -0.3, true) },
      { ...entry({ symbol: "CCC" }), settled: null },
      { ...entry({ screenId: "swing-rsi2" }), settled: settled(5, 5) },
    ];
    const record = summarizeLive(trades, SCREENS, DAY);
    expect(Object.keys(record)).toEqual(["btst-closing-strength", "btst-20d-high"]);
    expect(record["btst-closing-strength"]).toMatchObject({ since: DAY - 86_400_000, trades: 2, pending: 1, winShare: 0.5, gapStops: 1 });
    expect(record["btst-closing-strength"].avgNetPct).toBeCloseTo(0.25, 10);
    expect(record["btst-closing-strength"].avgGrossPct).toBeCloseTo(0.45, 10);
    expect(record["btst-20d-high"]).toEqual({ screenId: "btst-20d-high", since: DAY, trades: 0, pending: 0, avgNetPct: null, avgGrossPct: null, winShare: null, gapStops: 0 });

    expect(liveRecordLine(record["btst-closing-strength"])).toBe("Live since 4 Nov: 2 trades, avg net +0.25%, win 50% (+1 waiting for the next open)");
    expect(liveRecordLine(record["btst-20d-high"])).toBe("Live since 5 Nov: 0 trades");
    expect(liveRecordLine(undefined)).toMatch(/nothing recorded yet/);
  });
});
