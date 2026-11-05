import { describe, expect, it } from "vitest";
import { dailyReturns, drawdowns, equityStats, maxDrawdown, monthlyReturns, sharpe, sortino, stdev, tradeStats, type EquityPoint } from "./metrics";

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 1);

const point = (t: number, equity: number, bench: number | null = null, open = 0): EquityPoint => ({ t, equity, bench, drawdown: 0, open });

describe("trade statistics", () => {
  const trades = [
    { pnl: 200, r: 2, holdDays: 3 },
    { pnl: -100, r: -1, holdDays: 1 },
    { pnl: -100, r: -1, holdDays: 2 },
    { pnl: 300, r: 3, holdDays: 4 },
    { pnl: -50, r: -0.5, holdDays: 5 },
  ];

  it("computes win rate, R, expectancy and profit factor by hand", () => {
    const stats = tradeStats(trades);
    expect(stats.trades).toBe(5);
    expect(stats.wins).toBe(2);
    expect(stats.winRate).toBeCloseTo(0.4, 9);
    expect(stats.avgR).toBeCloseTo((2 - 1 - 1 + 3 - 0.5) / 5, 9); // 0.5R
    expect(stats.expectancy).toBeCloseTo(250 / 5, 9); // ₹50
    expect(stats.profitFactor).toBeCloseTo(500 / 250, 9); // 2.0
    expect(stats.netPnl).toBeCloseTo(250, 9);
    expect(stats.avgHoldDays).toBeCloseTo(3, 9);
    expect(stats.longestLosingStreak).toBe(2);
  });

  it("has no profit factor without a losing trade, and no averages without trades", () => {
    expect(tradeStats([{ pnl: 10, r: 1, holdDays: 1 }]).profitFactor).toBeNull();
    const empty = tradeStats([]);
    expect(empty.winRate).toBeNull();
    expect(empty.avgR).toBeNull();
  });
});

describe("drawdown", () => {
  it("measures depth and time under water", () => {
    // Peak 120 → trough 90 (−25%), recovered to 120 four points after the peak.
    const values = [100, 120, 110, 90, 100, 120, 125, 118];
    const dd = maxDrawdown(values, values.map((_, i) => i));
    expect(dd.maxDrawdown).toBeCloseTo(90 / 120 - 1, 9);
    expect(dd.peak).toBe(1);
    expect(dd.trough).toBe(3);
    expect(dd.sessions).toBe(4);
    expect(drawdowns(values)[3]).toBeCloseTo(-0.25, 9);
    expect(drawdowns(values)[6]).toBe(0);
  });

  it("counts an unrecovered drawdown to the end", () => {
    expect(maxDrawdown([100, 90, 95, 92]).sessions).toBe(3);
  });
});

describe("Sharpe and Sortino", () => {
  it("annualise daily mean / deviation by √252", () => {
    const r = [0.01, -0.005, 0.02, 0, -0.01];
    const m = 0.003;
    expect(stdev(r)).toBeCloseTo(Math.sqrt((0.007 ** 2 + 0.008 ** 2 + 0.017 ** 2 + 0.003 ** 2 + 0.013 ** 2) / 4), 12);
    expect(sharpe(r)!).toBeCloseTo((m / stdev(r)) * Math.sqrt(252), 9);
    const downside = Math.sqrt((0.005 ** 2 + 0.01 ** 2) / 5);
    expect(sortino(r)!).toBeCloseTo((m / downside) * Math.sqrt(252), 9);
  });

  it("are null for a flat curve", () => {
    expect(sharpe([0, 0, 0])).toBeNull();
    expect(sortino([0.01, 0.02])).toBeNull();
  });

  it("measure daily returns against the starting capital first", () => {
    const r = dailyReturns([110, 99], 100);
    expect(r[0]).toBeCloseTo(0.1, 12);
    expect(r[1]).toBeCloseTo(-0.1, 12);
  });
});

describe("equity statistics", () => {
  it("returns, CAGR over calendar time, exposure and benchmark", () => {
    const curve = [point(t0 + DAY, 105, 102, 1), point(t0 + 2 * DAY, 100, 101, 0), point(t0 + 365.25 * DAY, 121, 110, 2)];
    const stats = equityStats(curve, 100, t0, 100);
    expect(stats.totalReturn).toBeCloseTo(0.21, 9);
    expect(stats.years).toBeCloseTo(1, 9);
    expect(stats.cagr).toBeCloseTo(0.21, 9);
    expect(stats.exposure).toBeCloseTo(2 / 3, 9);
    expect(stats.benchReturn).toBeCloseTo(0.1, 9);
    expect(stats.maxDrawdown).toBeCloseTo(100 / 105 - 1, 9);
  });

  it("splits returns by calendar month", () => {
    const curve = [point(Date.UTC(2026, 0, 30), 110, 101), point(Date.UTC(2026, 1, 2), 99, 100), point(Date.UTC(2026, 1, 27), 121, 105)];
    const months = monthlyReturns(curve, 100, 100);
    expect(months).toHaveLength(2);
    expect(months[0]).toMatchObject({ year: 2026, month: 0 });
    expect(months[0].ret).toBeCloseTo(0.1, 9);
    expect(months[1].ret).toBeCloseTo(0.1, 9); // 121 / 110
    expect(months[1].bench!).toBeCloseTo(105 / 101 - 1, 9);
  });
});
