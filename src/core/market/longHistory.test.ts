import { describe, expect, it } from "vitest";
import { ARCHIVE_START, MARKET_PHASES, STORE_DAYS, clampToArchive, isLongRange, phaseById, storeStart } from "@/core/backtest/phases";
import type { Bar, DailyBar } from "@/core/types";
import { historyGaps, spliceBenchmark } from "./longHistory";
import { hasOlderBars, olderRequest, olderWindow, prependOlder } from "./olderBars";
import { DAY_MS } from "./session";

const d = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const daily = (iso: string, c: number): DailyBar => ({ t: d(iso), o: c, h: c, l: c, c, v: 1 });
const bar = (iso: string, close = 1): Bar => ({ time: d(iso), open: close, high: close, low: close, close, volume: 1 });

describe("market phases and long ranges", () => {
  it("offers the four phases, oldest first, and tells a long period from the stored 5 years", () => {
    expect(MARKET_PHASES.map((p) => p.label)).toEqual(["2008 crash", "2010–13 sideways", "2020 Covid crash", "2021–26"]);
    expect(phaseById("crash-2008")).toMatchObject({ from: d("2008-01-01"), to: d("2009-03-31") });
    expect(phaseById("recent-2021")!.to).toBeNull();
    const today = d("2026-11-20");
    expect(storeStart(today)).toBe(today - STORE_DAYS * DAY_MS);
    expect(isLongRange(null, today)).toBe(false); // the default run: the store's 5 years
    expect(isLongRange(storeStart(today), today)).toBe(false);
    expect(isLongRange(d("2021-01-01"), today)).toBe(true);
    expect(clampToArchive(d("1990-01-01"))).toBe(ARCHIVE_START);
    expect(new Date(ARCHIVE_START).toISOString().slice(0, 10)).toBe("1994-11-03");
  });
});

describe("history continuity (ice-009/tradex-public#16)", () => {
  const calendar = ["2011-06-27", "2011-06-28", "2011-06-29", "2011-06-30", "2011-07-01"].map(d);

  it("finds the sessions a series lacks inside its own span", () => {
    // One company across its rename (INFOSYSTCH until 28 Jun 2011, INFY from the 29th), as the hub serves it: no gap.
    const joined = ["2011-06-27", "2011-06-28", "2011-06-29", "2011-06-30", "2011-07-01"].map((iso, i) => daily(iso, 2800 + i));
    expect(historyGaps(joined, calendar)).toEqual([]);
    // Without the join the new ticker's history starts on the 29th: from there it is continuous, but the old half is missing.
    const broken = [daily("2011-06-27", 2800), daily("2011-07-01", 2804)];
    expect(historyGaps(broken, calendar)).toEqual([d("2011-06-28"), d("2011-06-29"), d("2011-06-30")]);
    // Sessions before a listing or after a delisting aren't gaps.
    expect(historyGaps([daily("2011-06-29", 1), daily("2011-06-30", 1)], calendar)).toEqual([]);
  });

  it("puts NIFTY's stand-in in front of it, scaled to meet it", () => {
    const nifty = [daily("2012-01-02", 4636.75), daily("2012-01-03", 4765.3)];
    const basket = [daily("2011-12-29", 900), daily("2011-12-30", 910), daily("2012-01-02", 927.35)];
    const spliced = spliceBenchmark(nifty, basket);
    expect(spliced.standInUntil).toBe(d("2011-12-30"));
    expect(spliced.bars.map((b) => b.t)).toEqual([d("2011-12-29"), d("2011-12-30"), d("2012-01-02"), d("2012-01-03")]);
    expect(spliced.bars[1].c).toBeCloseTo((910 * 4636.75) / 927.35, 1); // the basket's move, at NIFTY's level
    expect(spliceBenchmark(nifty, [])).toEqual({ bars: nifty, standInUntil: null });
    expect(spliceBenchmark([], basket).standInUntil).toBe(d("2012-01-02"));
  });
});

describe("older bars for a chart scrolled left", () => {
  it("asks daily charts ten years further back and weekly or monthly ones back to 1994", () => {
    const bars = [bar("2021-11-24"), bar("2021-11-25")];
    expect(olderRequest(bars, "days")).toEqual({ from: d("2021-11-24") - 3650 * DAY_MS, to: d("2021-11-24") });
    // The first weekly bar may be a part-week: asked for again, whole.
    expect(olderRequest([bar("2021-11-22"), bar("2021-11-29")], "weeks")).toEqual({ from: ARCHIVE_START, to: d("2021-11-29") });
    expect(olderRequest([bar("1994-11-03")], "days")).toBeNull();
    expect(olderRequest([], "days")).toBeNull();
    expect(prependOlder([bar("2021-11-22", 5), bar("2021-11-29", 6)], [bar("2021-11-15", 3), bar("2021-11-22", 4)], d("2021-11-29")).map((b) => b.close)).toEqual([3, 4, 6]);
  });

  it("says when older bars may exist, and checks what the browser asks for", () => {
    const from = d("2016-11-20");
    expect(hasOlderBars([{ date: "2016-11-21T00:00:00.000Z" }], from)).toBe(true);
    expect(hasOlderBars([{ date: "2019-03-01T00:00:00.000Z" }], from)).toBe(false); // listed later, or the hub has nothing older
    expect(hasOlderBars([{ date: "1994-11-03T00:00:00.000Z" }], ARCHIVE_START)).toBe(false);
    expect(hasOlderBars([], from)).toBe(false);
    expect(olderWindow(String(d("1980-01-01")), String(d("2000-01-01")))).toEqual({ from: ARCHIVE_START, to: d("2000-01-01") });
    expect(olderWindow("abc", "1")).toBeNull();
    expect(olderWindow(String(d("2001-01-01")), String(d("2000-01-01")))).toBeNull();
    expect(olderWindow(null, null)).toBeNull();
  });
});
