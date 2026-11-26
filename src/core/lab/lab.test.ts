import { describe, expect, it } from "vitest";
import { COST_PRESETS } from "@/core/backtest/costs";
import type { SignalScan } from "@/core/backtest/signals";
import type { MarketState } from "@/core/plan/evidence";
import { canonicalJson } from "@/core/repro/canonical";
import { sha256 } from "@/core/repro/sha256";
import type { DailyBar } from "@/core/types";
import { LabInputError, roundTripFraction, runLab, variantKey, type LabInput, type SignalValues } from "./engine";
import { formatLabReport } from "./format";
import { quantileBuckets } from "./quantiles";
import { BUILT_IN_SIGNALS, LAB_SIGNALS, findSignal, resolveParams, sessionParts, signalMeta, topDailyReturns } from "./signals";
import { averageRanks, everyNth, neweyWestSE, neweyWestT, seriesStats, spearman } from "./stats";
import { ideaIdOf, labTrialInputs } from "./trialInputs";
import { summarizeIdea, trialInputError } from "./trials";

const DAY = 86_400_000;
const T0 = Date.UTC(2022, 0, 3);
const NONE = COST_PRESETS.none.model;
const FUTURES = COST_PRESETS["futures-2026"].model;

/** Seeded uniform [0, 1) (LCG): the same numbers on every machine. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
}
/** Seeded standard normal. */
function gauss(next: () => number) {
  return () => Math.sqrt(-2 * Math.log(Math.max(next(), 1e-12))) * Math.cos(2 * Math.PI * next());
}

const days = (n: number) => Array.from({ length: n }, (_, i) => T0 + i * DAY);

/** Bars from a list of daily returns. */
function barsFrom(returns: number[], start = 100, dates = days(returns.length + 1)): DailyBar[] {
  const bars: DailyBar[] = [];
  let close = start;
  for (let i = 0; i <= returns.length; i += 1) {
    if (i > 0) close *= 1 + returns[i - 1];
    bars.push({ t: dates[i], o: close, h: close, l: close, c: close, v: 1e6 });
  }
  return bars;
}

/**
 * `stocks` stocks over `sessions` sessions; stock s drifts `drift(s)` a day plus
 * seeded noise of `noise`. The signal is s itself, so Q5 holds the highest drifts.
 */
function fixture(options: { stocks?: number; sessions?: number; drift?: (s: number, day: number) => number; noise?: number; seed?: number } = {}) {
  const { stocks = 40, sessions = 300, noise = 0, seed = 7 } = options;
  const drift = options.drift ?? ((s: number) => (s - stocks / 2) * 0.0005);
  const dates = days(sessions);
  const normal = gauss(rng(seed));
  const symbols = Array.from({ length: stocks }, (_, s) => `S${String(s).padStart(2, "0")}`);
  const bars = new Map<string, DailyBar[]>();
  symbols.forEach((symbol, s) => {
    bars.set(
      symbol,
      barsFrom(
        Array.from({ length: sessions - 1 }, (_, i) => drift(s, i) + noise * normal()),
        100,
        dates,
      ),
    );
  });
  const values: SignalValues = (_day, symbol) => Number(symbol.slice(1));
  const input: LabInput = { signal: { id: "test", name: "Test", kind: "numeric", params: {} }, dates, symbols, bars, values, costs: NONE, minStocks: 10 };
  return { input, dates, symbols, bars };
}

describe("quantile ranking", () => {
  it("puts the lowest values in Q1 and the highest in the top bucket, in equal parts", () => {
    const values = [5, 1, 9, 3, 7, 2, 8, 0, 6, 4];
    expect([...quantileBuckets(values, 5)]).toEqual([2, 0, 4, 1, 3, 1, 4, 0, 3, 2]);
  });

  it("keeps ties together at their average position", () => {
    const values = [1, 1, 1, 1, 1, 1, 2, 3, 4, 5, 6, 7];
    // The six tied 1s sit at positions 0–5 (average 2.5 → Q2); the rest by position.
    expect([...quantileBuckets(values, 5)]).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("spreads a coarse signal by distinct value: a binary one is always the rest in Q1, matched in Q5", () => {
    for (const matched of [2, 10, 15]) {
      const values = [...Array(20 - matched).fill(0), ...Array(matched).fill(1)];
      const buckets = [...quantileBuckets(values, 5)];
      expect(new Set(buckets.slice(0, 20 - matched))).toEqual(new Set([0]));
      expect(new Set(buckets.slice(20 - matched))).toEqual(new Set([4]));
    }
    expect([...quantileBuckets([0, 1, 2, 2, 1], 5)]).toEqual([0, 2, 4, 4, 2]);
    expect(new Set(quantileBuckets([3, 3, 3, 3, 3], 5))).toEqual(new Set([2]));
  });

  it("handles a count that isn't a multiple of the buckets", () => {
    expect([...quantileBuckets([1, 2, 3, 4, 5, 6, 7], 5)]).toEqual([0, 0, 1, 2, 2, 3, 4]);
  });
});

describe("Newey–West", () => {
  it("matches a hand-computed value (statsmodels HAC, no small-sample correction)", () => {
    // x = 1..5, lag 1: γ0 = 10/5 = 2, γ1 = (2 + 0 + 0 + 2)/5 = 0.8,
    // long-run variance = 2 + 2 · ½ · 0.8 = 2.8, se = √(2.8 / 5), t = 3 / se.
    expect(neweyWestSE([1, 2, 3, 4, 5], 1)).toBeCloseTo(Math.sqrt(0.56), 12);
    expect(neweyWestT([1, 2, 3, 4, 5], 1)).toBeCloseTo(4.008918628686365, 10);
    // Lag 0 is the plain standard error with the population variance: 3 / √(2 / 5).
    expect(neweyWestT([1, 2, 3, 4, 5], 0)).toBeCloseTo(3 / Math.sqrt(0.4), 12);
  });

  it("deflates the t-stat of overlapping h-day returns (lag h − 1)", () => {
    const normal = gauss(rng(42));
    const daily = Array.from({ length: 6000 }, () => 0.0004 + 0.01 * normal());
    const h = 10;
    const overlapping: number[] = [];
    for (let i = 0; i + h <= daily.length; i += 1) overlapping.push(daily.slice(i, i + h).reduce((a, b) => a + b, 0));
    const naive = neweyWestT(overlapping, 0)!;
    const corrected = neweyWestT(overlapping, h - 1)!;
    // Bartlett weights over the 10-day overlap: the variance grows ~6.7× (√6.7 ≈ 2.6) against the naive one.
    expect(naive / corrected).toBeGreaterThan(2.2);
    expect(naive / corrected).toBeLessThan(3.2);
    // The non-overlapping sample tells the same story as the corrected t, not the naive one.
    const independent = neweyWestT(everyNth(overlapping, h), 0)!;
    expect(Math.abs(corrected - independent)).toBeLessThan(Math.abs(naive - independent));
  });

  it("reports moments for the deflated Sharpe ratio", () => {
    const stats = seriesStats([1, 2, 3, 4, 10], 0);
    expect(stats.n).toBe(5);
    expect(stats.mean).toBe(4);
    expect(stats.sharpe).toBeCloseTo(4 / Math.sqrt(12.5), 12);
    expect(stats.skewness!).toBeGreaterThan(0);
    // Pearson kurtosis of a symmetric two-point distribution is 1.
    expect(seriesStats([-1, 1, -1, 1], 0).kurtosis).toBeCloseTo(1, 12);
    expect(seriesStats([], 0).mean).toBeNull();
  });

  it("ranks ties at their average and correlates ranks", () => {
    expect([...averageRanks([10, 20, 20, 5])]).toEqual([2, 3.5, 3.5, 1]);
    expect(spearman([1, 2, 3, 4], [10, 40, 90, 160])).toBeCloseTo(1, 12);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 12);
  });
});

describe("costs", () => {
  it("charges a futures round trip: 2 × 0.05% slippage plus ~0.066% of charges on ₹5 lakh", () => {
    expect(roundTripFraction(1000, NONE)).toBe(0);
    const c = roundTripFraction(1000, FUTURES);
    expect(c).toBeGreaterThan(0.0016);
    expect(c).toBeLessThan(0.0017);
  });

  it("nets two round trips off the long–short spread", () => {
    const { input } = fixture();
    const gross = runLab(input);
    const net = runLab({ ...input, costs: FUTURES });
    for (const [i, h] of net.byHorizon.entries()) {
      expect(h.spread.gross.mean).toBeCloseTo(gross.byHorizon[i].spread.gross.mean!, 12);
      expect(h.spread.gross.mean! - h.spread.net.mean!).toBeCloseTo(h.cost.long! + h.cost.short!, 12);
      expect(h.cost.long!).toBeGreaterThan(0.0015);
    }
    expect(gross.byHorizon[0].spread.net.mean).toBe(gross.byHorizon[0].spread.gross.mean);
  });
});

describe("runLab", () => {
  it("measures exact quintile and spread returns on noiseless drifts", () => {
    const { input } = fixture();
    const report = runLab(input);
    expect(report.quantiles).toBe(5);
    expect(report.horizons).toEqual([1, 5, 10, 21]);
    const one = report.byHorizon[0];
    // 40 stocks: Q5 = s 32…39 (mean drift (35.5 − 20) × 0.0005), Q1 = s 0…7 ((3.5 − 20) × 0.0005).
    expect(one.spread.gross.mean).toBeCloseTo(0.016, 12);
    expect(one.quantiles.map((row) => row.stocks)).toEqual([8, 8, 8, 8, 8]);
    expect(one.quantiles[4].gross).toBeCloseTo(0.00775, 12);
    expect(one.quantiles[0].gross).toBeCloseTo(-0.00825, 12);
    // h sessions compound: mean of (1 + d)^h − 1 over each leg.
    const leg = (from: number) => Array.from({ length: 8 }, (_, i) => (1 + (from + i - 20) * 0.0005) ** 5 - 1).reduce((a, b) => a + b, 0) / 8;
    expect(report.byHorizon[1].spread.gross.mean).toBeCloseTo(leg(32) - leg(0), 12);
    // The last h formation days have no h-session future and are left out.
    expect(report.byHorizon[3].spread.gross.n).toBe(report.period.days - 21);
    // A static ranking never turns over; every day ranks every stock.
    expect(report.dailyTurnover.long).toBe(0);
    expect(report.byHorizon[2].turnover.buckets).toEqual([0, 0, 0, 0, 0]);
    expect(report.universe).toEqual({ symbols: 40, perDay: { min: 40, mean: 40, max: 40 } });
    expect(report.decay).toHaveLength(21);
    expect(report.decay[0].marginal).toBeCloseTo(0.016, 12);
  });

  it("finds an edge in noisy data and none when the signal is random", () => {
    const { input } = fixture({ noise: 0.02, drift: (s) => (s - 20) * 0.0001, sessions: 500 });
    const report = runLab(input);
    const one = report.byHorizon[0];
    expect(one.spread.net.t!).toBeGreaterThan(3);
    expect(one.passes).toBe(true);
    expect(one.ic.mean!).toBeGreaterThan(0);

    const shuffle = rng(99);
    const random = runLab({ ...input, values: () => shuffle() });
    expect(Math.abs(random.byHorizon[0].spread.net.t!)).toBeLessThan(3);
    // A fresh random ranking every day replaces ~80% of each quintile.
    expect(random.dailyTurnover.long!).toBeGreaterThan(0.7);
    expect(random.dailyTurnover.long!).toBeLessThan(0.9);
  });

  it("corrects the t-stat for overlapping horizons", () => {
    const { input } = fixture({ noise: 0.02, drift: (s) => (s - 20) * 0.00005, sessions: 600 });
    const report = runLab(input);
    const h21 = report.byHorizon[3];
    expect(h21.lag).toBe(20);
    // The reported t is Newey–West with lag 20: well below the naive t of the same overlapping series.
    const naive = h21.spread.net.mean! / (h21.spread.net.sd! / Math.sqrt(h21.spread.net.n));
    expect(Math.abs(h21.spread.net.t!)).toBeLessThan(Math.abs(naive) / 2);
    expect(h21.dsr.n).toBe(Math.ceil(h21.spread.net.n / 21));
    expect(h21.dsr.step).toBe(21);
  });

  it("splits by market regime and by the first 60% / last 40% of days", () => {
    // Momentum works in "up" weeks and reverses in "down" weeks.
    const regime = (i: number): MarketState => (Math.floor(i / 5) % 2 === 0 ? "up" : "down");
    const { input, dates } = fixture({ noise: 0.01, sessions: 400, drift: (s, i) => (s - 20) * 0.0004 * (regime(i + 1) === "up" ? 1 : -1) });
    const states = new Map(dates.map((day, i) => [day, regime(i)]));
    const report = runLab({ ...input, regimeStates: states });
    const one = report.byHorizon[0];
    expect(one.regimes.up.net.n + one.regimes.down.net.n).toBe(one.spread.net.n);
    expect(one.regimes.unknown).toBe(0);
    expect(one.regimes.up.gross.mean!).toBeGreaterThan(0.005);
    expect(one.regimes.down.gross.mean!).toBeLessThan(-0.005);
    // 60/40 by ranked days.
    expect(one.split.first.net.n + one.split.last.net.n).toBe(one.spread.net.n);
    expect(one.split.first.net.n / one.spread.net.n).toBeCloseTo(0.6, 1);
    expect(one.split.splitDate).toBe(dates[Math.ceil(report.period.days * 0.6)]);
    // No states: every day counts as unknown.
    expect(runLab(input).byHorizon[0].regimes.unknown).toBe(one.spread.net.n);
  });

  it("ranks only the day's members and keeps delisted stocks until their last close", () => {
    const { input, dates, bars } = fixture({ stocks: 30 });
    // S29 (top value) is a member only in the first half; S28 stops trading on day 100 after a crash.
    const half = dates[150];
    const crashed = bars.get("S28")!.slice(0, 101);
    crashed[100] = { ...crashed[100], c: crashed[99].c * 0.6 };
    const report = runLab({
      ...input,
      bars: new Map([...bars, ["S28", crashed]]),
      membership: (symbol, day) => symbol !== "S29" || day < half,
    });
    expect(report.truncated).toBeGreaterThan(0);
    expect(report.notes.some((note) => note.includes("stopped trading"))).toBe(true);
    // Day 95: S28 is in Q5 and its 10-session return is the crash (closed at day 100).
    const full = runLab({ ...input, bars: new Map([...bars, ["S28", crashed]]), from: dates[95], to: dates[95], minStocks: 10 });
    expect(full.byHorizon[2].quantiles[4].gross!).toBeLessThan(0);
    // S29 counted in the first half only: fewer stocks a day later on.
    expect(report.universe.perDay.max).toBe(30);
    expect(report.universe.perDay.min).toBeLessThan(30);
  });

  it("doesn't mistake a series missing only its newest sessions for a delisted stock", () => {
    const { input, bars } = fixture({ stocks: 30 });
    // S28's newest two bars aren't in yet: its last windows have no future, not a flat exit.
    const lagging = bars.get("S28")!.slice(0, -2);
    const report = runLab({ ...input, bars: new Map([...bars, ["S28", lagging]]) });
    expect(report.truncated).toBe(0);
    expect(report.byHorizon[0].spread.gross.mean).toBeCloseTo(runLab(input).byHorizon[0].spread.gross.mean!, 3);
  });

  it("leaves out forward windows holding a data error (a missed 1:5 split) and counts them", () => {
    const { input, bars } = fixture();
    // S39 (top bucket) "falls 80%" on day 150: a split the adjustment missed.
    const broken = bars.get("S39")!.map((bar, i) => (i >= 150 ? { ...bar, c: bar.c / 5 } : bar));
    const report = runLab({ ...input, bars: new Map([...bars, ["S39", broken]]) });
    expect(report.dataErrors.bars).toBe(1);
    expect(report.dataErrors.symbols).toEqual([{ symbol: "S39", bars: 1 }]);
    // Windows from day 129 (21 sessions before) to day 149 hold the bad session.
    expect(report.dataErrors.observations).toBe(21);
    expect(report.notes.some((note) => note.includes("data errors"))).toBe(true);
    // The outlier never reaches Q5: its mean stays the clean drift's.
    expect(report.byHorizon[0].quantiles[4].gross).toBeCloseTo(0.00775, 4);
    expect(report.byHorizon[3].spread.gross.mean!).toBeGreaterThan(0);
    // With the guard off it would dominate the 21-session spread on those days.
    const unguarded = runLab({ ...input, bars: new Map([...bars, ["S39", broken]]), maxDailyMove: Infinity });
    expect(unguarded.dataErrors.observations).toBe(0);
    expect(unguarded.byHorizon[3].spread.gross.mean!).toBeLessThan(report.byHorizon[3].spread.gross.mean!);
  });

  it("tests a binary signal as matched minus the rest", () => {
    const { input } = fixture({ noise: 0.01 });
    const report = runLab({ ...input, signal: { ...input.signal, kind: "binary" }, values: (_day, symbol) => (Number(symbol.slice(1)) >= 36 ? 1 : 0) });
    expect(report.occupiedBuckets).toBe(2);
    expect(report.notes[0]).toContain("matched minus the rest");
    const rows = report.byHorizon[0].quantiles;
    expect(rows[4].stocks).toBe(4);
    expect(rows[0].stocks).toBe(36);
    expect(rows[2].gross).toBeNull();
    // Matched (s 36…39) vs the rest (s 0…35): (37.5 − 17.5) × 0.0005 = 1% a day.
    expect(report.byHorizon[0].spread.gross.mean!).toBeCloseTo(0.01, 2);
  });

  it("refuses a period with nothing to rank", () => {
    const { input } = fixture({ stocks: 5 });
    expect(() => runLab(input)).toThrow(LabInputError);
    expect(() => runLab({ ...fixture().input, horizons: [0, 99] })).toThrow(LabInputError);
  });

  it("is deterministic (golden-ish fixture)", () => {
    const { input, dates } = fixture({ noise: 0.015, sessions: 260, drift: (s, i) => (s - 20) * 0.00008 * Math.cos(i / 30), seed: 2026 });
    const states = new Map(dates.map((day, i) => [day, (i % 50 < 30 ? "up" : "down") as MarketState]));
    // A ranking that rotates through the stocks, so turnover and decay have something to measure.
    const values: SignalValues = (day, symbol) => Math.sin((day - T0) / DAY / 17 + Number(symbol.slice(1)));
    const run = () => runLab({ ...input, values, costs: FUTURES, regimeStates: states });
    const a = run();
    expect(canonicalJson(a)).toBe(canonicalJson(run()));
    const h5 = a.byHorizon[1];
    expect({
      spread: h5.spread.net.mean!.toFixed(8),
      t: h5.spread.net.t!.toFixed(6),
      ic: h5.ic.mean!.toFixed(6),
      up: h5.regimes.up.net.mean!.toFixed(8),
      first: h5.split.first.net.mean!.toFixed(8),
      turnover: h5.turnover.long!.toFixed(6),
      decay21: a.decay[20].gross!.toFixed(8),
    }).toMatchInlineSnapshot(`
      {
        "decay21": "-0.00198445",
        "first": "-0.00456692",
        "ic": "0.002666",
        "spread": "-0.00483478",
        "t": "-2.775977",
        "turnover": "0.236275",
        "up": "-0.00336680",
      }
    `);
    expect(sha256(canonicalJson(a)).length).toBe(64);
  });
});

describe("forward returns to the open and reversed ranking (#26, #28)", () => {
  /** Stock s gaps up g = (s − 20) × 0.0005 every night and gives it back in the day (open → close −g). */
  function splitFixture(sessions = 200) {
    const dates = days(sessions);
    const symbols = Array.from({ length: 40 }, (_, s) => `S${String(s).padStart(2, "0")}`);
    const bars = new Map<string, DailyBar[]>();
    symbols.forEach((symbol, s) => {
      const g = (s - 20) * 0.0005;
      const list: DailyBar[] = [];
      let close = 100;
      for (let i = 0; i < sessions; i += 1) {
        const open = i === 0 ? close : close * (1 + g);
        close = i === 0 ? close : open * (1 - g);
        list.push({ t: dates[i], o: open, h: Math.max(open, close), l: Math.min(open, close), c: close, v: 1e6 });
      }
      bars.set(symbol, list);
    });
    const input: LabInput = { signal: { id: "test", name: "Test", kind: "numeric", params: {} }, dates, symbols, bars, values: (_day, symbol) => Number(symbol.slice(1)), costs: NONE, minStocks: 10 };
    return { input, dates, symbols, bars };
  }
  const legMean = (from: number, f: (g: number) => number) => Array.from({ length: 8 }, (_, i) => f((from + i - 20) * 0.0005)).reduce((a, b) => a + b, 0) / 8;

  it("measures close → open k sessions later: k = 1 is the overnight gap (the BTST trade)", () => {
    const { input } = splitFixture();
    const toClose = runLab(input);
    const toOpen = runLab({ ...input, forward: "close-open" });
    // Close to close each stock moves (1 + g)(1 − g) − 1 = −g² a day; close to the next open, +g.
    expect(toClose.byHorizon[0].spread.gross.mean).toBeCloseTo(legMean(32, (g) => -g * g) - legMean(0, (g) => -g * g), 12);
    expect(toOpen.byHorizon[0].spread.gross.mean).toBeCloseTo(0.016, 12);
    // Close → open 5 sessions later: four full days and one more night.
    expect(toOpen.byHorizon[1].spread.gross.mean).toBeCloseTo(legMean(32, (g) => (1 - g * g) ** 4 * (1 + g) - 1) - legMean(0, (g) => (1 - g * g) ** 4 * (1 + g) - 1), 12);
    // Marginal: the gap for k = 1, open to open after.
    expect(toOpen.decay[0].marginal).toBeCloseTo(0.016, 12);
    expect(toOpen.decay[1].marginal).toBeCloseTo(legMean(32, (g) => (1 - g) * (1 + g) - 1) - legMean(0, (g) => (1 - g) * (1 + g) - 1), 12);
    expect(toOpen.signal.forward).toBe("close-open");
    expect(toOpen.signal.variantKey).toBe('test {"forward":"close-open"}');
    expect(toClose.signal.variantKey).toBe("test {}");
    expect(toOpen.notes.join(" ")).toContain("close → open");
    // Sold at every open: no turnover saving to claim.
    expect(toOpen.byHorizon[0].netAtTurnover).toBeNull();
    expect(toClose.byHorizon[0].netAtTurnover).not.toBeNull();
    // The same request on the signal meta.
    expect(runLab({ ...input, signal: { ...input.signal, forward: "close-open" } }).byHorizon[0].spread.gross.mean).toBeCloseTo(0.016, 12);
  });

  it("leaves out a close → open window holding a broken open (a close → close one doesn't read it)", () => {
    const { input, bars } = splitFixture();
    const list = bars.get("S35")!;
    list[100] = { ...list[100], o: list[100].o * 3 };
    const toOpen = runLab({ ...input, forward: "close-open", horizons: [1] });
    const toClose = runLab({ ...input, horizons: [1] });
    // The broken open sits in the 1-session windows from day 99 and in the decay's longer ones.
    expect(toOpen.dataErrors.observations).toBeGreaterThan(0);
    expect(toOpen.dataErrors.symbols).toEqual([{ symbol: "S35", bars: 1 }]);
    expect(toClose.dataErrors.observations).toBe(0);
    expect(toOpen.byHorizon[0].spread.gross.mean).toBeCloseTo(0.016, 5); // S35 out of Q5 on the days its window holds the broken open
  });

  it("reverses the ranking: lowest values on top, the spread turns over, the variant is its own trial", () => {
    const { input } = fixture();
    const plain = runLab(input);
    const reversed = runLab({ ...input, signal: { ...input.signal, reversed: true } });
    expect(reversed.byHorizon[0].spread.gross.mean).toBeCloseTo(-plain.byHorizon[0].spread.gross.mean!, 12);
    expect(reversed.byHorizon[0].quantiles[4].gross).toBeCloseTo(plain.byHorizon[0].quantiles[0].gross!, 12);
    expect(reversed.signal.reversed).toBe(true);
    expect(reversed.signal.variantKey).toBe('test {"reverse":1}');
    expect(variantKey("max-21d", { window: 21, top: 1 }, { reversed: true, forward: "close-open" })).toBe('max-21d {"forward":"close-open","reverse":1,"top":1,"window":21}');
    const { trials } = labTrialInputs(reversed, { stampHash: "r", from: null });
    expect(trials[0].params).toEqual({ reverse: 1 });
    expect(trials[0].ideaId).toBe("test");
    expect(formatLabReport(reversed)[0]).toContain("reversed");
  });
});

describe("signals", () => {
  const dates = days(300);
  const bars = new Map<string, DailyBar[]>([
    ["UP", barsFrom(Array.from({ length: 299 }, () => 0.001), 100, dates)],
    ["SPIKE", barsFrom(Array.from({ length: 299 }, (_, i) => (i === 280 ? 0.1 : 0)), 100, dates)],
  ]);
  const ctx = { dates, symbols: [...bars.keys()], bars, benchmark: bars.get("UP")! };
  const build = (id: string, raw?: Record<string, unknown>) => {
    const signal = findSignal(id)!;
    return signal.build(ctx, resolveParams(signal, raw)) as SignalValues;
  };

  it("momentum 12−1 skips the last month and needs a year of history", () => {
    const value = build("momentum-12-1");
    expect(value(dates[251], "UP")).toBeNull();
    expect(value(dates[260], "UP")).toBeCloseTo(1.001 ** 231 - 1, 12);
  });

  it("reversal, volatility and MAX read only bars up to the day", () => {
    expect(build("reversal-1m")(dates[100], "UP")).toBeCloseTo(-(1.001 ** 21 - 1), 12);
    expect(build("volatility-20d")(dates[100], "UP")).toBeCloseTo(0, 6);
    const max = build("max-21d");
    expect(max(dates[280], "SPIKE")).toBe(0);
    expect(max(dates[281], "SPIKE")).toBeCloseTo(0.1, 12);
    expect(max(dates[302 - 1], "SPIKE")).toBeNull();
  });

  it("MAX(top) averages the largest daily returns of the window (#26)", () => {
    const returns = Array.from({ length: 40 }, (_, i) => [0.05, 0.04, 0.03, 0.02, 0.01, 0.06][i % 6] * (i % 2 ? -1 : 1));
    const spiky = new Map([["X", barsFrom(returns, 100, dates.slice(0, 41))]]);
    const max = (top: number) => findSignal("max-21d")!.build({ ...ctx, bars: spiky }, resolveParams(findSignal("max-21d")!, { top })) as SignalValues;
    // Gains in the window are 0.05, 0.03, 0.01 repeating (every other session; the losses are the odd ones).
    const window = returns.slice(40 - 21, 40).sort((a, b) => b - a);
    expect(max(1)(dates[40], "X")).toBeCloseTo(window[0], 12);
    expect(max(5)(dates[40], "X")).toBeCloseTo(window.slice(0, 5).reduce((a, b) => a + b, 0) / 5, 12);
    expect(topDailyReturns(spiky.get("X")!, 20, 21, 1)).toBeNull();
    // The default stays MAX: the largest single day.
    expect(resolveParams(findSignal("max-21d")!, {})).toEqual({ window: 21, top: 1 });
  });

  it("splits each session at the open: overnight + intraday = close to close (#28)", () => {
    const list: DailyBar[] = [];
    let close = 100;
    for (let i = 0; i < 40; i += 1) {
      const open = close * (1 + (i % 3 === 0 ? 0.01 : -0.004));
      const next = open * (1 + (i % 2 ? 0.006 : -0.002));
      list.push({ t: dates[i], o: open, h: Math.max(open, next), l: Math.min(open, next), c: next, v: 1 });
      close = next;
    }
    const split = new Map([["X", list]]);
    const overnight = findSignal("overnight-return")!.build({ ...ctx, bars: split }, { lookback: 10 }) as SignalValues;
    const intraday = findSignal("intraday-return")!.build({ ...ctx, bars: split }, { lookback: 10 }) as SignalValues;
    const at = 30;
    let on = 0;
    let id = 0;
    for (let j = at - 9; j <= at; j += 1) {
      on += Math.log(list[j].o / list[j - 1].c);
      id += Math.log(list[j].c / list[j].o);
      expect(sessionParts(list, j).overnight + sessionParts(list, j).intraday).toBeCloseTo(Math.log(list[j].c / list[j - 1].c), 12);
    }
    expect(overnight(dates[at], "X")).toBeCloseTo(on, 12);
    expect(intraday(dates[at], "X")).toBeCloseTo(id, 12);
    expect(overnight(dates[at], "X")! + intraday(dates[at], "X")!).toBeCloseTo(Math.log(list[at].c / list[at - 10].c), 12);
    expect(overnight(dates[9], "X")).toBeNull();
    // An open that gapped beyond ±50% (unadjusted, a bad print) leaves the windows holding it without a value.
    const broken = list.map((bar, i) => (i === 25 ? { ...bar, o: bar.o * 3 } : bar));
    const brokenValues = findSignal("overnight-return")!.build({ ...ctx, bars: new Map([["X", broken]]) }, { lookback: 10 }) as SignalValues;
    expect(brokenValues(dates[30], "X")).toBeNull();
    expect(brokenValues(dates[35], "X")).not.toBeNull();
    expect(Number.isNaN(sessionParts(broken, 25).overnight)).toBe(true);
  });

  it("clamps parameters and keys each variant", () => {
    const momentum = findSignal("momentum-12-1")!;
    expect(resolveParams(momentum, { lookback: "9999", skip: 2.6, junk: 1 })).toEqual({ lookback: 504, skip: 3 });
    // The trial record's key (trials.ts variantKeyOf): the same variant always gets the same key.
    expect(variantKey("momentum-12-1", resolveParams(momentum, {}))).toBe('momentum-12-1 {"lookback":252,"skip":21}');
    expect(variantKey("momentum-12-1", { skip: 21, lookback: 252 })).toBe(variantKey("momentum-12-1", { lookback: 252, skip: 21 }));
    expect(signalMeta(momentum, { lookback: 252, skip: 21 }).kind).toBe("numeric");
    expect(variantKey("screen:pos-52w-high", {})).toBe("screen:pos-52w-high {}");
  });

  it("turns every screen into a match signal and a score signal", () => {
    expect(BUILT_IN_SIGNALS.map((signal) => signal.id)).toEqual(["momentum-12-1", "reversal-1m", "volatility-20d", "max-21d", "overnight-return", "intraday-return"]);
    expect(LAB_SIGNALS.filter((signal) => signal.group === "screen").length).toBe(LAB_SIGNALS.filter((signal) => signal.group === "screen-score").length);
    expect(new Set(LAB_SIGNALS.map((signal) => signal.id)).size).toBe(LAB_SIGNALS.length);
  });

  it("reads a screen's matches from the scan (1 matched, 0 judged, null in warm-up)", async () => {
    const series = new Map([...bars].map(([symbol, list]) => [symbol, { bars: list, index: new Map(list.map((bar, i) => [bar.t, i])) }]));
    const scan = {
      dates,
      byDate: new Map([[dates[100], [{ symbol: "UP", screenId: "pos-52w-high", date: dates[100], index: 100, score: 42, close: 1, entry: 1, stop: 0.9, target: null }]]]),
      series,
    } as unknown as SignalScan;
    const match = await findSignal("screen:pos-52w-high")!.build({ ...ctx, scan }, {});
    const score = await findSignal("screen-score:pos-52w-high")!.build({ ...ctx, scan }, {});
    expect(match(dates[100], "UP")).toBe(1);
    expect(match(dates[100], "SPIKE")).toBe(0);
    expect(match(dates[10], "UP")).toBeNull();
    expect(score(dates[100], "UP")).toBe(42);
    expect(score(dates[100], "SPIKE")).toBeNull();
  });
});

describe("text report", () => {
  it("prints every section of the report", () => {
    const { input, dates } = fixture({ noise: 0.01 });
    const report = runLab({ ...input, regimeStates: new Map(dates.map((day) => [day, "up" as const])) });
    const text = formatLabReport(report).join("\n");
    for (const section of ["Long–short spread", "Quantile returns", "market regime", "Turnover", "Decay", "Deflated-Sharpe"]) expect(text).toContain(section);
    expect(text).toContain("Variant test");
  });
});

describe("trial record (#24)", () => {
  it("hands over one valid trial per horizon: net spread, non-overlapping, 252 ÷ h a year", () => {
    const { input } = fixture({ noise: 0.02, drift: (s) => (s - 20) * 0.0001, sessions: 400 });
    const report = runLab({ ...input, costs: FUTURES });
    const { trials, skipped } = labTrialInputs(report, { stampHash: "abc", from: null });
    expect(skipped).toEqual([]);
    expect(trials.map((trial) => trial.horizon)).toEqual([1, 5, 10, 21]);
    for (const [i, trial] of trials.entries()) {
      const h = report.byHorizon[i];
      expect(trialInputError(trial)).toBeNull();
      expect(trial.ideaId).toBe(ideaIdOf(report));
      expect(trial.variantKey).toBe(report.signal.variantKey);
      expect(trial.periodsPerYear).toBeCloseTo(252 / h.horizon, 12);
      // Effective T ≈ sessions ÷ horizon: every h-th day of the spread series.
      expect(trial.T).toBe(Math.ceil(h.spread.net.n / h.horizon));
      expect(trial.sharpe).toBe(h.dsr.sharpe);
      expect(trial.tStat).toBe(h.spread.net.t);
      expect(trial.period).toEqual({ from: null, to: report.period.to });
    }
    // The trials module can judge them.
    const summary = summarizeIdea(
      "test",
      trials.map((trial) => ({ ...trial, runAt: 1 })),
    );
    expect(summary.n).toBe(4);
    expect(summary.variants).toHaveLength(4);
    expect(summary.best?.variantKey).toBe(report.signal.variantKey);
  });

  it("skips a horizon it can't judge rather than recording a broken trial", () => {
    const { input } = fixture({ noise: 0.02, sessions: 200 });
    const report = runLab(input);
    // A spread with no variance has no Sharpe ratio (dsr.sharpe null).
    report.byHorizon[0] = { ...report.byHorizon[0], dsr: { ...report.byHorizon[0].dsr, sharpe: null } };
    const { trials, skipped } = labTrialInputs(report, { stampHash: "x", from: null });
    expect(trials.map((trial) => trial.horizon)).toEqual([5, 10, 21]);
    expect(skipped).toEqual([{ horizon: 1, reason: expect.stringMatching(/finite/) }]);
  });
});
