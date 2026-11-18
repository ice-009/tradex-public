// Performance benchmarks (issue #14). Each benchmark times one hot path of the
// app on the deterministic fixtures in ./fixtures.ts and reports a metric in
// milliseconds next to its budget. perf/run.mjs bundles this file and runs
// each benchmark in a fresh Node process; see CONTRIBUTING.md ("Performance budgets").
//
//   node perf/run.mjs                      # every benchmark, budgets only
//   node perf/run.mjs --base <checkout>    # also compare with another checkout (CI: the merge base)

import { installDom, fakeContainer, flushFrames } from "./dom";
import { chartBars, fnoUniverse, FNO_SYMBOLS, SESSIONS_5Y } from "./fixtures";
import type { IndicatorConfig } from "@/core/types";

export interface Metric {
  /** The number compared against the budget and against the base. */
  ms: number;
  /** Absolute budget in ms, enforced (null = report only). */
  budget: number | null;
  /**
   * The issue's goal, when the code doesn't meet it yet and `budget` is a looser
   * ceiling meanwhile. Going over it is reported as a warning, not a failure.
   */
  target?: number;
  /** Whether a slowdown against the base fails the run (cold timings are too noisy to). */
  compare: boolean;
  /** Context for the report (counts, sub-timings). Not compared. */
  info?: Record<string, number | string>;
}

const DAY = 86_400_000;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const round = (value: number, digits = 2) => Number(value.toFixed(digits));

function time<T>(fn: () => T): [number, T] {
  const start = performance.now();
  const value = fn();
  return [performance.now() - start, value];
}

async function timeAsync<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const start = performance.now();
  const value = await fn();
  return [performance.now() - start, value];
}

// ------------------------------------------------------------------ chart

/** What a fresh daily chart shows: EMA 20 + SMA 50 overlays, an RSI pane, and the auto chart patterns. */
const CHART_INDICATORS: IndicatorConfig[] = [
  { id: "ema", type: "ema", params: { length: 20 }, colors: { ma: "#2962ff" } },
  { id: "sma", type: "sma", params: { length: 50 }, colors: { ma: "#ff9800" } },
  { id: "rsi", type: "rsi", params: { length: 14 }, colors: { rsi: "#7e57c2" } },
  { id: "auto-patterns", type: "patterns", params: {}, colors: {} },
];

const CHART_WIDTH = 1600;
const CHART_HEIGHT = 900;

async function chartModule() {
  installDom();
  return import("@/chart/engine");
}

/** Open a chart on 2,000 daily bars: construct the engine, load data and indicators, render the first frame. */
async function chartFirstPaint(): Promise<Record<string, Metric>> {
  const { ChartEngine } = await chartModule();
  const bars = chartBars(2_000, "daily");
  const samples: number[] = [];
  let ops = 0;
  for (let run = 0; run < 41; run += 1) {
    const [ms] = time(() => {
      const engine = new ChartEngine(fakeContainer(CHART_WIDTH, CHART_HEIGHT));
      engine.setIndicators(CHART_INDICATORS);
      engine.setData(bars, { intervalMs: DAY, intraday: false, resetView: true });
      ops = flushFrames();
      engine.destroy();
    });
    samples.push(ms);
  }
  return {
    "chart.firstPaint.2k": { ms: round(median(samples.slice(1))), budget: 300, compare: true, info: { runs: samples.length - 1, canvasOps: ops } },
    "chart.firstPaint.2k.cold": { ms: round(samples[0]), budget: 300, compare: false, info: { note: "first open in a fresh process (JIT cold)" } },
  };
}

/** Pan and zoom across 50,000 five-minute bars, one rendered frame per step. */
async function chartPanZoom(): Promise<Record<string, Metric>> {
  const { ChartEngine } = await chartModule();
  const bars = chartBars(50_000, "5m");
  const engine = new ChartEngine(fakeContainer(CHART_WIDTH, CHART_HEIGHT));
  engine.setIndicators(CHART_INDICATORS);
  const [loadMs] = time(() => {
    engine.setData(bars, { intervalMs: 5 * 60_000, intraday: true, resetView: true });
    flushFrames();
  });

  const frames: number[] = [];
  let maxOps = 0;
  const frame = (step: () => void) => {
    const [ms, ops] = time(() => {
      step();
      return flushFrames();
    });
    frames.push(ms);
    maxOps = Math.max(maxOps, ops);
  };
  // Warm the render path, then: zoom all the way out, pan back through the whole
  // history and forward again (the worst case: ~3,000 bars on screen), zoom all
  // the way in, and pan at a medium zoom.
  for (let i = 0; i < 20; i += 1) frame(() => engine.panBy(i % 2 ? 5 : -5));
  frames.length = 0;
  for (let i = 0; i < 30; i += 1) frame(() => engine.zoomBy(0.8));
  const step = Math.max(1, Math.round(engine.visibleBarCount() / 8));
  for (let i = 0; i < Math.ceil(50_000 / step); i += 1) frame(() => engine.panBy(-step));
  for (let i = 0; i < Math.ceil(50_000 / step); i += 1) frame(() => engine.panBy(step));
  for (let i = 0; i < 40; i += 1) frame(() => engine.zoomBy(1.25));
  for (let i = 0; i < 12; i += 1) frame(() => engine.zoomBy(0.8));
  for (let i = 0; i < 150; i += 1) frame(() => engine.panBy(i < 75 ? -40 : 40));
  engine.destroy();

  const mean = frames.reduce((sum, ms) => sum + ms, 0) / frames.length;
  return {
    // Half a 60 Hz frame for the engine's own work; the rest is left for the browser to rasterise.
    "chart.panZoom.50k.p95": { ms: round(percentile(frames, 95)), budget: 8, compare: true, info: { frames: frames.length, meanMs: round(mean), maxMs: round(Math.max(...frames)), maxCanvasOps: maxOps } },
    "chart.load.50k": { ms: round(loadMs), budget: null, compare: false, info: { note: "setData + indicators + first frame, cold" } },
  };
}

// ------------------------------------------------------------------ screener

/** A full F&O screener pass on stored bars plus today's live bar: features, every screen, market overview. */
async function screenerScan(): Promise<Record<string, Metric>> {
  const { computeFeatures } = await import("@/core/screener/features");
  const { buildFeatureSets, marketOverview, runScreens } = await import("@/core/screener/run");
  const universe = fnoUniverse();
  const stored = (symbol: string) => universe.bars.get(symbol) ?? [];
  const samples: number[] = [];
  let matches = 0;
  for (let run = 0; run < 7; run += 1) {
    const [ms, results] = time(() => {
      const sets = buildFeatureSets(universe.symbols, stored, universe.live);
      const nifty = computeFeatures("NIFTY", universe.benchmark, false);
      const results = runScreens(sets, { niftyRet126: nifty.ret126 }, universe.members);
      marketOverview(sets.live, universe.members);
      return results;
    });
    samples.push(ms);
    matches = Object.values(results).reduce((sum, rows) => sum + rows.length, 0);
  }
  return {
    "screener.scan.fno": {
      ms: round(median(samples.slice(1))),
      budget: 2_000,
      compare: true,
      info: { symbols: FNO_SYMBOLS, sessions: SESSIONS_5Y, matches, coldMs: round(samples[0]) },
    },
  };
}

// ------------------------------------------------------------------ backtest

/**
 * A portfolio backtest of every screen over 5 years × the F&O list: the signal scan plus the portfolio simulation.
 *
 * Target 10 s (issue #14), not met yet: the scan computes every stock's features
 * from scratch on every session (~270,000 computeFeatures calls on 260-bar
 * windows), ~12 s on an Apple-silicon laptop and ~33 s on a GitHub runner.
 * Until it is made incremental or parallel, CI enforces a 40 s ceiling (the
 * runner's time + ~20%) and the 20% regression check against the base.
 */
async function backtest(): Promise<Record<string, Metric>> {
  const { scanSignals } = await import("@/core/backtest/signals");
  const { runPortfolio } = await import("@/core/backtest/portfolio");
  const { COST_PRESETS } = await import("@/core/backtest/costs");
  const { SCREENS } = await import("@/core/screener/screens");
  const universe = fnoUniverse();
  // One run per process (~10 s): run.mjs repeats the process for each round.
  const [scanMs, scan] = await timeAsync(() =>
    scanSignals({ symbols: universe.symbols, getBars: (symbol) => universe.bars.get(symbol) ?? [], benchmark: universe.benchmark }),
  );
  const [simMs, result] = time(() =>
    runPortfolio(scan, {
      screenIds: SCREENS.map((screen) => screen.id),
      from: null,
      to: null,
      holdBars: null,
      capital: 10_00_000,
      riskPct: 1,
      maxPositions: 5,
      maxLeverage: 4,
      entry: "signal-close",
      costs: COST_PRESETS["futures-2026"].model,
      lots: null,
      oosFraction: 0.3,
    }),
  );
  return {
    "backtest.5y.fno": {
      ms: round(scanMs + simMs),
      budget: 40_000,
      target: 10_000,
      compare: true,
      info: { symbols: FNO_SYMBOLS, sessions: SESSIONS_5Y, signals: scan.signals, trades: result.trades.length, scanMs: round(scanMs), simMs: round(simMs) },
    },
  };
}

export const BENCHMARKS: Record<string, () => Promise<Record<string, Metric>>> = {
  "chart-first-paint": chartFirstPaint,
  "chart-pan-zoom": chartPanZoom,
  screener: screenerScan,
  backtest,
};

// Entry point when bundled by run.mjs: `node bundle.mjs <benchmark>` prints one JSON line.
const name = process.argv[2];
if (name === "--list") console.log(Object.keys(BENCHMARKS).join("\n"));
else if (name) {
  const bench = BENCHMARKS[name];
  if (!bench) {
    console.error(`Unknown benchmark "${name}". Known: ${Object.keys(BENCHMARKS).join(", ")}`);
    process.exit(2);
  }
  bench().then(
    (metrics) => console.log(`PERF_RESULT ${JSON.stringify(metrics)}`),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
