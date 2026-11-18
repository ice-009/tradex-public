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
vi.mock("@/server/providers/universe", () => ({ UNIVERSES: [], getUniverse: async () => SYMBOLS.map((symbol) => ({ symbol })) }));
vi.mock("@/server/providers/foData", () => ({ foMembership: async () => new Map() }));
vi.mock("@/server/providers/reference", () => ({ getLotSizes: async () => ({ lots: Object.fromEntries(SYMBOLS.map((symbol) => [symbol, 500])), source: "hub" }) }));
vi.mock("@/server/providers/dailyBars", () => ({ DEEP_HISTORY_DAYS: 5 * 365 }));
vi.mock("@/server/providers/hub", () => ({ lastHubStatus: () => null }));
vi.mock("./screener", () => ({ BENCHMARK: "NIFTY", parseUniverse: (id: string | null) => id ?? "test" }));

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
    expect(original.stamp).toMatchObject({ kind: "backtest", code: { engine: "backtest/6" }, data: { symbols: SYMBOLS, to: T0 + 319 * DAY } });

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

  it("refuses something that isn't a backtest stamp", async () => {
    expect(await replayBacktest({ stamp: { schema: 1, kind: "evidence" } })).toMatchObject({ status: "error" });
    expect(await replayBacktest(null)).toMatchObject({ status: "error" });
  });
});
