import { describe, expect, it } from "vitest";
import { COST_PRESETS } from "@/core/backtest/costs";
import { seriesOf, type SignalScan } from "@/core/backtest/signals";
import type { DailyBar } from "@/core/types";
import {
  bucketOf,
  eligibleIn,
  marketStates,
  netRMultiple,
  replaySignals,
  roundTripPct,
  scoreCheck,
  splitDay,
  stateOn,
  summarizeEvidence,
  tOverDays,
  verdictOf,
  type EvidenceTrade,
} from "./evidence";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
const bar = (i: number, c: number, extra: Partial<DailyBar> = {}): DailyBar => ({ t: T0 + i * DAY, o: c, h: c * 1.01, l: c * 0.99, c, v: 1e6, ...extra });
const trade = (day: number, netR: number, extra: Partial<EvidenceTrade> = {}): EvidenceTrade => ({
  screenId: "btst-closing-strength",
  symbol: "AAA",
  date: T0 + day * DAY,
  score: 0,
  state: "up",
  entry: 100,
  exit: 100,
  kind: "open",
  grossR: netR + 0.05,
  netR,
  ...extra,
});

describe("market state", () => {
  it("is NIFTY's close against its 200-day average, from the 200th session on", () => {
    const rising = Array.from({ length: 260 }, (_, i) => bar(i, 100 + i));
    const states = marketStates(rising);
    expect(states.has(rising[198].t)).toBe(false);
    expect(states.get(rising[199].t)).toBe("up");
    const falling = [...rising, ...Array.from({ length: 100 }, (_, i) => bar(260 + i, 300 - i * 3))];
    expect(marketStates(falling).get(falling.at(-1)!.t)).toBe("down");
  });

  it("uses the last known state for a session NIFTY lacks", () => {
    const states = new Map([[T0, "up" as const], [T0 + 3 * DAY, "down" as const]]);
    const days = [...states.keys()];
    expect(stateOn(states, days, T0 + DAY)).toBe("up");
    expect(stateOn(states, days, T0 + 5 * DAY)).toBe("down");
    expect(stateOn(states, days, T0 - DAY)).toBeNull();
  });
});

describe("statistics", () => {
  it("weights each signal day once in the t-stat", () => {
    // Day 1 has ten copies of one trade: by trades it would dominate, by days it counts once.
    const busy = [...Array.from({ length: 10 }, () => trade(1, 1)), trade(2, -1), trade(3, 0.5), trade(4, -0.5)];
    const { t, days } = tOverDays(busy);
    expect(days).toBe(4);
    expect(t).toBeCloseTo(0, 5);
  });

  it("splits a bucket at 60% of its own signals, keeping a day's signals together", () => {
    const trades = Array.from({ length: 10 }, (_, i) => trade(i, 0.1));
    expect(splitDay(trades)).toBe(T0 + 6 * DAY);
    expect(splitDay([trade(0, 1), trade(0, 1)])).toBeNull();
  });

  it("passes only with a positive mean in both parts and t > 2", () => {
    const good = Array.from({ length: 60 }, (_, i) => trade(i, i % 3 === 0 ? -0.5 : 0.6));
    expect(bucketOf(good, 0).eligible).toBe(true);
    // Same overall mean, but the recent 40% lost money.
    const fading = Array.from({ length: 60 }, (_, i) => trade(i, i < 36 ? (i % 3 === 0 ? -0.2 : 0.9) : i % 2 ? -0.1 : 0.05));
    const bucket = bucketOf(fading, 0);
    expect(bucket.mean).toBeGreaterThan(0);
    expect(bucket.last.mean).toBeLessThan(0);
    expect(bucket.eligible).toBe(false);
    // Too few trades to judge, however good.
    expect(bucketOf(good.slice(0, 20), 0).eligible).toBe(false);
  });

  it("checks whether the score picks better trades", () => {
    const ranked = Array.from({ length: 90 }, (_, i) => ({ score: i, netR: i / 90 + (i % 2 ? 0.05 : -0.05) }));
    expect(scoreCheck(ranked)?.ranks).toBe(true);
    const noise = Array.from({ length: 90 }, (_, i) => ({ score: i, netR: i % 2 ? 0.2 : -0.1 }));
    expect(scoreCheck(noise)?.ranks).toBe(false);
    expect(scoreCheck(ranked.slice(0, 20))).toBeNull();
  });

  it("labels screens by the states they pass in", () => {
    const pass = bucketOf(Array.from({ length: 60 }, (_, i) => trade(i, i % 3 === 0 ? -0.5 : 0.6)), 0);
    const fail = bucketOf(Array.from({ length: 60 }, (_, i) => trade(i, -0.1 + (i % 2) * 0.05)), 0);
    expect(verdictOf(pass, pass, pass)).toBe("any");
    expect(verdictOf(pass, fail, pass)).toBe("uptrend");
    expect(verdictOf(fail, fail, fail)).toBe("none");
    expect(verdictOf(fail, fail, bucketOf([trade(0, 1)], 0))).toBe("few");
    const evidence = { screenId: "x", all: pass, up: pass, down: fail, verdict: "uptrend" as const };
    expect(eligibleIn(evidence, "up")).toBe(true);
    expect(eligibleIn(evidence, "down")).toBe(false);
    expect(eligibleIn(evidence, null)).toBe(false);
  });
});

describe("replay", () => {
  const costs = COST_PRESETS["futures-2026"].model;

  it("costs about 0.16% of the position a round trip on the 2026 futures preset", () => {
    expect(roundTripPct(costs)).toBeGreaterThan(0.15);
    expect(roundTripPct(costs)).toBeLessThan(0.18);
    expect(roundTripPct(COST_PRESETS.none.model)).toBe(0);
  });

  it("nets the costs out of R", () => {
    expect(netRMultiple({ entry: 100, exit: 102, risk: 2, qty: 100, costs: COST_PRESETS.none.model })).toBeCloseTo(1, 10);
    expect(netRMultiple({ entry: 100, exit: 102, risk: 2, qty: 100, costs })).toBeLessThan(1);
  });

  it("buys a BTST signal at its close and sells at the next open, in R of the planned risk", () => {
    const bars = [bar(0, 100), bar(1, 100, { o: 101, h: 102, l: 100.5, c: 101.5 }), bar(2, 101)];
    const scan: SignalScan = {
      dates: bars.map((b) => b.t),
      firstSignalDate: bars[0].t,
      firstByScreen: {},
      byDate: new Map([[bars[0].t, [{ symbol: "AAA", screenId: "btst-closing-strength", date: bars[0].t, index: 0, score: 50, close: 100, entry: 100, stop: 98, target: null }]]]),
      series: new Map([["AAA", seriesOf(bars)]]),
      benchmark: [],
      symbols: 1,
      signals: 1,
    };
    const [result] = replaySignals(scan, { costs, lots: { AAA: 500 }, states: new Map([[bars[0].t, "up"]]) });
    expect(result.exit).toBeCloseTo(101, 6);
    expect(result.grossR).toBeCloseTo(0.5, 6);
    expect(result.netR).toBeLessThan(result.grossR);
    expect(result.state).toBe("up");

    const table = summarizeEvidence([result], { dates: scan.dates, symbols: 1, lastState: "up" });
    expect(table.screens["btst-closing-strength"].up.n).toBe(1);
    expect(table.screens["btst-closing-strength"].verdict).toBe("few");
  });

  it("skips a signal without its full holding period after it", () => {
    const bars = [bar(0, 100), bar(1, 101)];
    const scan: SignalScan = {
      dates: bars.map((b) => b.t),
      firstSignalDate: bars[0].t,
      firstByScreen: {},
      byDate: new Map([[bars[1].t, [{ symbol: "AAA", screenId: "btst-closing-strength", date: bars[1].t, index: 1, score: 50, close: 101, entry: 101, stop: 99, target: null }]]]),
      series: new Map([["AAA", seriesOf(bars)]]),
      benchmark: [],
      symbols: 1,
      signals: 1,
    };
    expect(replaySignals(scan, { costs, lots: {}, states: new Map() })).toHaveLength(0);
  });
});
