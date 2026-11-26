import { describe, expect, it } from "vitest";
import {
  IIMA_OPTIONS,
  adjustedJumps,
  buildFactors,
  compare,
  compoundToMonths,
  correlation,
  formMonth,
  gapFactors,
  missedFactors,
  snapRatio,
  largestGaps,
  monthKey,
  monthOf,
  pairUp,
  parseIimaBreakpoints,
  parseIimaFactors,
  parseIimaPortfolios,
  parseMonth,
  rollingCorrelation,
  stockMonths,
  wmlContributions,
  type StockMonths,
} from "./iima";

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

describe("IIMA files", () => {
  it("reads the factor file in fractions, NA as null", () => {
    const rows = parseIimaFactors("Date,SMB,HML,WML,MF,RF\n1993-10,2.98,2.58,3.01,NA,NA\n1993-11,-9.4,-0.5,12.6,17.6,0.61\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ month: "1993-10", smb: 0.0298, hml: 0.0258, wml: 0.0301, mf: null, rf: null });
    expect(rows[1].wml).toBeCloseTo(0.126);
    expect(() => parseIimaFactors("Date,Foo\n")).toThrow(/Not an IIMA factor file/);
  });

  it("reads the size-momentum portfolios and the breakpoints", () => {
    const portfolios = parseIimaPortfolios("Date,Portfolio WB returns (%),Portfolio WS returns (%),Portfolio LB returns (%),Portfolio LS returns (%)\n1993-10,-1.9,-0.5,-10.2,1.9\n");
    expect(portfolios[0]).toEqual({ month: "1993-10", wb: -0.019, ws: -0.005, lb: -0.102, ls: 0.019 });
    expect(() => parseIimaPortfolios("Date,A,B\n")).toThrow();
    const breakpoints = parseIimaBreakpoints("yearmonth,90th Percentile of Size (Mcap),30th percentile of Momentum,70th percentile of Momentum\n199010,1642.5,NA,NA\n202512,139824.6,-32.4,-3.9\n");
    expect(breakpoints[0]).toEqual({ month: "1990-10", size90: 1642.5, mom30: null, mom70: null });
    expect(breakpoints[1].mom30).toBeCloseTo(-0.324);
  });

  it("compounds daily rows to months", () => {
    const months = compoundToMonths([
      { date: "2025-01-02", value: 0.1 },
      { date: "2025-01-03", value: -0.1 },
      { date: "2025-02-03", value: null },
      { date: "2025-02-04", value: 0.02 },
    ]);
    expect(months.get("2025-01")).toBeCloseTo(-0.01);
    expect(months.get("2025-02")).toBeCloseTo(0.02);
  });
});

describe("months", () => {
  it("round-trips month integers", () => {
    expect(monthKey(parseMonth("1995-09"))).toBe("1995-09");
    expect(monthOf(day("2015-06-15"))).toBe(parseMonth("2015-06"));
  });
});

describe("stockMonths and adjustedJumps", () => {
  // A 1:1 bonus on 15 Jun: 2000 → 1000 as traded; the factor 0.5 halves the earlier bars.
  const t = [day("2015-05-29"), day("2015-06-12"), day("2015-06-15"), day("2015-07-31")];
  const c = [1900, 2000, 1000, 1100];
  const v = [10, 20, 40, 50];

  it("adjusts bars before an ex-date and sums sessions and traded value", () => {
    const months = stockMonths("INFY", t, c, v, [{ day: day("2015-06-15"), factor: 0.5 }])!;
    expect(monthKey(months.first)).toBe("2015-05");
    expect(Array.from(months.adj)).toEqual([950, 1000, 1100]);
    expect(Array.from(months.raw)).toEqual([1900, 1000, 1100]);
    expect(Array.from(months.days)).toEqual([1, 2, 1]);
    expect(months.value[1]).toBe(2000 * 20 + 1000 * 40);
    expect(stockMonths("X", [], [], [], [])).toBeNull();
  });

  it("flags a fall no factor explains, and not one a factor explains", () => {
    expect(adjustedJumps("INFY", t, c, [{ day: day("2015-06-15"), factor: 0.5 }])).toEqual([]);
    const jumps = adjustedJumps("INFY", t, c, []);
    expect(jumps).toHaveLength(1);
    expect(jumps[0]).toMatchObject({ id: "INFY", day: day("2015-06-15"), prevClose: 2000, close: 1000, ret: -0.5 });
  });
});

/** A stock trading every month from 2000-01 with the given month-end closes (20 sessions, value `size` a day). */
function stock(id: string, closes: number[], size: number): StockMonths {
  const n = closes.length;
  return { id, first: parseMonth("2000-01"), adj: Float64Array.from(closes), raw: Float64Array.from(closes), days: new Float64Array(n).fill(20), value: new Float64Array(n).fill(20 * size) };
}

/** 40 stocks: stock i grows at rate g_i for 13 months, then returns r_i in the holding month. */
function universe(holding: (i: number) => number) {
  const out: StockMonths[] = [];
  for (let i = 0; i < 40; i += 1) {
    const growth = (i - 20) / 200;
    const closes = Array.from({ length: 13 }, (_, m) => 100 * (1 + growth) ** m);
    closes.push(closes[12] * (1 + holding(i)));
    out.push(stock(`S${i}`, closes, 1000 + i * 100));
  }
  return out;
}

describe("formMonth and buildFactors", () => {
  const formed = parseMonth("2001-01");

  it("sorts on 12-1 momentum and size, and WML is winners minus losers", () => {
    // Winners (high i) gain 10% in the holding month, losers lose 10%.
    const stocks = universe((i) => (i >= 20 ? 0.1 : -0.1));
    const month = formMonth(stocks, formed, { ...IIMA_OPTIONS, microShare: 0, weighting: "ew", minStocks: 1 });
    expect(month.universe).toBe(40);
    expect(month.ranked).toBe(40);
    expect(month.portfolios.wb.n + month.portfolios.ws.n).toBe(12);
    expect(month.portfolios.lb.n).toBe(0);
    // No big losers: WML is the small leg alone.
    expect(month.wml).toBeCloseTo(0.2);
    expect(month.market).toBeCloseTo(0);
    expect(month.breakpoints!.mom70).toBeGreaterThan(month.breakpoints!.mom30);
    const drivers = wmlContributions(month);
    expect(drivers.every((driver) => driver.leg === "ws" || driver.leg === "ls")).toBe(true);
    expect(drivers.reduce((sum, driver) => sum + driver.contribution, 0)).toBeCloseTo(0.2);
  });

  it("applies the liquidity, penny and micro-cap filters", () => {
    const stocks = universe(() => 0);
    stocks[0].days.fill(2); // 26 sessions a year: out
    stocks[1].raw.fill(0.5); // a penny stock: out
    const month = formMonth(stocks, formed, { ...IIMA_OPTIONS, microShare: 0.25 });
    // 38 left; the 25th percentile of their sizes falls between the 10th and 11th: 28 stay.
    expect(month.universe).toBe(28);
  });

  it("weights by traded value and drops a leg under the minimum", () => {
    const stocks = universe((i) => (i >= 20 ? 0.1 : -0.1));
    const value = formMonth(stocks, formed, { ...IIMA_OPTIONS, microShare: 0 });
    // Default minimum of 5: the 4 big winners are too few, the small leg alone counts.
    expect(value.portfolios.wb.n).toBe(4);
    expect(value.portfolios.wb.ret).toBeNull();
    expect(value.wml).toBeCloseTo(0.2);
    const months = buildFactors(stocks, parseMonth("2001-02"), parseMonth("2001-03"), { ...IIMA_OPTIONS, microShare: 0 });
    expect(months.map((row) => row.month)).toEqual(["2001-02", "2001-03"]);
    expect(months[0].wml).toBeCloseTo(0.2);
    // A month after the data ends: prices carried, nothing ranked.
    expect(months[1].wml === null || Math.abs(months[1].wml) < 1e-9).toBe(true);
  });

  it("has no WML with too few stocks", () => {
    const month = formMonth(universe(() => 0).slice(0, 10), formed);
    expect(month.wml).toBeNull();
    expect(wmlContributions(month)).toEqual([]);
  });
});

describe("missed splits and bonuses", () => {
  const t = ["2011-03-03", "2011-03-04", "2011-03-07", "2011-03-08", "2011-03-09", "2011-03-10", "2011-03-11", "2011-03-14"].map(day);
  // HINDZINC: 1:1 bonus with a ₹10 → ₹2 split on 7 Mar 2011 (factor 0.1).
  const c = [1330, 1343.25, 130.8, 131, 132, 130, 129, 133];

  it("snaps to standard ratios only when close", () => {
    expect(snapRatio(0.097)).toBeCloseTo(0.1);
    expect(snapRatio(0.501)).toBeCloseTo(0.5);
    expect(snapRatio(0.245)).toBeCloseTo(0.25);
    expect(snapRatio(0.95)).toBeNull();
  });

  it("finds a listed split the factors miss, and not one they have or a special dividend", () => {
    const listed = [{ exDay: day("2011-03-07"), purpose: "BON 1:1/SPL RS10 TO RS2" }];
    const found = missedFactors(t, c, [], listed);
    expect(found).toHaveLength(1);
    expect(found[0].factor).toBeCloseTo(0.1);
    expect(missedFactors(t, c, [{ day: day("2011-03-07"), factor: 0.1 }], listed)).toEqual([]);
    expect(missedFactors(t, c, [], [{ exDay: day("2011-03-07"), purpose: "SPL DIV-RS 24 PER SHARE" }])).toEqual([]);
    expect(missedFactors(t, c, [], [{ exDay: day("2011-03-07"), purpose: "DIV-FIN RS7.5+SPL RS 7.5" }])).toEqual([]);
    // Listed, but the price didn't fall: nothing to fix.
    expect(missedFactors(t, [1, 1, 1, 1, 1, 1, 1, 1], [], listed)).toEqual([]);
  });

  it("finds split-like price gaps that stay down, not crashes that recover", () => {
    const gaps = gapFactors(t, c, []);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ day: day("2011-03-07"), purpose: "price gap" });
    expect(gapFactors(t, c, [{ day: day("2011-03-07"), factor: 0.1 }])).toEqual([]);
    const badPrint = [1330, 1343.25, 671, 1340, 1338, 1342, 1341, 1339];
    expect(gapFactors(t, badPrint, [])).toEqual([]);
  });
});

describe("comparison statistics", () => {
  const ours = new Map<string, number | null>([
    ["2000-01", 0.01],
    ["2000-02", 0.02],
    ["2000-03", -0.01],
    ["2000-04", 0.03],
    ["2000-05", null],
  ]);
  const theirs = new Map<string, number | null>([
    ["2000-01", 0.02],
    ["2000-02", 0.04],
    ["2000-03", -0.02],
    ["2000-04", 0.06],
    ["2000-05", 0.01],
  ]);

  it("pairs months both have and compares them", () => {
    const pairs = pairUp(ours, theirs);
    expect(pairs).toHaveLength(4);
    expect(pairUp(ours, theirs, "2000-02", "2000-03")).toHaveLength(2);
    const result = compare(pairs);
    expect(result.correlation).toBeCloseTo(1);
    expect(result.beta).toBeCloseTo(0.5);
    expect(result.meanOurs).toBeCloseTo(0.0125 * 12);
    expect(result.trackingError).toBeGreaterThan(0);
    expect(Number.isNaN(compare(pairs.slice(0, 2)).correlation)).toBe(true);
  });

  it("rolls the correlation and ranks the gaps", () => {
    const pairs = pairUp(ours, theirs);
    expect(rollingCorrelation(pairs, 3).map((point) => point.month)).toEqual(["2000-03", "2000-04"]);
    expect(largestGaps(pairs, 1)[0]).toMatchObject({ month: "2000-04", gap: -0.03 });
    expect(correlation([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1);
  });
});
