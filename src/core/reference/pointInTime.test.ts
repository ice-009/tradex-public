import { describe, expect, it } from "vitest";
import { pointInTimeLots } from "@/core/backtest/lots";
import { pointInTimeUniverse } from "@/core/backtest/universe";
import type { IndexCatalog } from "@/core/screener/sectorIndex";
import { adjustAsOf, laterFactor, orElse, referenceTimeline, tickerOn, type ReferenceHistory } from "./pointInTime";

const d = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const TODAY = d("2026-11-20");

const catalog: IndexCatalog = {
  available: true,
  indices: [
    { symbol: "NIFTYIT", name: "NIFTY IT", synthetic: false, firstDay: d("2012-01-02"), lastDay: d("2026-11-19") },
    { symbol: "NIFTYPSE", name: "NIFTY PSE", synthetic: false, firstDay: d("2020-01-01"), lastDay: d("2026-11-19") },
  ],
  sectors: [{ industry: "Information Technology", indices: ["NIFTYIT"], basket: "EW-IT" }],
};

function history(overrides: Partial<ReferenceHistory> = {}): ReferenceHistory {
  return {
    today: TODAY,
    fo: {
      byDay: new Map([
        [d("2024-06-03"), new Set(["RELIANCE", "OLDCO"])],
        [d("2024-10-25"), new Set(["RELIANCE", "SBIN"])],
        [d("2024-10-28"), new Set(["RELIANCE", "SBIN"])],
        [d("2026-11-19"), new Set(["RELIANCE", "SBIN", "NEWCO"])],
      ]),
      span: { from: d("2024-06-01"), to: TODAY },
      stored: null,
    },
    lots: {
      changes: new Map([
        ["RELIANCE", [{ day: d("2024-07-08"), lot: 250 }, { day: d("2024-10-28"), lot: 500 }]],
        ["SBIN", [{ day: d("2024-07-08"), lot: 1500 }, { day: d("2024-12-27"), lot: 750 }]],
        ["OLDCO", [{ day: d("2024-07-08"), lot: 1000 }]],
      ]),
      knownFrom: d("2024-07-08"),
      lastDay: d("2026-11-19"),
      current: { RELIANCE: 500, SBIN: 750, NEWCO: 300 },
    },
    ban: { byDay: new Map([[d("2026-11-18"), ["KAYNES"]], [d("2026-11-19"), []]]), knownFrom: d("2026-11-11"), current: { tradeDate: d("2026-11-21"), symbols: ["IEX"] } },
    results: {
      events: [
        { symbol: "TCS", company: "TCS", date: d("2024-10-24"), purpose: "Financial Results" },
        { symbol: "INFY", company: "Infosys", date: d("2024-11-05"), purpose: "Financial Results" },
      ],
      span: { from: d("2024-10-01"), to: d("2024-12-31") },
    },
    catalog,
    universes: new Map([
      ["fno", [{ symbol: "RELIANCE", name: "Reliance", industry: "Oil Gas" }, { symbol: "SBIN", name: "SBI", industry: "Financial Services" }]],
      ["nifty50", [{ symbol: "RELIANCE", name: "Reliance", industry: "Oil Gas" }]],
    ]),
    renames: [
      { day: d("2011-06-16"), oldSymbol: "INFOSYSTCH", newSymbol: "INFY" },
      { day: d("2025-10-14"), oldSymbol: "TATAMOTORS", newSymbol: "TMPV" },
    ],
    // RELIANCE: 1:1 bonus, ex 28 Oct 2024 (prices before × 0.5).
    factors: new Map([
      ["RELIANCE", [{ day: d("2024-10-28"), factor: 0.5 }]],
      ["SBIN", []],
    ]),
    ...overrides,
  };
}

describe("asOf: the F&O list", () => {
  const timeline = referenceTimeline(history());

  it("is the day's file, or the file before a holiday (at most a week)", () => {
    const list = timeline.at(d("2024-10-28")).foList;
    expect(list.known && [...list.value]).toEqual(["RELIANCE", "SBIN"]);
    const weekend = timeline.at(d("2024-10-27")).foList;
    expect(weekend).toMatchObject({ known: true, asOf: d("2024-10-25") });
  });

  it("is unknown — not today's list — on a gap, before the span and in the future", () => {
    expect(timeline.at(d("2025-06-02")).foList).toMatchObject({ known: false, reason: expect.stringMatching(/no F&O bhavcopy for 2 Jun 2025/) });
    expect(timeline.at(d("2020-01-01")).foList).toMatchObject({ known: false, reason: expect.stringMatching(/wasn't read/) });
    expect(timeline.at(d("2026-11-23")).foList).toMatchObject({ known: false, reason: expect.stringMatching(/after today/) });
  });

  it("drives the point-in-time universe, falling back to today's list only where unknown", () => {
    const listOn = (day: number) => {
      const list = timeline.at(day).foList;
      return list.known ? list.value : null;
    };
    const pit = pointInTimeUniverse({ byDay: timeline.history.fo.byDay, today: ["RELIANCE", "SBIN", "NEWCO"], listOn });
    expect(pit.isMember("OLDCO", d("2024-06-04"))).toBe(true); // the file the day before
    expect(pit.isMember("NEWCO", d("2024-10-28"))).toBe(false);
    expect(pit.isMember("NEWCO", d("2025-06-02"))).toBe(true); // unknown: today's list
  });
});

describe("asOf: lot sizes", () => {
  const timeline = referenceTimeline(history());

  it("are that day's (as traded), only for that day's F&O stocks", () => {
    expect(timeline.at(d("2024-10-25")).lots).toMatchObject({ known: true, value: { RELIANCE: 250, SBIN: 1500 } });
    expect(timeline.at(d("2024-10-28")).lots).toMatchObject({ known: true, value: { RELIANCE: 500, SBIN: 1500 } });
  });

  it("are today's lot file today, and unknown before NSE's files carried them", () => {
    expect(timeline.at(TODAY).lots).toMatchObject({ known: true, value: { NEWCO: 300 }, source: expect.stringMatching(/today's/) });
    expect(timeline.at(d("2024-06-03")).lots).toEqual({ known: false, reason: "Lot sizes are known from 8 Jul 2024 (NSE's F&O files before then don't carry them).", knownFrom: d("2024-07-08") });
    expect(orElse(timeline.at(d("2024-06-03")).lots, { SBIN: 750 })).toEqual({ SBIN: 750 });
  });

  it("convert to today-adjusted shares across a later bonus", () => {
    // 250 shares before the 1:1 bonus are 500 of today's (adjusted) shares.
    expect(timeline.at(d("2024-10-25")).lotInTodayShares("RELIANCE")).toMatchObject({ known: true, value: 500 });
    expect(timeline.at(d("2024-10-25")).lotInTodayShares("SBIN")).toMatchObject({ known: true, value: 1500 });
    expect(timeline.at(d("2024-10-25")).lotInTodayShares("NEWCO")).toMatchObject({ known: false });
  });

  it("size backtests with the day's lot, today's as the stand-in, and say on how many sessions", () => {
    const lots = pointInTimeLots(timeline, { RELIANCE: 500, SBIN: 750, NEWCO: 300 });
    expect(lots.lotOn("SBIN", d("2024-10-25"))).toBe(1500);
    expect(lots.lotOn("SBIN", d("2024-06-03"))).toBe(750); // before lots are known: today's
    expect(lots.lotOn("NEWCO", d("2024-10-25"))).toBe(300); // not F&O that day: today's
    expect(lots.lotOn("NOPE", d("2024-10-25"))).toBeNull();
    expect(lots.note([d("2024-06-03"), d("2024-10-25"), d("2024-10-28")])).toBe(
      "Lot sizes: as listed on each day (NSE F&O bhavcopy) on 2 of 3 sessions (25 Oct 2024 – 28 Oct 2024); today's lot sizes on the other 1, where the day's isn't known.",
    );
    expect(lots.note([d("2024-06-03")])).toMatch(/today's for every session.*from 8 Jul 2024/);
  });
});

describe("asOf: prices, tickers, ban list, results, sectors", () => {
  const timeline = referenceTimeline(history());

  it("adjust prices only for actions that had happened by then", () => {
    expect(laterFactor([{ day: d("2024-10-28"), factor: 0.5 }], d("2024-10-25"))).toBe(0.5);
    const bars = [
      { t: d("2024-10-25"), o: 1300, h: 1310, l: 1290, c: 1305, v: 2000 },
      { t: d("2024-10-28"), o: 1310, h: 1320, l: 1300, c: 1315, v: 1000 },
    ];
    // As adjusted on 25 Oct 2024 (before the bonus): the price as traded then.
    expect(adjustAsOf(bars, [{ day: d("2024-10-28"), factor: 0.5 }], d("2024-10-25"))).toEqual([{ t: d("2024-10-25"), o: 2600, h: 2620, l: 2580, c: 2610, v: 1000 }]);
    expect(adjustAsOf(bars, [{ day: d("2024-10-28"), factor: 0.5 }], d("2024-10-28"))).toEqual(bars);
    expect(timeline.at(d("2024-10-25")).priceScale("RELIANCE")).toMatchObject({ known: true, value: 2 });
    expect(timeline.at(d("2024-10-28")).priceScale("RELIANCE")).toMatchObject({ known: true, value: 1 });
    expect(timeline.at(d("2024-10-25")).priceScale("TCS")).toMatchObject({ known: false });
  });

  it("names tickers as they were then", () => {
    expect(tickerOn(timeline.history.renames!, "INFY", d("2005-01-03"))).toBe("INFOSYSTCH");
    expect(timeline.at(d("2025-10-13")).ticker("TMPV")).toMatchObject({ known: true, value: "TATAMOTORS" });
    expect(timeline.at(d("2025-10-14")).ticker("TMPV")).toMatchObject({ known: true, value: "TMPV" });
    expect(referenceTimeline(history({ renames: null })).at(TODAY).ticker("TMPV")).toMatchObject({ known: false });
  });

  it("gives the ban list of that trade date only; today the newest", () => {
    expect(timeline.at(d("2026-11-18")).ban).toMatchObject({ known: true, value: ["KAYNES"] });
    expect(timeline.at(d("2026-11-19")).ban).toMatchObject({ known: true, value: [] });
    expect(timeline.at(d("2026-11-17")).ban).toMatchObject({ known: false, reason: expect.stringMatching(/no F&O ban list stored for 17 Nov 2026/) });
    expect(timeline.at(d("2024-10-25")).ban).toMatchObject({ known: false, knownFrom: d("2026-11-11") });
    expect(timeline.at(TODAY).ban).toMatchObject({ known: true, value: ["IEX"], asOf: d("2026-11-21") });
  });

  it("knows results already reported, not which later ones had been announced", () => {
    const then = timeline.at(d("2024-10-28")).results;
    expect(then.reported).toMatchObject({ known: true, value: [{ symbol: "TCS" }] });
    expect(then.upcoming).toMatchObject({ known: false, reason: expect.stringMatching(/first announced/) });
  });

  it("lists only the indices with history by then; industries are today's only", () => {
    const then = timeline.at(d("2015-06-01"));
    expect(then.sectors.known && then.sectors.value.indices.map((entry) => entry.symbol)).toEqual(["NIFTYIT"]);
    expect(then.industries).toMatchObject({ known: false });
    expect(timeline.at(TODAY).industries).toMatchObject({ known: true });
  });

  it("gives today's universes today; the F&O universe of a past day from its file; no past index constituents", () => {
    expect(timeline.at(TODAY).universe("nifty50")).toMatchObject({ known: true, value: [{ symbol: "RELIANCE" }] });
    expect(timeline.at(d("2024-06-03")).universe("fno")).toMatchObject({ known: true, value: [{ symbol: "OLDCO", name: "OLDCO" }, { symbol: "RELIANCE", name: "Reliance", industry: "Oil Gas" }] });
    expect(timeline.at(d("2024-06-03")).universe("nifty50")).toMatchObject({ known: false });
  });
});
