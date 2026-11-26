import { describe, expect, it } from "vitest";
import { COST_PRESETS } from "@/core/backtest/costs";
import type { DailyBar } from "@/core/types";
import { roundTripFraction } from "./engine";
import { CRASH_PERIODS, differenceT, monthEnds, monthlySpread, overlayStats, volManaged, type MonthRow, type MonthlySpread } from "./overlay";

const DAY = 86_400_000;
const NONE = COST_PRESETS.none.model;
const FUTURES = COST_PRESETS["futures-2026"].model;

/** Weekday sessions from `start` for `n` sessions. */
function sessions(start: number, n: number): number[] {
  const out: number[] = [];
  for (let t = start; out.length < n; t += DAY) {
    const weekday = new Date(t).getUTCDay();
    if (weekday !== 0 && weekday !== 6) out.push(t);
  }
  return out;
}

function fixture(stocks = 20, n = 200) {
  const dates = sessions(Date.UTC(2020, 0, 1), n);
  const symbols = Array.from({ length: stocks }, (_, s) => `S${String(s).padStart(2, "0")}`);
  // Stock s drifts (s − mid) × 0.1% a day: the highest values earn the most.
  const bars = new Map<string, DailyBar[]>(
    symbols.map((symbol, s) => {
      let close = 100;
      return [
        symbol,
        dates.map((t, i) => {
          if (i > 0) close *= 1 + (s - stocks / 2) * 0.001;
          return { t, o: close, h: close, l: close, c: close, v: 1 };
        }),
      ];
    }),
  );
  return { dates, symbols, bars, values: (_day: number, symbol: string) => Number(symbol.slice(1)) };
}

const row = (formation: number, net: number, extra: Partial<MonthRow> = {}): MonthRow => ({
  formation,
  end: formation + 30 * DAY,
  sessions: 21,
  ranked: 100,
  long: 20,
  short: 20,
  gross: net,
  turnover: { long: 0.3, short: 0.3 },
  legCost: { long: 0.002, short: 0.002 },
  cost: 0,
  net,
  ...extra,
});

describe("monthly long–short book", () => {
  it("forms on each month's last session", () => {
    const dates = [Date.UTC(2020, 0, 30), Date.UTC(2020, 0, 31), Date.UTC(2020, 1, 3), Date.UTC(2020, 1, 28), Date.UTC(2020, 2, 2)];
    expect(monthEnds(dates)).toEqual([Date.UTC(2020, 0, 31), Date.UTC(2020, 1, 28)]);
  });

  it("holds the top quintile long and the bottom short, compounding each leg", () => {
    const { dates, symbols, bars, values } = fixture();
    const result = monthlySpread({ dates, symbols, bars, values, costs: NONE, minStocks: 10 });
    expect(result.months.length).toBe(monthEnds(dates).length - 1);
    const first = result.months[0];
    expect(first.long).toBe(4);
    expect(first.short).toBe(4);
    // Long S16–S19 drift +0.6…+0.9%/day, short S00–S03 −1.0…−0.7%/day.
    const leg = (drifts: number[]) => Array.from({ length: first.sessions }).reduce<number>((g) => g * (1 + drifts.reduce((a, b) => a + b, 0) / drifts.length), 1) - 1;
    expect(first.gross).toBeCloseTo(leg([0.006, 0.007, 0.008, 0.009]) - leg([-0.01, -0.009, -0.008, -0.007]), 10);
    expect(first.turnover).toEqual({ long: 1, short: 1 });
    expect(result.months[1].turnover).toEqual({ long: 0, short: 0 });
    expect(result.daily.length).toBe(result.months.reduce((sum, month) => sum + month.sessions, 0));
    expect(result.daily[0].spread).toBeCloseTo(0.0075 + 0.0085, 12);
  });

  it("charges a round trip on stocks entering a leg only", () => {
    const { dates, symbols, bars, values } = fixture();
    const result = monthlySpread({ dates, symbols, bars, values, costs: FUTURES, minStocks: 10 });
    const [first, second] = result.months;
    const price = (symbol: string) => bars.get(symbol)!.find((bar) => bar.t === first.formation)!.c;
    const longCost = ["S16", "S17", "S18", "S19"].reduce((sum, symbol) => sum + roundTripFraction(price(symbol), FUTURES), 0) / 4;
    expect(first.legCost.long).toBeCloseTo(longCost, 12);
    expect(first.cost).toBeCloseTo(first.legCost.long + first.legCost.short, 12);
    expect(first.net).toBeCloseTo(first.gross - first.cost, 12);
    expect(second.cost).toBe(0);
  });

  it("respects membership and skips months with too few stocks", () => {
    const { dates, symbols, bars, values } = fixture();
    const result = monthlySpread({ dates, symbols, bars, values, costs: NONE, minStocks: 10, membership: (symbol) => Number(symbol.slice(1)) < 8 });
    expect(result.months).toHaveLength(0);
    expect(result.skipped).toBeGreaterThan(0);
    const some = monthlySpread({ dates, symbols, bars, values, costs: NONE, minStocks: 5, membership: (symbol) => Number(symbol.slice(1)) < 10 });
    expect(some.months[0].long).toBe(2);
  });

  it("treats a move beyond ±50% as a data error earning 0", () => {
    const { dates, symbols, bars, values } = fixture();
    const broken = bars.get("S19")!.map((bar, i) => (i >= 60 ? { ...bar, c: bar.c * 3 } : bar));
    bars.set("S19", broken);
    const result = monthlySpread({ dates, symbols, bars, values, costs: NONE, minStocks: 10 });
    expect(result.dataErrors).toBe(1);
  });
});

describe("volatility management (Barroso–Santa-Clara)", () => {
  // A daily spread series whose volatility doubles halfway: 4 months of 21 sessions each at σ, then 4 at 2σ.
  const dates = sessions(Date.UTC(2021, 0, 1), 8 * 21 + 1);
  function book(): MonthlySpread {
    const daily = dates.slice(1).map((day, i) => ({ day, spread: (i % 2 ? 1 : -1) * (i < 84 ? 0.01 : 0.02) }));
    const months = Array.from({ length: 8 }, (_, m) => row(dates[m * 21], m % 2 ? 0.02 : -0.01, { end: dates[(m + 1) * 21] }));
    return { months, daily, dataErrors: 0, skipped: 0 };
  }

  it("forecasts monthly variance from the last `lookback` daily returns, without look-ahead", () => {
    const result = volManaged(book(), { lookback: 42, targetMonthlyVol: 0.05 });
    // Months 0–1 have fewer than 42 daily returns before formation: left out of both books.
    expect(result.plain.map((month) => month.formation)).toEqual(result.managed.map((month) => month.formation));
    expect(result.managed[0].formation).toBe(dates[42]);
    // σ̂² = 21 · Σ r² / 42 over the 42 returns up to the formation close.
    expect(result.managed[0].forecastVol).toBeCloseTo(Math.sqrt(21 * 0.0001), 12);
    expect(result.managed[0].weight).toBeCloseTo(0.05 / Math.sqrt(21 * 0.0001), 12);
    // After the switch to 2σ the weight halves.
    const late = result.managed.find((month) => month.formation === dates[6 * 21])!;
    expect(late.weight).toBeCloseTo(result.managed[0].weight / 2, 10);
    expect(late.gross).toBeCloseTo(late.weight * -0.01, 12); // month 6 lost 1%
  });

  it("scales costs with the weight and charges half a round trip on resizing", () => {
    const input = book();
    input.months = input.months.map((month) => ({ ...month, cost: 0.001, net: month.gross - 0.001 }));
    const result = volManaged(input, { lookback: 42, targetMonthlyVol: 0.05 });
    const [a, b] = result.managed;
    const resize = Math.abs(b.weight - a.weight) * ((0.7 * 0.002 + 0.7 * 0.002) / 2);
    expect(b.cost).toBeCloseTo(b.weight * 0.001 + resize, 12);
    expect(b.net).toBeCloseTo(b.gross - b.cost, 12);
  });

  it("by default matches the plain book's realised volatility", () => {
    const result = volManaged(book(), { lookback: 21 });
    const sd = (values: number[]) => {
      const m = values.reduce((a, v) => a + v, 0) / values.length;
      return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
    };
    expect(sd(result.managed.map((month) => month.gross))).toBeCloseTo(sd(result.plain.map((month) => month.gross)), 12);
  });
});

describe("overlay statistics", () => {
  it("measures drawdown, crash periods, splits and the paired difference", () => {
    const start = Date.UTC(2008, 0, 31);
    const nets = [0.1, -0.2, 0.05, -0.1, 0.3, 0.02];
    const rows = nets.map((net, i) => row(start + i * 31 * DAY, net, { end: start + (i + 1) * 31 * DAY }));
    const stats = overlayStats(rows, { regimeStates: new Map([[start, "up" as const]]) });
    expect(stats.months).toBe(6);
    // Peak 1.1 → 1.1 × 0.8 × 1.05 × 0.9 = 0.8316: a 24.4% fall.
    expect(stats.maxDrawdown).toBeCloseTo(1 - 0.8316 / 1.1, 12);
    expect(stats.growth).toBeCloseTo(nets.reduce((g, r) => g * (1 + r), 1), 12);
    expect(stats.worst[0].net).toBe(-0.2);
    const crash = stats.periods.find((period) => period.label === CRASH_PERIODS[0].label)!;
    expect(crash.months).toBe(6);
    expect(stats.periods[2].net).toBeNull();
    expect(stats.regimes.up.months).toBe(6);
    expect(stats.split.first.months + stats.split.last.months).toBe(6);
    expect(stats.sharpeAnnual).toBeCloseTo(stats.sharpe! * Math.sqrt(12), 12);
    expect(stats.weight).toBeNull();
    const managed = rows.map((r) => ({ ...r, net: r.net + 0.01 + (r.net > 0 ? 0.001 : 0) }));
    expect(differenceT(rows, managed)).toBeGreaterThan(10);
  });
});
