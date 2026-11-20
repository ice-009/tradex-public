import { describe, expect, it, vi } from "vitest";
import type { BacktestRequest } from "@/contracts/api";
import { compareRuns } from "@/core/repro/stamp";
import type { DailyBar } from "@/core/types";

// "Re-run this" for backtests (issue #12): a stamped run replayed on the
// server gives the same stamp and result hash — also after a new session was
// stored, since the replay reads the bars up to the stamped last session only —
// and says what changed when a stored bar was rewritten.

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

function walk(seed: number, n: number): DailyBar[] {
  let state = seed;
  const rand = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
  let close = 200 + (seed % 300);
  const bars: DailyBar[] = [];
  for (let i = 0; i < n; i += 1) {
    const drift = (rand() - 0.47) * 0.05;
    const open = close * (1 + (rand() - 0.5) * 0.01);
    const next = open * (1 + drift);
    bars.push({ t: T0 + i * DAY, o: open, h: Math.max(open, next) * (1 + rand() * 0.015), l: Math.min(open, next) * (1 - rand() * 0.015), c: next, v: Math.round(2e6 * (0.5 + rand())), dp: 30 + rand() * 40 });
    close = next;
  }
  return bars;
}

const SYMBOLS = Array.from({ length: 12 }, (_, i) => `S${String(i).padStart(2, "0")}`);
const store = new Map<string, DailyBar[]>([...SYMBOLS.map((symbol, i): [string, DailyBar[]] => [symbol, walk(i * 7919 + 13, 320)]), ["NIFTY", walk(4242, 320)]]);

vi.mock("@/server/providers/dailyStore", () => ({
  screenerStore: {
    getBars: (symbol: string) => store.get(symbol) ?? [],
    hasData: async () => true,
    ensureFresh: () => undefined,
    isSyncing: () => false,
    progress: { queued: 0, message: "", phase: "idle" },
  },
}));
vi.mock("@/server/providers/universe", () => ({ UNIVERSES: [] }));
// Reference data through asOf: no F&O files, lots known from 8 Jul 2024 (1,000 a lot, today 500),
// and S02 split 1:2 on 2 Sep 2024 (so its earlier lot is 2,000 of today's shares).
vi.mock("@/server/providers/asOf", async () => {
  const { referenceTimeline, orElse } = await import("@/core/reference/pointInTime");
  const { istParts } = await import("@/core/market/session");
  const asOfSpan = async () =>
    referenceTimeline({
      today: istParts().day,
      fo: { byDay: new Map(), span: null, stored: null },
      lots: {
        changes: new Map(SYMBOLS.map((symbol) => [symbol, [{ day: Date.UTC(2024, 6, 8), lot: 1000 }]])),
        knownFrom: Date.UTC(2024, 6, 8),
        lastDay: Date.UTC(2024, 10, 15),
        current: Object.fromEntries(SYMBOLS.map((symbol) => [symbol, 500])),
      },
      ban: null,
      results: null,
      catalog: null,
      universes: new Map([["test", SYMBOLS.map((symbol) => ({ symbol, name: symbol, industry: "" }))]]),
      renames: null,
      factors: new Map(SYMBOLS.map((symbol) => [symbol, symbol === "S02" ? [{ day: Date.UTC(2024, 8, 2), factor: 0.5 }] : []])),
    });
  return { asOfSpan, orElse };
});
vi.mock("@/server/providers/dailyBars", () => ({ DEEP_HISTORY_DAYS: 5 * 365 }));
vi.mock("@/server/providers/hub", () => ({ lastHubStatus: () => null }));
vi.mock("./screener", () => ({ BENCHMARK: "NIFTY", parseUniverse: (id: string | null) => id ?? "test" }));

// A period before the store (#18): bars from the hub's long history, 2007–2009, with NIFTY's
// stand-in (the equal-weight basket) only — NSE's index file starts in 2012.
const LONG_T0 = Date.UTC(2006, 9, 2);
const shift = (bars: DailyBar[]) => bars.map((bar, i) => ({ ...bar, t: LONG_T0 + i * DAY }));
const longSeries = new Map<string, DailyBar[]>([...SYMBOLS.map((symbol, i): [string, DailyBar[]] => [symbol, shift(walk(i * 104729 + 7, 940))]), ["EW-NIFTY50", shift(walk(777, 940))]]);
const longLoads: Array<{ symbols: string[]; from: number; to: number }> = [];
vi.mock("@/server/providers/longStore", () => ({
  longBars: {
    load: async (symbols: string[], from: number, to: number) => {
      longLoads.push({ symbols, from, to });
      const bars = new Map([...longSeries].filter(([symbol]) => symbols.includes(symbol)).map(([symbol, series]) => [symbol, series.filter((bar) => bar.t >= from && bar.t <= to)]));
      return { from, to, bars, missing: symbols.filter((symbol) => !bars.has(symbol)), incomplete: [], renamed: new Map([["S01", ["OLD01", "S01"]]]), scaled: new Map(), gaps: new Map() };
    },
  },
}));

const request: BacktestRequest = {
  universe: "test",
  screenIds: ["swing-ema-pullback", "btst-closing-strength", "swing-rsi2"],
  from: null,
  to: null,
  holdBars: null,
  capital: 10_00_000,
  riskPct: 1,
  maxPositions: 5,
  maxLeverage: 4,
  entry: "signal-close",
  costPreset: "futures-2026",
  sizing: "lots",
  oosFraction: 0.3,
};

// Each case runs whole backtests; slow under coverage instrumentation.
describe("backtest replay", { timeout: 60_000 }, async () => {
  const { replayBacktest, runBacktest } = await import("./backtest");
  const ready = async (promise: ReturnType<typeof runBacktest>) => {
    const answer = await promise;
    if (answer.status !== "ready") throw new Error(answer.error);
    return answer;
  };

  it("reproduces a run: same stamp, same result hash, even after a new session is stored", async () => {
    const original = await ready(runBacktest(request));
    expect(original.result.trades.length).toBeGreaterThan(5);
    // Point-in-time lots: before 8 Jul 2024 today's (500), from then that day's (1,000; S02 2,000 before its split).
    const lotted = original.result.trades.filter((trade) => trade.lots);
    const lotOf = (trade: (typeof lotted)[number]) => trade.qty / trade.lots!;
    const lotsWhere = (keep: (trade: (typeof lotted)[number]) => boolean) => [...new Set(lotted.filter(keep).map(lotOf))];
    expect(lotsWhere((trade) => trade.signalDate < Date.UTC(2024, 6, 8))).toEqual([500]);
    expect(lotsWhere((trade) => trade.signalDate >= Date.UTC(2024, 6, 8) && trade.symbol !== "S02")).toEqual([1000]);
    expect(lotsWhere((trade) => trade.symbol === "S02" && trade.signalDate >= Date.UTC(2024, 6, 8) && trade.signalDate < Date.UTC(2024, 8, 2)).every((lot) => lot === 2000)).toBe(true);
    expect(original.result.warnings.join(" ")).toMatch(/Lot sizes: as listed on each day \(NSE F&O bhavcopy\) on \d+ of \d+ sessions/);
    expect(Object.keys(original.stamp.data.parts).sort()).toEqual(["bars", "lotHistory", "lots", "universe"]);
    expect(original.stamp).toMatchObject({ kind: "backtest", code: { engine: "backtest/7" }, data: { symbols: SYMBOLS, to: T0 + 319 * DAY } });

    const replay = await ready(replayBacktest(JSON.parse(JSON.stringify({ stamp: original.stamp }))));
    expect(replay.runtime.cached).toBe(false);
    expect(replay.stamp.hash).toBe(original.stamp.hash);
    expect(replay.stamp.resultHash).toBe(original.stamp.resultHash);

    // A new session arrives: a fresh run moves on, the replay of the old stamp doesn't.
    for (const [symbol, bars] of store) store.set(symbol, [...bars, { ...bars.at(-1)!, t: bars.at(-1)!.t + DAY }]);
    const today = await ready(runBacktest(request));
    expect(today.stamp.data.to).toBe(T0 + 320 * DAY);
    expect(today.stamp.hash).not.toBe(original.stamp.hash);
    const again = await ready(replayBacktest({ stamp: original.stamp }));
    expect(again.stamp.hash).toBe(original.stamp.hash);
    expect(compareRuns(original, again)).toMatchObject({ identical: true });
  });

  it("says which input changed when a stored bar was rewritten", async () => {
    const original = await ready(runBacktest(request));
    const bars = store.get("S03")!.map((bar, i) => (i === 250 ? { ...bar, c: bar.c * 1.2, h: bar.h * 1.2 } : bar));
    store.set("S03", bars);
    const replay = await ready(replayBacktest({ stamp: original.stamp }));
    const comparison = compareRuns(original, replay);
    expect(comparison.sameInputs).toBe(false);
    expect(comparison.changes[0]).toMatch(/^Data changed: bars\./);
  });

  it("runs a period older than the store from the hub's long history, and replays it", async () => {
    const crash = { ...request, from: Date.UTC(2008, 0, 1), to: Date.UTC(2009, 2, 31) };
    const original = await ready(runBacktest(crash));
    // Read from 440 days before the period (warm-up) to its end — nothing later.
    expect(longLoads.at(-1)).toMatchObject({ from: crash.from - 440 * DAY, to: crash.to });
    expect(original.result.period.from).toBeGreaterThanOrEqual(crash.from);
    expect(original.result.period.to).toBeLessThanOrEqual(crash.to);
    expect(original.result.trades.length).toBeGreaterThan(0);
    const warnings = original.result.warnings.join("\n");
    expect(warnings).toMatch(/Long period/);
    expect(warnings).toMatch(/equal-weight NIFTY 50 basket/);
    expect(warnings).toMatch(/OLD01 → S01/);
    expect(original.stamp.data.to).toBeLessThanOrEqual(crash.to);

    const replay = await ready(replayBacktest(JSON.parse(JSON.stringify({ stamp: original.stamp }))));
    expect(compareRuns(original, replay)).toMatchObject({ identical: true });
    // The store's own runs are untouched by it.
    const stored = await ready(runBacktest(request));
    expect(stored.result.warnings.join("\n")).not.toMatch(/Long period/);
  });

  it("refuses something that isn't a backtest stamp", async () => {
    expect(await replayBacktest({ stamp: { schema: 1, kind: "evidence" } })).toMatchObject({ status: "error" });
    expect(await replayBacktest(null)).toMatchObject({ status: "error" });
  });
});
