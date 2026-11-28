import { describe, expect, it } from "vitest";
import { DAY_MS } from "@/core/market/session";
import { flagNotes, impliedMove, ivPoints, ivRank, ivText, levelsOf, optionFact, optionPoint, optionView, skewOf, termStructure, throughDay, type OptionDay, type OptionLeg } from "./summary";

// The hub's documented example day (docs/api.md, GET /v1/options/summary):
// RELIANCE on 1 Oct 2025, computed by market-data-hub#30 from that day's NSE
// F&O bhavcopy. The `next` leg isn't in the docs; it is filled in here with
// plausible numbers for a 55-day expiry.

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

const NEAR: OptionLeg = {
  expiry: "2025-10-28",
  expiryDay: day("2025-10-28"),
  days: 27,
  forward: 1377.4,
  atmStrike: 1380,
  straddle: 53.35,
  expectedMovePct: 3.873,
  atmIv: 0.1789,
  callIv: 0.1808,
  putIv: 0.177,
  cpSpread: 0.0031,
  iv25Put: 0.1822,
  iv25Call: 0.1771,
  skew25: 0.0051,
  maxPain: 1390,
  callWall: 1400,
  callWallOi: 5836500,
  putWall: 1400,
  putWallOi: 2287500,
  callOi: 41155000,
  putOi: 33300000,
  pcrOi: 0.8091,
  strikes: 42,
  liquidStrikes: 40,
  flags: [],
};

const NEXT: OptionLeg = { ...NEAR, expiry: "2025-11-25", expiryDay: day("2025-11-25"), days: 55, forward: 1383.1, straddle: 78.2, expectedMovePct: 5.654, atmIv: 0.1795, skew25: 0.0062, flags: [] };

const RELIANCE: OptionDay = {
  date: "2025-10-01",
  day: day("2025-10-01"),
  ticker: "RELIANCE",
  kind: "stock",
  spot: 1368.7,
  lot: 500,
  lotEstimated: false,
  expiries: 3,
  callOi: 45961500,
  putOi: 37253000,
  callChgOi: 2963000,
  putChgOi: 3226000,
  callVolume: 108543,
  putVolume: 60601,
  pcrOi: 0.8105,
  pcrVolume: 0.5583,
  optionShares: 84572000,
  stockVolume: 13004912,
  optionToStock: 6.5032,
  iv30: 0.1788,
  ivPercentile: 12.4,
  flags: [],
  near: NEAR,
  next: NEXT,
};

describe("one day's view (RELIANCE, 1 Oct 2025)", () => {
  it("reads the term structure: near 17.9%, next 18.0%, iv30 17.9%, about flat", () => {
    const term = termStructure(RELIANCE);
    expect(term.near).toEqual({ expiry: "2025-10-28", days: 27, iv: 0.1789 });
    expect(term.next?.iv).toBe(0.1795);
    expect(term.iv30).toBe(0.1788);
    expect(term.slope).toBeCloseTo(0.0006, 6);
    expect(term.shape).toBe("flat");
    expect(termStructure({ ...RELIANCE, next: { ...NEXT, atmIv: 0.21 } }).shape).toBe("upward");
    expect(termStructure({ ...RELIANCE, near: { ...NEAR, atmIv: 0.3 } }).shape).toBe("inverted");
    expect(termStructure({ ...RELIANCE, next: null })).toMatchObject({ next: null, slope: null, shape: null });
  });

  it("reads the 25-delta skew: puts 0.5 pts richer than calls", () => {
    expect(skewOf(RELIANCE)).toEqual({ expiry: "2025-10-28", put25: 0.1822, call25: 0.1771, skew25: 0.0051, cpSpread: 0.0031, lean: "puts" });
    // The near expiry has no 25-delta strikes on both sides: the next one's skew is used.
    const thin = skewOf({ ...RELIANCE, near: { ...NEAR, iv25Call: null, skew25: null } });
    expect(thin?.expiry).toBe("2025-11-25");
    expect(thin?.skew25).toBe(0.0062);
    expect(skewOf({ near: { ...NEAR, iv25Put: 0.15, iv25Call: 0.2, skew25: null }, next: null })).toMatchObject({ skew25: expect.closeTo(-0.05, 9), lean: "calls" });
    expect(skewOf({ near: null, next: null })).toBeNull();
  });

  it("prices the move to expiry from the straddle: ±3.87%, 1,324–1,431, about a 4.9% standard deviation", () => {
    const move = impliedMove(NEAR)!;
    expect(move.pct).toBeCloseTo(3.873, 3); // the hub's expectedMovePct
    expect(move.low).toBeCloseTo(1324.05, 2);
    expect(move.high).toBeCloseTo(1430.75, 2);
    // Cross-check: the ATM straddle ≈ 0.8 σ√T F, so σ√T ≈ 17.89% × √(27/365) = 4.87%.
    expect(move.sigmaPct).toBeCloseTo(0.1789 * Math.sqrt(27 / 365) * 100, 1);
    expect(move.modelled).toBe(false);
    expect(impliedMove({ ...NEAR, flags: ["ATM_UNTRADED"] })!.modelled).toBe(true);
    expect(impliedMove({ ...NEAR, straddle: null })).toBeNull();
    expect(impliedMove({ ...NEAR, forward: 0 })).toBeNull();
    expect(impliedMove(null)).toBeNull();
  });

  it("puts max pain and the walls against the spot", () => {
    const levels = levelsOf(NEAR, 1368.7)!;
    expect(levels.maxPain?.strike).toBe(1390);
    expect(levels.maxPain?.fromSpotPct).toBeCloseTo(1.556, 3);
    expect(levels.callWall).toEqual({ strike: 1400, fromSpotPct: expect.closeTo(2.287, 3), oi: 5836500 });
    expect(levels.putWall?.oi).toBe(2287500);
    expect(levelsOf(NEAR, null)!.maxPain?.fromSpotPct).toBeNull();
    expect(levelsOf({ ...NEAR, maxPain: null }, 1368.7)!.maxPain).toBeNull();
    expect(levelsOf(null, 1368.7)).toBeNull();
  });

  it("brings it together, with the PCR and option-to-stock volume", () => {
    const view = optionView(RELIANCE);
    expect(view.pcr).toEqual({ oi: 0.8105, volume: 0.5583, callChgOi: 2963000, putChgOi: 3226000 });
    expect(view.optionToStock).toBe(6.5032);
    expect(view.notes).toEqual([]);
    expect(optionPoint(RELIANCE)).toEqual({ day: RELIANCE.day, iv30: 0.1788, nearIv: 0.1789, nextIv: 0.1795, ivPercentile: 12.4, pcrOi: 0.8105, spot: 1368.7 });
  });

  it("explains the flags once each, saying which expiry", () => {
    const notes = flagNotes({ flags: ["LOT_ESTIMATED", "SOMETHING_NEW"], near: { ...NEAR, flags: ["FORWARD_PARITY", "FEW_STRIKES"] }, next: { ...NEXT, flags: ["FORWARD_PARITY", "ATM_UNTRADED"] } });
    expect(notes).toHaveLength(4);
    expect(notes[0]).toMatch(/^Lot size estimated/);
    expect(notes[1]).toMatch(/^Both expiries: No same-expiry future/);
    expect(notes[2]).toMatch(/^Near expiry \(2025-10-28\): Fewer than 3 strikes/);
    expect(notes[3]).toMatch(/^Next expiry \(2025-11-25\): An ATM leg didn't trade/);
  });

  it("gives the screener a compact fact, or none without an iv30", () => {
    expect(optionFact(RELIANCE)).toEqual({ day: RELIANCE.day, iv30: 0.1788, ivPercentile: 12.4, movePct: expect.closeTo(3.873, 3), moveDays: 27, pcrOi: 0.8105, skew25: 0.0051 });
    expect(optionFact({ ...RELIANCE, iv30: null })).toBeNull();
    expect(optionFact({ ...RELIANCE, near: null, next: null })).toMatchObject({ movePct: null, moveDays: null, skew25: null });
  });

  it("formats IVs and IV differences", () => {
    expect(ivText(0.1788)).toBe("17.9%");
    expect(ivText(null)).toBe("—");
    expect(ivPoints(0.0051)).toBe("+0.5 pts");
    expect(ivPoints(-0.021)).toBe("−2.1 pts");
    expect(ivPoints(null)).toBe("—");
  });
});

describe("no look-ahead", () => {
  const D = day("2025-10-01");
  const series = (from: string, count: number, iv: (i: number) => number | null) => Array.from({ length: count }, (_, i) => ({ day: day(from) + i * DAY_MS, iv30: iv(i) }));

  it("cuts the days at D, oldest first, one per day", () => {
    const days = [{ day: D + DAY_MS, v: "after" }, { day: D, v: "D" }, { day: D - DAY_MS, v: "before" }, { day: D, v: "duplicate" }, { day: Number.NaN, v: "bad" }];
    expect(throughDay(days, D).map((entry) => entry.v)).toEqual(["before", "D"]);
  });

  it("ranks iv30 among the 365 days up to D only", () => {
    // A year of iv30 rising from 10% to 46.4% (365 days), then a month at 80% after D.
    const year = series("2024-10-02", 365, (i) => 0.1 + i * 0.001);
    expect(year.at(-1)!.day).toBe(D);
    const after = series("2025-10-02", 30, () => 0.8);
    const rank = ivRank([...year, ...after], D)!;
    expect(rank).toEqual({ rank: 100, percentile: expect.closeTo(99.7, 1), iv30: expect.closeTo(0.464, 6), low: 0.1, high: expect.closeTo(0.464, 6), days: 365, from: year[0].day, to: D });
    expect(ivRank(year, D)).toEqual(rank); // the month after D changes nothing
    // A day 400 days before D is outside the window.
    expect(ivRank([{ day: D - 400 * DAY_MS, iv30: 5 }, ...year], D)).toEqual(rank);
  });

  it("needs 60 days of iv30 in the window, and one on the day itself", () => {
    const short = series("2025-08-03", 60, (i) => 0.2 + (i % 7) * 0.01);
    expect(short.at(-1)!.day).toBe(D);
    expect(ivRank(short, D)?.days).toBe(60);
    expect(ivRank(short.slice(1), D)).toBeNull();
    expect(ivRank([...short.slice(0, -1), { day: D, iv30: null }], D)).toBeNull();
    // A flat year sits mid-range.
    expect(ivRank(series("2025-08-03", 60, () => 0.2), D)).toMatchObject({ rank: 50, percentile: 0 });
  });
});
