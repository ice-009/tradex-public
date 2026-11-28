import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/core/types";
import {
  MIN_SAMPLE,
  checkEntry,
  checkSize,
  checkStop,
  coachReport,
  differenceInterval,
  meanInterval,
  measureExcursion,
  planExit,
  reviewTrade,
  stopAtEntry,
  tCritical95,
  type Candle,
  type CoachTrade,
  type TradeBars,
} from "./coach";

// Synthetic journals: weekdays in Nov 2026, prices around 100, risk 5 (stop 95).

const DAY = 86_400_000;
const d = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
/** Epoch ms of an IST clock time on a day key. */
const at = (day: number, hh: number, mm: number) => day + (hh * 60 + mm - 330) * 60_000;
const bar = (t: number, o: number, h: number, l: number, c: number): DailyBar => ({ t, o, h, l, c, v: 1000 });

const MON = d("2026-11-02");
const TUE = MON + DAY;
const WED = MON + 2 * DAY;
const THU = MON + 3 * DAY;
const FRI = MON + 4 * DAY;
const NEXT_MON = MON + 7 * DAY;
const LATER = at(d("2027-03-01"), 18, 0);

const trade = (patch: Partial<CoachTrade> = {}): CoachTrade => ({
  id: "t1",
  symbol: "TCS",
  screenId: "res-drift",
  status: "closed",
  plannedEntry: 100,
  stop: 95,
  target: 115,
  exitRule: "stop-target",
  holdSessions: 10,
  entryKind: "close",
  entryPrice: 100,
  entryAt: at(MON, 15, 20),
  entryTimed: true,
  lots: 1,
  planLots: 1,
  exitPrice: 104,
  exitAt: at(THU, 15, 25),
  audited: true,
  changes: [],
  ...patch,
});

// Entry Monday (range 97–101, closes 100), low of the trade Tuesday (96), high Wednesday (108), exit Thursday.
const WEEK: DailyBar[] = [
  bar(MON - 3 * DAY, 99, 100, 98, 99),
  bar(MON, 99, 101, 97, 100),
  bar(TUE, 100, 101, 96, 98),
  bar(WED, 98, 108, 97, 107),
  bar(THU, 107, 107.5, 103, 104),
  bar(FRI, 104, 105, 102, 103),
];
const daily = (bars: DailyBar[] = WEEK): TradeBars => ({ daily: bars, intraday: null, intradayWhy: "older than the hub's year of intraday candles" });

describe("statistics", () => {
  it("has Student's t quantiles for a 95% interval", () => {
    expect(tCritical95(1)).toBeCloseTo(12.706, 3);
    expect(tCritical95(10)).toBeCloseTo(2.228, 3);
    expect(tCritical95(10.8)).toBeCloseTo(2.228, 3); // Welch df round down
    expect(tCritical95(60)).toBeCloseTo(2.0003, 2);
    expect(tCritical95(1000)).toBeCloseTo(1.962, 2);
    expect(tCritical95(0)).toBe(Infinity);
  });

  it("gives a mean with a t interval, and a Welch difference", () => {
    const stat = meanInterval([1, 2, 3, 4, 5])!;
    expect(stat.mean).toBe(3);
    // sd 1.5811, se 0.7071, t(4) 2.776
    expect(stat.ci![0]).toBeCloseTo(3 - 2.776 * 0.70711, 3);
    expect(stat.ci![1]).toBeCloseTo(3 + 2.776 * 0.70711, 3);
    expect(meanInterval([2])).toEqual({ n: 1, mean: 2, ci: null });
    expect(meanInterval([])).toBeNull();
    const diff = differenceInterval([1, 2, 3, 4, 5], [0, 1, 2, 3, 4])!;
    expect(diff.mean).toBeCloseTo(1, 9);
    expect(diff.ci![0]).toBeLessThan(0);
    expect(diff.ci![1]).toBeGreaterThan(2);
    expect(differenceInterval([1], [1, 2])).toBeNull();
  });
});

describe("MAE / MFE", () => {
  it("gives bounds from daily bars: the sessions between, then the whole entry and exit days", () => {
    const { excursion } = measureExcursion(trade(), daily(), 5, LATER);
    expect(excursion!.resolution).toBe("daily");
    // Between entry and exit: Tue low 96, Wed high 108 (and the fills, 100 and 104).
    expect(excursion!.mae.low).toBeCloseTo(0.8, 9);
    expect(excursion!.mfe.low).toBeCloseTo(1.6, 9);
    // With the whole entry day (low 97) and exit day (high 107.5): no wider here.
    expect(excursion!.mae.high).toBeCloseTo(0.8, 9);
    expect(excursion!.mfe.high).toBeCloseTo(1.6, 9);
    expect(excursion!.captured).toBeCloseTo(0.8, 9);
    expect(excursion!.efficiency!.low).toBeCloseTo(0.5, 9);
    expect(excursion!.note).toMatch(/^Daily bars \(older than the hub's year/);
  });

  it("counts the partial entry and exit days only in the outer bound", () => {
    const bars = [bar(MON, 99, 101, 90, 100), bar(TUE, 100, 112, 97, 102)];
    const { excursion } = measureExcursion(trade({ exitAt: at(TUE, 10, 0), exitPrice: 102 }), daily(bars), 5, LATER);
    // No full session between: inside, only the two fills (100 → 102).
    expect(excursion!.mae).toEqual({ low: 0, high: 2 });
    expect(excursion!.mfe.low).toBeCloseTo(0.4, 9);
    expect(excursion!.mfe.high).toBeCloseTo(2.4, 9);
  });

  it("uses intraday candles when they cover every session, exact outside the entry and exit candles", () => {
    const candles: Candle[] = [];
    for (const day of [MON, TUE, WED, THU]) for (let k = 0; k < 25; k += 1) candles.push({ t: at(day, 9, 15) + k * 15 * 60_000, o: 100, h: 101, l: 99, c: 100 });
    // The entry candle (3:15–3:30 PM Monday) dipped to 97 before the 3:20 entry; Tuesday 11:00 went to 96.5; Wednesday 1:00 to 106.
    const entryCandle = candles.find((candle) => candle.t === at(MON, 15, 15))!;
    entryCandle.l = 97;
    candles.find((candle) => candle.t === at(TUE, 11, 0))!.l = 96.5;
    candles.find((candle) => candle.t === at(WED, 13, 0))!.h = 106;
    const bars: TradeBars = { daily: WEEK, intraday: { minutes: 15, candles }, intradayWhy: null };
    const { excursion } = measureExcursion(trade(), bars, 5, LATER);
    expect(excursion!.resolution).toBe("intraday");
    expect(excursion!.minutes).toBe(15);
    expect(excursion!.mae.low).toBeCloseTo(0.7, 9);
    expect(excursion!.mae.high).toBeCloseTo(0.7, 9);
    expect(excursion!.mfe.low).toBeCloseTo(1.2, 9);
    expect(excursion!.note).toMatch(/15-minute candles/);
  });

  it("falls back to daily bars when the intraday candles miss a session", () => {
    const candles: Candle[] = [{ t: at(MON, 15, 15), o: 100, h: 101, l: 99, c: 100 }];
    const { excursion } = measureExcursion(trade(), { daily: WEEK, intraday: { minutes: 15, candles }, intradayWhy: null }, 5, LATER);
    expect(excursion!.resolution).toBe("daily");
  });

  it("clamps a future's fill into the stock's range, so the basis isn't an excursion", () => {
    // Filled at 101.5 (a future at a premium) on a day the stock never traded above 101.
    const { excursion } = measureExcursion(trade({ entryPrice: 101.5 }), daily(), 5, LATER);
    expect(excursion!.mae.low).toBeCloseTo((101 - 96) / 5, 9);
  });

  it("refuses prices that can't be the trade's (a split the factors miss) and splits during the trade", () => {
    expect(measureExcursion(trade({ entryPrice: 200 }), daily(), 5, LATER).why).toMatch(/far outside the stock's range/);
    expect(measureExcursion(trade(), { ...daily(), splitDuring: true }, 5, LATER).why).toMatch(/split or bonus during the trade/);
    expect(measureExcursion(trade({ entryAt: at(MON - DAY, 15, 20) }), daily(), 5, LATER).why).toMatch(/no stored daily bar for the entry day/);
  });
});

describe("the plan's own exit", () => {
  it("replays the stop-target rule from the entry, with the stop as it was when taken", () => {
    const moved = trade({ stop: 90, changes: [{ field: "stop", from: 95, to: 90, at: at(TUE, 10, 0) }] });
    expect(stopAtEntry(moved)).toBe(95);
    const exit = planExit(moved, WEEK, MON, 5);
    // Tuesday's low (96) stays above the planned 95; target 115 never trades: no exit yet within the hold.
    expect(exit).toBeNull();
    const hit = planExit(trade({ target: 106 }), WEEK, MON, 5)!;
    expect(hit).toMatchObject({ session: 2, reason: "target", price: 106 });
    expect(hit.r).toBeCloseTo(1.2, 9);
  });

  it("fills a gap through the stop at the open, exits BTST at the next open and time exits at the close", () => {
    const gap = [bar(MON, 99, 101, 97, 100), bar(TUE, 93, 94, 92, 93)];
    expect(planExit(trade(), gap, MON, 5)).toMatchObject({ session: 1, reason: "stop", price: 93 });
    expect(planExit(trade({ exitRule: "next-open", holdSessions: 1 }), WEEK, MON, 5)).toMatchObject({ session: 1, reason: "open", price: 100 });
    expect(planExit(trade({ target: null, exitRule: "time", holdSessions: 3 }), WEEK, MON, 5)).toMatchObject({ session: 3, reason: "time", price: 104 });
  });

  it("follows a trailing low", () => {
    const bars = [bar(MON - 2 * DAY, 99, 100, 98.5, 99), bar(MON - DAY, 99, 100, 98.8, 99.5), bar(MON, 99, 101, 98.6, 100), bar(TUE, 100, 101, 97.5, 98)];
    expect(planExit(trade({ exitRule: "trail-low:3", target: null }), bars, MON, 5)).toMatchObject({ session: 1, reason: "trail", price: 98 });
  });
});

describe("rule breaks", () => {
  it("checks the entry window for close and BTST entries, and buy-stops by price", () => {
    expect(checkEntry(trade())).toEqual({ checked: true, broken: null });
    const early = checkEntry(trade({ entryAt: at(MON, 13, 42) }));
    expect(early.checked && early.broken?.text).toBe("Bought at 1:42 PM; the plan buys 3:15–3:25 PM (the screens were tested on closing prices)");
    expect(checkEntry(trade({ entryAt: at(MON, 15, 26) })).checked && checkEntry(trade({ entryAt: at(MON, 15, 26) }))).toMatchObject({ broken: { rule: "entry" } });
    expect(checkEntry(trade({ entryTimed: false }))).toMatchObject({ checked: false, why: expect.stringMatching(/only the date/) });
    expect(checkEntry(trade({ entryTimed: null }))).toMatchObject({ checked: false });
    // Older trades: no entry kind, except BTST (its exit rule says so).
    expect(checkEntry(trade({ entryKind: null }))).toMatchObject({ checked: false, why: expect.stringMatching(/close or buy-stop/) });
    expect(checkEntry(trade({ entryKind: null, exitRule: "next-open", entryAt: at(MON, 11, 0) }))).toMatchObject({ checked: true, broken: { rule: "entry" } });
    expect(checkEntry(trade({ entryKind: "buy-stop", entryPrice: 99.5, entryAt: at(TUE, 10, 5) }))).toMatchObject({ checked: true, broken: { text: expect.stringMatching(/below the buy-stop/) } });
    expect(checkEntry(trade({ entryKind: "buy-stop", entryPrice: 100.4, entryAt: at(TUE, 10, 5) }))).toEqual({ checked: true, broken: null });
  });

  it("finds moved stops only where the history is kept", () => {
    const moved = trade({ stop: 92, changes: [{ field: "stop", from: 95, to: 92, at: at(TUE, 10, 0) }] });
    expect(checkStop(moved)).toMatchObject({ checked: true, broken: { rule: "stop-moved", text: "Stop moved once: 95.00 → 92.00 (wider, 3 Nov)" } });
    expect(checkStop(trade())).toEqual({ checked: true, broken: null });
    expect(checkStop({ ...moved, audited: false })).toMatchObject({ checked: false, why: expect.stringMatching(/before stop and lot changes were kept/) });
  });

  it("finds more lots than the plan sized, including a size raised and lowered again", () => {
    expect(checkSize(trade({ lots: 3, planLots: 2 }))).toMatchObject({ broken: { text: "Took 3 lots; the plan sized 2" } });
    expect(checkSize(trade({ lots: 2, planLots: 2, changes: [{ field: "lots", from: 2, to: 4, at: 1 }, { field: "lots", from: 4, to: 2, at: 2 }] }))).toMatchObject({ broken: { rule: "oversized" } });
    expect(checkSize(trade({ planLots: 0 }))).toMatchObject({ broken: { text: expect.stringMatching(/the plan sized none/) } });
    expect(checkSize(trade({ planLots: null }))).toMatchObject({ checked: false });
  });

  it("finds holding past the plan's exit", () => {
    const bars = [bar(MON, 99, 101, 97, 100), bar(TUE, 99, 99, 94, 95), bar(WED, 95, 96, 93, 94), bar(THU, 94, 95, 92, 93)];
    const review = reviewTrade(trade({ exitPrice: 93, exitAt: at(THU, 15, 25) }), daily(bars), LATER);
    expect(review.held).toBe(3);
    expect(review.planExit).toMatchObject({ session: 1, reason: "stop", price: 95 });
    expect(review.vsPlanR).toBeCloseTo(-0.4, 9);
    expect(review.breaks.map((entry) => entry.text)).toEqual(["Sold in session 3; the plan's stop came in session 1 (3 Nov)"]);
  });
});

// ------------------------------------------------------------------ journals

/** A journal of `n` closed trades, one a week: each goes to `peak` (Wednesday), you exit Thursday at `exit`; target 106 hit Wednesday. */
function journal(n: number, make: (i: number) => { exit: number; patch?: Partial<CoachTrade> }) {
  const trades: CoachTrade[] = [];
  const bars: Record<string, TradeBars> = {};
  for (let i = 0; i < n; i += 1) {
    const week = MON + i * 7 * DAY;
    const { exit, patch } = make(i);
    const id = `t${i}`;
    trades.push(trade({ id, target: 106, entryAt: at(week, 15, 20), exitAt: at(week + 3 * DAY, 15, 25), exitPrice: exit, ...patch }));
    bars[id] = daily([bar(week, 99, 101, 97, 100), bar(week + DAY, 100, 101, 96 + (i % 3) * 0.2, 98), bar(week + 2 * DAY, 98, 108, 97, 107), bar(week + 3 * DAY, 107, 107.5, 90, 104), bar(week + 4 * DAY, 104, 105, 102, 103)]);
  }
  return { trades, bars };
}

describe("the coach's report", () => {
  it("explains an empty journal and states no finding", () => {
    const report = coachReport([trade({ status: "open", exitAt: null, exitPrice: null })], {}, LATER);
    expect(report.closed).toBe(0);
    expect(report.open).toBe(1);
    expect(report.findings.every((entry) => entry.mean === null && entry.text.startsWith("Too few trades"))).toBe(true);
  });

  it("won't state a finding below the minimum sample", () => {
    const { trades, bars } = journal(MIN_SAMPLE - 1, (i) => ({ exit: 104 + (i % 2) * 0.2 }));
    const report = coachReport(trades, bars, LATER);
    const winners = report.findings.find((entry) => entry.id === "winners-vs-plan")!;
    expect(winners).toMatchObject({ n: MIN_SAMPLE - 1, mean: null, ci: null });
    expect(winners.text).toBe(`Too few trades: ${MIN_SAMPLE - 1} of the ${MIN_SAMPLE} winners needed.`);
  });

  it("says you exit winners early, with its sample and interval", () => {
    // The plan's target (106, +1.2R) traded Wednesday; you sold Thursday around 104 (+0.8R): 0.4R short, and a session late.
    const { trades, bars } = journal(10, (i) => ({ exit: 104 + (i % 2 ? 0.1 : -0.1) }));
    const report = coachReport(trades, bars, LATER);
    const winners = report.findings.find((entry) => entry.id === "winners-vs-plan")!;
    expect(winners.n).toBe(10);
    expect(winners.mean).toBeCloseTo(-0.4, 9);
    expect(winners.clear).toBe(true);
    expect(winners.text).toMatch(/^You exit winners 0\.40R short of the plan's own exit on average \(10 winners, 95% interval −0\.4\dR to −0\.3\dR\)\.$/);
    expect(report.rules.find((rule) => rule.rule === "held-past-exit")).toMatchObject({ checked: 10, broken: 10 });
    expect(report.resolution).toEqual({ intraday: 0, daily: 10, none: 0 });
    const giveBack = report.findings.find((entry) => entry.id === "give-back")!;
    // Best price 108 (+1.6R) between entry and exit; kept +0.8R.
    expect(giveBack.mean).toBeCloseTo(0.8, 1);
  });

  it("says when an effect could be chance", () => {
    const { trades, bars } = journal(8, (i) => ({ exit: [101, 111, 102, 110, 101, 111, 102, 110][i] }));
    const winners = coachReport(trades, bars, LATER).findings.find((entry) => entry.id === "winners-vs-plan")!;
    expect(winners.clear).toBe(false);
    expect(winners.text).toMatch(/the interval includes zero, so this could be chance\)\.$/);
  });

  it("compares trades with a rule break against clean ones, and counts what it couldn't check", () => {
    const { trades, bars } = journal(12, (i) => (i < 6 ? { exit: 99, patch: { entryAt: at(MON + i * 7 * DAY, 11, 0) } } : { exit: 105 }));
    const legacy = trade({ id: "old", audited: false, planLots: null, entryKind: null, entryTimed: null, entryAt: at(d("2026-10-05"), 15, 20), exitAt: at(d("2026-10-08"), 15, 25) });
    const report = coachReport([...trades, legacy], bars, LATER);
    const breaks = report.findings.find((entry) => entry.id === "rule-breaks")!;
    expect(report.rules.find((rule) => rule.rule === "entry")).toMatchObject({ checked: 12, broken: 6, unchecked: 1 });
    expect(report.rules.find((rule) => rule.rule === "stop-moved")).toMatchObject({ checked: 12, unchecked: 1, why: [{ reason: "recorded before stop and lot changes were kept", trades: 1 }] });
    expect(report.rules.find((rule) => rule.rule === "oversized")).toMatchObject({ checked: 12, unchecked: 1 });
    // Every journal trade held past the Wednesday target, so there are no clean trades to compare with.
    expect(breaks.mean).toBeNull();
    expect(breaks.text).toMatch(/^Too few trades: 12 with a rule break and 0 checked on every rule without one/);
    expect(report.resolution.none).toBe(1); // the legacy trade has no bars
  });

  it("works out the rule-break difference when both groups are big enough", () => {
    // No target: the plan holds 10 sessions, so selling Thursday isn't late; six trades bought at 11 AM.
    const { trades, bars } = journal(12, (i) => ({ exit: i < 6 ? 99 + (i % 2) * 0.5 : 105 - (i % 2) * 0.5, patch: { target: null, exitRule: "time", ...(i < 6 ? { entryAt: at(MON + i * 7 * DAY, 11, 0) } : {}) } }));
    const breaks = coachReport(trades, bars, LATER).findings.find((entry) => entry.id === "rule-breaks")!;
    expect(breaks.n).toBe(12);
    expect(breaks.mean).toBeCloseTo((99.25 - 100) / 5 - (104.75 - 100) / 5, 9);
    expect(breaks.clear).toBe(true);
    expect(breaks.text).toMatch(/^Trades where you broke a rule made 1\.10R less per trade than those checked on every rule without one \(−0\.15R on 6 vs \+0\.95R on 6, 95% interval/);
  });

  it("has no look-ahead: later trades, closes and bars don't change an earlier report", () => {
    const { trades, bars } = journal(10, (i) => ({ exit: 104 + (i % 2) * 0.3 }));
    const cutoff = at(MON + 5 * 7 * DAY, 18, 0); // after the 5th trade's week
    const truncated = Object.fromEntries(Object.entries(bars).map(([id, entry]) => [id, { ...entry, daily: entry.daily.filter((b) => b.t < cutoff) }]));
    const visible = trades.filter((entry) => entry.entryAt <= cutoff);
    const before = coachReport(visible, truncated, cutoff);
    const withFuture = coachReport(trades, bars, cutoff);
    expect(withFuture).toEqual(before);
    expect(before.closed).toBe(5);

    // A trade still open at the cutoff and closed after it counts as open.
    const lateClose = trade({ id: "late", entryAt: at(MON + 5 * 7 * DAY, 15, 20), exitAt: at(MON + 6 * 7 * DAY, 15, 20) });
    expect(coachReport([lateClose], {}, cutoff)).toMatchObject({ closed: 0, open: 1 });

    // Bars after a trade's exit never change its MAE / MFE.
    const one = { ...bars.t0, daily: [...bars.t0.daily, bar(NEXT_MON, 103, 130, 60, 100)] };
    expect(reviewTrade(trades[0], one, LATER).excursion).toEqual(reviewTrade(trades[0], bars.t0, LATER).excursion);

    // An intraday candle that hasn't finished by `now` isn't read.
    const candles: Candle[] = [];
    for (const day of [MON, TUE, WED, THU]) for (let k = 0; k < 25; k += 1) candles.push({ t: at(day, 9, 15) + k * 15 * 60_000, o: 100, h: 101, l: 99, c: 100 });
    candles.find((candle) => candle.t === at(THU, 15, 15))!.h = 200;
    const exitAt = at(THU, 15, 20);
    const forming = measureExcursion(trade({ exitAt, exitPrice: 100 }), { daily: WEEK, intraday: { minutes: 15, candles }, intradayWhy: null }, 5, exitAt + 60_000);
    expect(forming.excursion!.resolution).toBe("intraday");
    expect(forming.excursion!.mfe.high).toBeCloseTo(0.2, 9);
  });
});
