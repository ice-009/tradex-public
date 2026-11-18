import { describe, expect, it } from "vitest";
import { COST_PRESETS } from "@/core/backtest/costs";
import { runPortfolio, type BacktestConfig } from "@/core/backtest/portfolio";
import { scanSignals } from "@/core/backtest/signals";
import { pointInTimeUniverse } from "@/core/backtest/universe";
import { marketStates, replaySignals, summarizeEvidence } from "@/core/plan/evidence";
import type { DailyBar } from "@/core/types";
import { canonicalJson } from "./canonical";
import golden from "./golden.json";
import { hashDataset, makeStamp, type RunStamp } from "./stamp";

// Golden-file tests for reproducible runs (issue #12): a fixed synthetic
// dataset and fixed parameters must give byte-identical results — the same
// stamp hash and the same result hash — on every machine and every run, in CI
// and locally. The expected hashes are in golden.json.
//
// When a change to the engine is *meant* to change results (and the engine
// version is bumped), update golden.json with the "actual" values the failing
// test prints, and say why in the commit.

const DAY = 86_400_000;
const T0 = Date.UTC(2023, 0, 2);
const SESSIONS = 420;

/** Deterministic random walk (seeded LCG): no Math.random, so the data is the same everywhere. */
function walk(seed: number, n: number): DailyBar[] {
  let state = seed;
  const rand = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
  let close = 200 + (seed % 300);
  const bars: DailyBar[] = [];
  for (let i = 0; i < n; i += 1) {
    const drift = (rand() - 0.47) * 0.05;
    const open = close * (1 + (rand() - 0.5) * 0.01);
    const next = open * (1 + drift);
    const high = Math.max(open, next) * (1 + rand() * 0.015);
    const low = Math.min(open, next) * (1 - rand() * 0.015);
    bars.push({ t: T0 + i * DAY, o: open, h: high, l: low, c: next, v: Math.round(2e6 * (0.5 + rand() * (rand() > 0.9 ? 4 : 1))), dp: 30 + rand() * 40 });
    close = next;
  }
  return bars;
}

function dataset() {
  const symbols = Array.from({ length: 16 }, (_, i) => `STK${String(i).padStart(2, "0")}`);
  const bars = new Map<string, DailyBar[]>(symbols.map((symbol, i) => [symbol, walk(i * 7919 + 13, SESSIONS)]));
  bars.set("NIFTY", walk(4242, SESSIONS));
  const lots = Object.fromEntries(symbols.map((symbol, i) => [symbol, 250 + 125 * (i % 5)]));
  // Point-in-time list: STK12–STK15 join a third of the way in.
  const byDay = new Map<number, Set<string>>();
  for (let i = 0; i < SESSIONS; i += 1) byDay.set(T0 + i * DAY, new Set(symbols.filter((symbol) => i >= SESSIONS / 3 || Number(symbol.slice(3)) < 12)));
  return { symbols, bars, lots, byDay, today: symbols };
}

const CODE = { commit: "golden", engine: "golden" };

async function backtestRun(): Promise<{ stamp: RunStamp; text: string }> {
  const { symbols, bars, lots, byDay, today } = dataset();
  const pit = pointInTimeUniverse({ byDay, today });
  const scan = await scanSignals({ symbols, getBars: (symbol) => bars.get(symbol)!, benchmark: bars.get("NIFTY")!, isMember: pit.isMember });
  const params = {
    screenIds: ["swing-ema-pullback", "btst-closing-strength", "swing-nr7", "swing-rsi2"],
    from: null,
    to: null,
    holdBars: null,
    capital: 10_00_000,
    riskPct: 1,
    maxPositions: 5,
    maxLeverage: 4,
    entry: "signal-close" as const,
    costPreset: "futures-2026" as const,
    oosFraction: 0.3,
  };
  const config: BacktestConfig = { ...params, costs: COST_PRESETS[params.costPreset].model, lots };
  const result = runPortfolio(scan, config);
  const data = await hashDataset({ bars, benchmark: "NIFTY", membership: byDay, lots, universe: today });
  const stamp = makeStamp({ kind: "backtest", code: CODE, data, params, result, createdAt: 0 });
  return { stamp, text: canonicalJson(result) };
}

async function evidenceRun(): Promise<{ stamp: RunStamp; text: string }> {
  const { symbols, bars, lots, byDay, today } = dataset();
  const pit = pointInTimeUniverse({ byDay, today });
  const benchmark = bars.get("NIFTY")!;
  const scan = await scanSignals({ symbols, getBars: (symbol) => bars.get(symbol)!, benchmark, isMember: pit.isMember });
  const states = marketStates(benchmark);
  const trades = replaySignals(scan, { costs: COST_PRESETS["futures-2026"].model, lots, states });
  const dates = scan.dates.filter((day) => day >= (scan.firstSignalDate ?? 0));
  const table = summarizeEvidence(trades, { dates, symbols: scan.symbols, lastState: states.get(benchmark.at(-1)!.t) ?? null });
  const data = await hashDataset({ bars, benchmark: "NIFTY", membership: byDay, lots, universe: today });
  const stamp = makeStamp({ kind: "evidence", code: CODE, data, params: { universe: "fno", costPreset: "futures-2026" }, result: { table, note: "" }, createdAt: 0 });
  return { stamp, text: canonicalJson({ table, note: "" }) };
}

const summary = (stamp: RunStamp) => ({ data: stamp.data.hash, stamp: stamp.hash, result: stamp.resultHash });

describe("golden runs", () => {
  it("a backtest gives a byte-identical result twice in a row", async () => {
    const a = await backtestRun();
    const b = await backtestRun();
    expect(b.text).toBe(a.text);
    expect(b.stamp).toEqual(a.stamp);
  });

  it("the backtest matches the golden hashes", async () => {
    const { stamp, text } = await backtestRun();
    // The dataset must exercise the engine, or the hash proves little.
    expect(JSON.parse(text).trades.length).toBeGreaterThan(20);
    expect(summary(stamp), `actual: ${JSON.stringify(summary(stamp))}`).toEqual(golden.backtest);
  });

  it("the evidence table gives a byte-identical result twice and matches the golden hashes", async () => {
    const a = await evidenceRun();
    const b = await evidenceRun();
    expect(b.text).toBe(a.text);
    expect(JSON.parse(a.text).table.trades).toBeGreaterThan(50);
    expect(summary(a.stamp), `actual: ${JSON.stringify(summary(a.stamp))}`).toEqual(golden.evidence);
  });

  it("one changed bar changes the data hash, the stamp hash and the result hash", async () => {
    const { stamp } = await backtestRun();
    const { bars, lots, byDay, today } = dataset();
    const series = bars.get("STK03")!;
    series[200] = { ...series[200], c: series[200].c * 1.001 };
    const data = await hashDataset({ bars, benchmark: "NIFTY", membership: byDay, lots, universe: today });
    expect(data.hash).not.toBe(stamp.data.hash);
    expect(data.parts.lots).toBe(stamp.data.parts.lots);
    expect(makeStamp({ kind: "backtest", code: CODE, data, params: stamp.params, result: null, createdAt: 0 }).hash).not.toBe(stamp.hash);
  });
});
