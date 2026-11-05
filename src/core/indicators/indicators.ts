import { DAY_MS, IST_OFFSET_MS } from "@/core/market/session";
import type { Bar, IndicatorConfig } from "@/core/types";
import { computeSmc, type Annotations, type SmcParams } from "@/core/indicators/smc";
import { patternAnnotations } from "@/core/indicators/patterns";

// Technical indicators: pure functions over bar arrays. Every output is a
// Float64Array aligned 1:1 with the bars, NaN where the value is undefined
// (warm-up period, gaps). The engine draws NaN as a break in the line.
//
// Numerics follow TradingView's built-ins (Pine `ta.*`) wherever there is a
// difference between platforms — e.g. RSI/ATR/ADX use Wilder's RMA seeded with
// an SMA, Supertrend/PSAR replicate `ta.supertrend`/`ta.sar` step for step.
// Full research notes and sources: see the comments above each calc.

export type Series = Float64Array;

export interface ParamDef {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step?: number;
  /** On/off switch stored as 1/0 (rendered as a checkbox, left out of legend titles). */
  toggle?: boolean;
}

/**
 * How an output is drawn:
 * - line: polyline, NaN breaks it
 * - histogram: bars from zero (negColor below zero)
 * - dots: one dot per bar (Parabolic SAR)
 * - levels: flat horizontal segment per run of equal values; a new value starts
 *   a new segment with no connecting line (daily pivots, CPR, ORB)
 */
export type OutputStyle = "line" | "histogram" | "dots" | "levels";

export interface OutputDef {
  key: string;
  label: string;
  color: string;
  style: OutputStyle;
  /** Histogram only: color used for negative values. */
  negColor?: string;
  width?: number;
  /** Canvas line-dash pattern, e.g. [4, 4]. */
  dash?: number[];
  /**
   * Horizontal shift in bars: series value i is plotted at bar i + offset.
   * Positive offsets draw into the empty area right of the last bar (Ichimoku spans).
   */
  offset?: (params: Record<string, number>) => number;
  /** Leave this output out of the price-pane autoscale (far-away levels). */
  noAutoscale?: boolean;
}

export interface FillDef {
  from: string;
  to: string;
  /** Two-tone fill: upColor where from >= to, downColor where from < to (Ichimoku cloud). */
  upColor?: string;
  downColor?: string;
}

export type IndicatorCategory = "trend" | "momentum" | "volatility" | "volume" | "levels";

export const INDICATOR_CATEGORIES: Array<{ key: IndicatorCategory; title: string }> = [
  { key: "trend", title: "Trend" },
  { key: "momentum", title: "Momentum" },
  { key: "volatility", title: "Volatility" },
  { key: "volume", title: "Volume" },
  { key: "levels", title: "Levels & sessions" },
];

export interface IndicatorDef {
  type: string;
  name: string;
  description: string;
  category: IndicatorCategory;
  /** Widely used by Indian retail/intraday traders (Zerodha Varsity, Kite defaults). */
  popularInIndia?: boolean;
  pane: "overlay" | "separate";
  params: ParamDef[];
  outputs: OutputDef[];
  /** Horizontal guide levels drawn in the indicator pane (e.g. RSI 30/70). */
  levels?: number[];
  /** Shade the area between two outputs (e.g. Bollinger upper/lower). */
  fill?: FillDef;
  /** Fixed value range for the pane instead of autoscaling. */
  bounds?: [number, number];
  compact?: boolean;
  calc(bars: Bar[], params: Record<string, number>): Record<string, Series>;
  /** Structure-style indicators (SMC) draw boxes/lines/labels instead of series. */
  annotate?(bars: Bar[], params: Record<string, number>): Annotations;
  /** In-app lesson for this indicator (opens from the legend). */
  guide?: "smc";
}

// ---------------------------------------------------------------- primitives

function empty(length: number): Series {
  return new Float64Array(length).fill(NaN);
}

function closes(bars: Bar[]): Series {
  const out = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i += 1) out[i] = bars[i].close;
  return out;
}

function field(bars: Bar[], pick: (bar: Bar) => number): Series {
  const out = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i += 1) out[i] = pick(bars[i]);
  return out;
}

const hlc3 = (bar: Bar) => (bar.high + bar.low + bar.close) / 3;

export function sma(src: Series, length: number): Series {
  const out = empty(src.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < src.length; i += 1) {
    const value = src[i];
    if (Number.isNaN(value)) {
      sum = 0;
      count = 0;
      continue;
    }
    sum += value;
    count += 1;
    if (count > length) {
      sum -= src[i - length];
      count = length;
    }
    if (count === length) out[i] = sum / length;
  }
  return out;
}

export function ema(src: Series, length: number): Series {
  const out = empty(src.length);
  const alpha = 2 / (length + 1);
  let prev = NaN;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < src.length; i += 1) {
    const value = src[i];
    if (Number.isNaN(value)) continue;
    if (Number.isNaN(prev)) {
      // Seed with the SMA of the first `length` values, like most charting platforms.
      seedSum += value;
      seedCount += 1;
      if (seedCount === length) {
        prev = seedSum / length;
        out[i] = prev;
      }
      continue;
    }
    prev = alpha * value + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (RMA), used by RSI, ATR and ADX. */
export function rma(src: Series, length: number): Series {
  const out = empty(src.length);
  let prev = NaN;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < src.length; i += 1) {
    const value = src[i];
    if (Number.isNaN(value)) continue;
    if (Number.isNaN(prev)) {
      seedSum += value;
      seedCount += 1;
      if (seedCount === length) {
        prev = seedSum / length;
        out[i] = prev;
      }
      continue;
    }
    prev = (prev * (length - 1) + value) / length;
    out[i] = prev;
  }
  return out;
}

export function wma(src: Series, length: number): Series {
  const out = empty(src.length);
  const denominator = (length * (length + 1)) / 2;
  for (let i = length - 1; i < src.length; i += 1) {
    let sum = 0;
    let valid = true;
    for (let k = 0; k < length; k += 1) {
      const value = src[i - k];
      if (Number.isNaN(value)) {
        valid = false;
        break;
      }
      sum += value * (length - k);
    }
    if (valid) out[i] = sum / denominator;
  }
  return out;
}

/** Population standard deviation over `length` around a given mean (TradingView ta.stdev). */
function stdev(src: Series, mean: Series, length: number): Series {
  const out = empty(src.length);
  for (let i = length - 1; i < src.length; i += 1) {
    if (Number.isNaN(mean[i])) continue;
    let sum = 0;
    for (let k = 0; k < length; k += 1) {
      const diff = src[i - k] - mean[i];
      sum += diff * diff;
    }
    out[i] = Math.sqrt(sum / length);
  }
  return out;
}

/** Rolling sum over `length`; NaN until a full window of valid values. */
function rollingSum(src: Series, length: number): Series {
  const out = sma(src, length);
  for (let i = 0; i < out.length; i += 1) out[i] *= length;
  return out;
}

/** Highest value of `src` over the last `length` bars (including the current one). */
function highest(src: Series, length: number): Series {
  const out = empty(src.length);
  for (let i = length - 1; i < src.length; i += 1) {
    let best = -Infinity;
    for (let k = 0; k < length; k += 1) {
      const value = src[i - k];
      if (Number.isNaN(value)) {
        best = NaN;
        break;
      }
      if (value > best) best = value;
    }
    out[i] = best;
  }
  return out;
}

function lowest(src: Series, length: number): Series {
  const out = empty(src.length);
  for (let i = length - 1; i < src.length; i += 1) {
    let best = Infinity;
    for (let k = 0; k < length; k += 1) {
      const value = src[i - k];
      if (Number.isNaN(value)) {
        best = NaN;
        break;
      }
      if (value < best) best = value;
    }
    out[i] = best;
  }
  return out;
}

/** Midpoint of the highest high and lowest low (Ichimoku lines, Donchian basis). */
function donchianMid(highs: Series, lows: Series, length: number): Series {
  const hi = highest(highs, length);
  const lo = lowest(lows, length);
  const out = empty(highs.length);
  for (let i = 0; i < out.length; i += 1) out[i] = (hi[i] + lo[i]) / 2;
  return out;
}

/**
 * True range. With `firstBarRange` the first bar uses high − low (TradingView
 * `ta.tr(true)`, used by `ta.atr`); without it the first bar is NaN (`ta.tr`,
 * used by `ta.dmi`).
 */
function trueRange(bars: Bar[], firstBarRange = true): Series {
  const out = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (i === 0) {
      out[i] = firstBarRange ? bar.high - bar.low : NaN;
      continue;
    }
    const prevClose = bars[i - 1].close;
    out[i] = Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
  }
  return out;
}

function rsiOf(src: Series, length: number): Series {
  const gains = empty(src.length);
  const losses = empty(src.length);
  for (let i = 1; i < src.length; i += 1) {
    const change = src[i] - src[i - 1];
    if (Number.isNaN(change)) continue;
    gains[i] = Math.max(change, 0);
    losses[i] = Math.max(-change, 0);
  }
  const avgGain = rma(gains, length);
  const avgLoss = rma(losses, length);
  const out = empty(src.length);
  for (let i = 0; i < src.length; i += 1) {
    if (Number.isNaN(avgGain[i]) || Number.isNaN(avgLoss[i])) continue;
    out[i] = avgLoss[i] === 0 ? 100 : 100 - 100 / (1 + avgGain[i] / avgLoss[i]);
  }
  return out;
}

// ---------------------------------------------------------------- IST sessions


/** IST calendar-day number of an epoch-ms instant (IST has no DST, so a fixed offset is exact). */
export function istDayNumber(time: number) {
  return Math.floor((time + IST_OFFSET_MS) / DAY_MS);
}

interface Session {
  start: number; // first bar index
  end: number; // last bar index (inclusive)
  high: number;
  low: number;
  close: number;
}

/** Group bars into IST trading days (consecutive runs of the same calendar day). */
function sessionsOf(bars: Bar[]): Session[] {
  const sessions: Session[] = [];
  let day = NaN;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const key = istDayNumber(bar.time);
    const current = sessions[sessions.length - 1];
    if (key !== day || !current) {
      day = key;
      sessions.push({ start: i, end: i, high: bar.high, low: bar.low, close: bar.close });
      continue;
    }
    current.end = i;
    current.high = Math.max(current.high, bar.high);
    current.low = Math.min(current.low, bar.low);
    current.close = bar.close;
  }
  return sessions;
}

/** Intraday data has at least two bars on the same IST day (daily bars are one per day). */
function isIntradayData(bars: Bar[]) {
  for (let i = 1; i < bars.length; i += 1) {
    if (istDayNumber(bars[i].time) === istDayNumber(bars[i - 1].time)) return true;
  }
  return false;
}

type HLC = { high: number; low: number; close: number };

/**
 * Levels derived from the PREVIOUS period's high/low/close and held flat for the
 * whole current period. Intraday: previous IST trading session (the previous day
 * present in the data, so weekends/holidays are skipped). Daily and above: the
 * previous bar. The first period in the data has no predecessor → NaN.
 */
function previousPeriodLevels(bars: Bar[], keys: string[], compute: (prev: HLC) => Record<string, number>) {
  const out: Record<string, Series> = Object.fromEntries(keys.map((key) => [key, empty(bars.length)]));
  const assign = (values: Record<string, number>, from: number, to: number) => {
    for (const key of keys) out[key].fill(values[key], from, to + 1);
  };
  if (isIntradayData(bars)) {
    const sessions = sessionsOf(bars);
    for (let s = 1; s < sessions.length; s += 1) assign(compute(sessions[s - 1]), sessions[s].start, sessions[s].end);
  } else {
    for (let i = 1; i < bars.length; i += 1) assign(compute(bars[i - 1]), i, i);
  }
  return out;
}

// ---------------------------------------------------------------- calculations

/**
 * Supertrend — replicates TradingView `ta.supertrend(factor, atrPeriod)`:
 * hl2 ± factor·ATR (RMA), final bands ratchet unless the previous close crossed
 * them, direction flips on a close through the active band, first bar = down.
 * Sources: tradingview.com/support/solutions/43000634738-supertrend/,
 * zerodha.com/varsity/chapter/supplementary-notes-1/ (Kite default 7,3).
 */
function supertrend(bars: Bar[], period: number, factor: number) {
  const atr = rma(trueRange(bars), period);
  const up = empty(bars.length);
  const down = empty(bars.length);
  let finalUpper = NaN;
  let finalLower = NaN;
  let uptrend = false;
  for (let i = 0; i < bars.length; i += 1) {
    if (Number.isNaN(atr[i])) continue;
    const bar = bars[i];
    const mid = (bar.high + bar.low) / 2;
    const basicUpper = mid + factor * atr[i];
    const basicLower = mid - factor * atr[i];
    const prevClose = i > 0 ? bars[i - 1].close : bar.close;
    const first = Number.isNaN(finalUpper);
    finalUpper = first || basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
    finalLower = first || basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;
    if (first) uptrend = false;
    else if (!uptrend && bar.close > finalUpper) uptrend = true;
    else if (uptrend && bar.close < finalLower) uptrend = false;
    if (uptrend) up[i] = finalLower;
    else down[i] = finalUpper;
  }
  return { up, down };
}

/**
 * Parabolic SAR (Wilder 1978) — replicates TradingView `ta.sar(start, inc, max)`:
 * SAR += AF·(EP − SAR); AF starts at `start`, +`inc` on each new extreme, capped
 * at `max`; on penetration the SAR flips to the prior EP; a rising SAR may not
 * exceed the prior two lows (falling: prior two highs).
 * Source: chartschool.stockcharts.com …/technical-overlays/parabolic-sar.
 */
function parabolicSar(bars: Bar[], start: number, increment: number, maximum: number): Series {
  const out = empty(bars.length);
  if (bars.length < 2) return out;
  let result = NaN;
  let extreme = NaN;
  let accel = start;
  let rising = false;
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i];
    let firstTrendBar = false;
    if (i === 1) {
      rising = bar.close > bars[0].close;
      extreme = rising ? bar.high : bar.low;
      result = rising ? bars[0].low : bars[0].high;
      firstTrendBar = true;
      accel = start;
    }
    result += accel * (extreme - result);
    if (rising) {
      if (result > bar.low) {
        firstTrendBar = true;
        rising = false;
        result = Math.max(bar.high, extreme);
        extreme = bar.low;
        accel = start;
      }
    } else if (result < bar.high) {
      firstTrendBar = true;
      rising = true;
      result = Math.min(bar.low, extreme);
      extreme = bar.high;
      accel = start;
    }
    if (!firstTrendBar) {
      if (rising && bar.high > extreme) {
        extreme = bar.high;
        accel = Math.min(accel + increment, maximum);
      } else if (!rising && bar.low < extreme) {
        extreme = bar.low;
        accel = Math.min(accel + increment, maximum);
      }
    }
    if (rising) {
      result = Math.min(result, bars[i - 1].low);
      if (i > 1) result = Math.min(result, bars[i - 2].low);
    } else {
      result = Math.max(result, bars[i - 1].high);
      if (i > 1) result = Math.max(result, bars[i - 2].high);
    }
    out[i] = result;
  }
  return out;
}

/**
 * ADX / DMI (Wilder 1978) — TradingView `ta.dmi(len, len)`:
 * +DM/−DM from high/low changes, RMA-smoothed with TR, DI = 100·DM/TR,
 * DX = 100·|+DI − −DI|/(+DI + −DI), ADX = RMA(DX). Wilder's running-sum
 * smoothing (StockCharts) gives identical DI ratios.
 * Source: chartschool.stockcharts.com …/technical-indicators/average-directional-index-adx.
 */
function dmi(bars: Bar[], length: number) {
  const n = bars.length;
  const plusDM = empty(n);
  const minusDM = empty(n);
  for (let i = 1; i < n; i += 1) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }
  const tr = rma(trueRange(bars, false), length);
  const plusSmoothed = rma(plusDM, length);
  const minusSmoothed = rma(minusDM, length);
  const plusDI = empty(n);
  const minusDI = empty(n);
  const dx = empty(n);
  for (let i = 0; i < n; i += 1) {
    if (Number.isNaN(tr[i])) continue;
    plusDI[i] = tr[i] === 0 ? 0 : (100 * plusSmoothed[i]) / tr[i];
    minusDI[i] = tr[i] === 0 ? 0 : (100 * minusSmoothed[i]) / tr[i];
    const sum = plusDI[i] + minusDI[i];
    dx[i] = (100 * Math.abs(plusDI[i] - minusDI[i])) / (sum === 0 ? 1 : sum);
  }
  return { adx: rma(dx, length), plusDI, minusDI };
}

// ---------------------------------------------------------------- registry

const lengthParam = (fallback: number): ParamDef => ({ key: "length", label: "Length", default: fallback, min: 1, max: 500 });

const UP = "#089981";
const DOWN = "#f23645";

const DEFS: IndicatorDef[] = [
  // ------------------------------------------------------------ trend
  {
    // SMA: arithmetic mean of the last n closes. TradingView ta.sma.
    type: "sma",
    name: "Moving Average",
    description: "Simple moving average of the close",
    category: "trend",
    pane: "overlay",
    params: [lengthParam(20)],
    outputs: [{ key: "ma", label: "MA", color: "#f5b544", style: "line" }],
    calc: (bars, p) => ({ ma: sma(closes(bars), p.length) }),
  },
  {
    // EMA: α = 2/(n+1), seeded with the SMA of the first n values (TradingView ta.ema).
    type: "ema",
    name: "Moving Average Exponential",
    description: "Exponential moving average of the close",
    category: "trend",
    popularInIndia: true,
    pane: "overlay",
    params: [lengthParam(20)],
    outputs: [{ key: "ma", label: "EMA", color: "#2962ff", style: "line" }],
    calc: (bars, p) => ({ ma: ema(closes(bars), p.length) }),
  },
  {
    type: "wma",
    name: "Moving Average Weighted",
    description: "Linearly weighted moving average of the close",
    category: "trend",
    pane: "overlay",
    params: [lengthParam(20)],
    outputs: [{ key: "ma", label: "WMA", color: "#c77dff", style: "line" }],
    calc: (bars, p) => ({ ma: wma(closes(bars), p.length) }),
  },
  {
    // Hull MA (Alan Hull, 2005): WMA(2·WMA(n/2) − WMA(n), √n) with integer
    // lengths (Hull's "Integer(...)"; TradingView ta.hma, default 9).
    // Sources: alanhull.com/hull-moving-average, tradingview.com/support/solutions/43000589149.
    type: "hma",
    name: "Hull Moving Average",
    description: "Fast, low-lag weighted average (Alan Hull)",
    category: "trend",
    pane: "overlay",
    params: [{ key: "length", label: "Length", default: 9, min: 2, max: 500 }],
    outputs: [{ key: "ma", label: "HMA", color: "#ffd166", style: "line", width: 2 }],
    calc: (bars, p) => {
      const src = closes(bars);
      const half = wma(src, Math.max(1, Math.floor(p.length / 2)));
      const full = wma(src, p.length);
      const diff = empty(bars.length);
      for (let i = 0; i < bars.length; i += 1) diff[i] = 2 * half[i] - full[i];
      return { ma: wma(diff, Math.max(1, Math.floor(Math.sqrt(p.length)))) };
    },
  },
  {
    // VWMA = Σ(close·volume)/Σ(volume) over n (TradingView ta.vwma). Falls back
    // to the SMA when the window has no volume (NSE indices report 0 volume).
    type: "vwma",
    name: "Volume Weighted Moving Average",
    description: "Moving average of the close weighted by volume",
    category: "trend",
    pane: "overlay",
    params: [lengthParam(20)],
    outputs: [{ key: "ma", label: "VWMA", color: "#2dd4bf", style: "line" }],
    calc: (bars, p) => {
      const src = closes(bars);
      const pv = rollingSum(field(bars, (bar) => bar.close * bar.volume), p.length);
      const volume = rollingSum(field(bars, (bar) => bar.volume), p.length);
      const plain = sma(src, p.length);
      const ma = empty(bars.length);
      for (let i = 0; i < bars.length; i += 1) ma[i] = volume[i] > 0 ? pv[i] / volume[i] : plain[i];
      return { ma };
    },
  },
  {
    type: "supertrend",
    name: "Supertrend",
    description: "ATR-based trailing trend line",
    category: "trend",
    popularInIndia: true,
    pane: "overlay",
    params: [
      { key: "period", label: "ATR length", default: 10, min: 1, max: 200 },
      { key: "factor", label: "Factor", default: 3, min: 0.1, max: 20, step: 0.1 },
    ],
    outputs: [
      { key: "up", label: "Up trend", color: UP, style: "line", width: 2 },
      { key: "down", label: "Down trend", color: DOWN, style: "line", width: 2 },
    ],
    calc: (bars, p) => supertrend(bars, p.period, p.factor),
  },
  {
    type: "psar",
    name: "Parabolic SAR",
    description: "Wilder's stop-and-reverse trailing dots",
    category: "trend",
    pane: "overlay",
    params: [
      { key: "start", label: "Start", default: 0.02, min: 0.001, max: 1, step: 0.001 },
      { key: "increment", label: "Increment", default: 0.02, min: 0.001, max: 1, step: 0.001 },
      { key: "max", label: "Maximum", default: 0.2, min: 0.01, max: 1, step: 0.01 },
    ],
    outputs: [{ key: "sar", label: "SAR", color: "#2962ff", style: "dots" }],
    calc: (bars, p) => ({ sar: parabolicSar(bars, p.start, p.increment, p.max) }),
  },
  {
    // Ichimoku Kinko Hyo (Goichi Hosoda, 1969). Tenkan = mid(9), Kijun = mid(26),
    // Senkou A = (Tenkan+Kijun)/2, Senkou B = mid(52), both plotted ahead;
    // Chikou = close plotted behind. Like TradingView's built-in, the shift is
    // displacement − 1 bars (the current bar counts as the 1st of 26).
    // Sources: chartschool.stockcharts.com …/technical-overlays/ichimoku-cloud,
    // tradingview.com/support/solutions/43000589152-ichimoku-cloud/.
    type: "ichimoku",
    name: "Ichimoku Cloud",
    description: "Hosoda's cloud: conversion, base, leading spans, lagging span",
    category: "trend",
    pane: "overlay",
    params: [
      { key: "conversion", label: "Conversion line", default: 9, min: 1, max: 200 },
      { key: "base", label: "Base line", default: 26, min: 1, max: 300 },
      { key: "spanB", label: "Leading span B", default: 52, min: 1, max: 500 },
      { key: "displacement", label: "Displacement", default: 26, min: 1, max: 300 },
    ],
    outputs: [
      { key: "conversion", label: "Conversion", color: "#2962ff", style: "line" },
      { key: "base", label: "Base", color: "#e0533f", style: "line" },
      { key: "lagging", label: "Lagging", color: "#43a047", style: "line", offset: (p) => -(p.displacement - 1) },
      { key: "spanA", label: "Span A", color: "#5fc98a", style: "line", width: 1, offset: (p) => p.displacement - 1 },
      { key: "spanB", label: "Span B", color: "#ef7a7a", style: "line", width: 1, offset: (p) => p.displacement - 1 },
    ],
    fill: { from: "spanA", to: "spanB", upColor: UP, downColor: DOWN },
    calc: (bars, p) => {
      const highs = field(bars, (bar) => bar.high);
      const lows = field(bars, (bar) => bar.low);
      const conversion = donchianMid(highs, lows, p.conversion);
      const base = donchianMid(highs, lows, p.base);
      const spanA = empty(bars.length);
      for (let i = 0; i < bars.length; i += 1) spanA[i] = (conversion[i] + base[i]) / 2;
      return { conversion, base, lagging: closes(bars), spanA, spanB: donchianMid(highs, lows, p.spanB) };
    },
  },
  {
    type: "adx",
    name: "ADX / DMI",
    description: "Wilder's trend strength (ADX) with +DI / −DI",
    category: "trend",
    popularInIndia: true,
    pane: "separate",
    params: [lengthParam(14)],
    outputs: [
      { key: "adx", label: "ADX", color: "#f5b544", style: "line", width: 2 },
      { key: "plusDI", label: "+DI", color: UP, style: "line" },
      { key: "minusDI", label: "−DI", color: DOWN, style: "line" },
    ],
    levels: [20, 25],
    calc: (bars, p) => dmi(bars, p.length),
  },
  {
    // Aroon (Tushar Chande, 1995): 100·(n − bars since n-period high/low)/n over
    // the last n+1 bars (TradingView window; Kite default 14, StockCharts 25).
    // Sources: chartschool.stockcharts.com …/technical-indicators/aroon,
    // zerodha.com/varsity/chapter/supplementary-notes-1/.
    type: "aroon",
    name: "Aroon",
    description: "Bars since the recent high / low, 0–100",
    category: "trend",
    pane: "separate",
    params: [lengthParam(14)],
    outputs: [
      { key: "up", label: "Up", color: UP, style: "line" },
      { key: "down", label: "Down", color: DOWN, style: "line" },
    ],
    levels: [30, 70],
    bounds: [0, 100],
    calc: (bars, p) => {
      const up = empty(bars.length);
      const down = empty(bars.length);
      for (let i = p.length; i < bars.length; i += 1) {
        let hiAgo = 0;
        let loAgo = 0;
        for (let k = 0; k <= p.length; k += 1) {
          // Most recent extreme wins ties (strict comparison while walking back).
          if (bars[i - k].high > bars[i - hiAgo].high) hiAgo = k;
          if (bars[i - k].low < bars[i - loAgo].low) loAgo = k;
        }
        up[i] = (100 * (p.length - hiAgo)) / p.length;
        down[i] = (100 * (p.length - loAgo)) / p.length;
      }
      return { up, down };
    },
  },

  // ------------------------------------------------------------ momentum
  {
    // RSI (Wilder 1978): 100 − 100/(1 + RMA(gain)/RMA(loss)), default 14, 70/30.
    // Source: chartschool.stockcharts.com …/technical-indicators/relative-strength-index-rsi.
    type: "rsi",
    name: "Relative Strength Index",
    description: "Momentum oscillator between 0 and 100",
    category: "momentum",
    popularInIndia: true,
    pane: "separate",
    params: [lengthParam(14)],
    outputs: [{ key: "rsi", label: "RSI", color: "#a77bff", style: "line" }],
    levels: [30, 50, 70],
    bounds: [0, 100],
    calc: (bars, p) => ({ rsi: rsiOf(closes(bars), p.length) }),
  },
  {
    // MACD (Gerald Appel, late 1970s): EMA12 − EMA26, signal EMA9, histogram = MACD − signal.
    // Source: chartschool.stockcharts.com …/macd-moving-average-convergence-divergence-oscillator.
    type: "macd",
    name: "MACD",
    description: "Moving average convergence/divergence",
    category: "momentum",
    popularInIndia: true,
    pane: "separate",
    params: [
      { key: "fast", label: "Fast length", default: 12, min: 1, max: 200 },
      { key: "slow", label: "Slow length", default: 26, min: 1, max: 300 },
      { key: "signal", label: "Signal length", default: 9, min: 1, max: 100 },
    ],
    outputs: [
      { key: "hist", label: "Histogram", color: UP, negColor: DOWN, style: "histogram" },
      { key: "macd", label: "MACD", color: "#2962ff", style: "line" },
      { key: "signal", label: "Signal", color: "#f59e42", style: "line" },
    ],
    levels: [0],
    calc: (bars, p) => {
      const src = closes(bars);
      const fast = ema(src, p.fast);
      const slow = ema(src, p.slow);
      const macd = empty(bars.length);
      for (let i = 0; i < bars.length; i += 1) macd[i] = fast[i] - slow[i];
      const signal = ema(macd, p.signal);
      const hist = empty(bars.length);
      for (let i = 0; i < bars.length; i += 1) hist[i] = macd[i] - signal[i];
      return { hist, macd, signal };
    },
  },
  {
    // Full stochastic (George Lane, 1950s): %K = SMA(100·(C − LL)/(HH − LL), smooth), %D = SMA(%K).
    // Source: chartschool.stockcharts.com …/stochastic-oscillator-fast-slow-and-full.
    type: "stoch",
    name: "Stochastic",
    description: "%K/%D oscillator of close within the recent range",
    category: "momentum",
    pane: "separate",
    params: [
      { key: "k", label: "%K length", default: 14, min: 1, max: 200 },
      { key: "smooth", label: "%K smoothing", default: 3, min: 1, max: 50 },
      { key: "d", label: "%D smoothing", default: 3, min: 1, max: 50 },
    ],
    outputs: [
      { key: "k", label: "%K", color: "#2962ff", style: "line" },
      { key: "d", label: "%D", color: "#f59e42", style: "line" },
    ],
    levels: [20, 80],
    bounds: [0, 100],
    calc: (bars, p) => {
      const raw = empty(bars.length);
      for (let i = p.k - 1; i < bars.length; i += 1) {
        let highestHigh = -Infinity;
        let lowestLow = Infinity;
        for (let k = 0; k < p.k; k += 1) {
          highestHigh = Math.max(highestHigh, bars[i - k].high);
          lowestLow = Math.min(lowestLow, bars[i - k].low);
        }
        raw[i] = highestHigh === lowestLow ? 50 : ((bars[i].close - lowestLow) / (highestHigh - lowestLow)) * 100;
      }
      const k = sma(raw, p.smooth);
      return { k, d: sma(k, p.d) };
    },
  },
  {
    // Stochastic RSI (Chande & Kroll, "The New Technical Trader", 1994): stochastic
    // of RSI values, scaled 0–100 and smoothed into %K/%D like TradingView's
    // built-in (RSI 14, stoch 14, K 3, D 3).
    // Sources: chartschool.stockcharts.com …/technical-indicators/stochrsi,
    // tradingview.com/support/solutions/43000502333-stochastic-rsi-stoch-rsi/.
    type: "stochrsi",
    name: "Stochastic RSI",
    description: "Stochastic of RSI (%K/%D), 0–100",
    category: "momentum",
    pane: "separate",
    params: [
      { key: "rsiLength", label: "RSI length", default: 14, min: 1, max: 200 },
      { key: "stochLength", label: "Stochastic length", default: 14, min: 1, max: 200 },
      { key: "k", label: "%K smoothing", default: 3, min: 1, max: 50 },
      { key: "d", label: "%D smoothing", default: 3, min: 1, max: 50 },
    ],
    outputs: [
      { key: "k", label: "%K", color: "#2962ff", style: "line" },
      { key: "d", label: "%D", color: "#f59e42", style: "line" },
    ],
    levels: [20, 80],
    bounds: [0, 100],
    calc: (bars, p) => {
      const rsi = rsiOf(closes(bars), p.rsiLength);
      const hi = highest(rsi, p.stochLength);
      const lo = lowest(rsi, p.stochLength);
      const raw = empty(bars.length);
      for (let i = 0; i < bars.length; i += 1) {
        if (Number.isNaN(hi[i])) continue;
        raw[i] = hi[i] === lo[i] ? 50 : (100 * (rsi[i] - lo[i])) / (hi[i] - lo[i]);
      }
      const k = sma(raw, p.k);
      return { k, d: sma(k, p.d) };
    },
  },
  {
    // CCI (Donald Lambert, 1980): (TP − SMA(TP)) / (0.015 · mean deviation), TP = hlc3, default 20.
    // Source: chartschool.stockcharts.com …/technical-indicators/commodity-channel-index-cci.
    type: "cci",
    name: "Commodity Channel Index",
    description: "Typical price vs its average, in mean deviations",
    category: "momentum",
    pane: "separate",
    params: [lengthParam(20)],
    outputs: [{ key: "cci", label: "CCI", color: "#22d3ee", style: "line" }],
    levels: [-100, 0, 100],
    calc: (bars, p) => {
      const tp = field(bars, hlc3);
      const mean = sma(tp, p.length);
      const out = empty(bars.length);
      for (let i = p.length - 1; i < bars.length; i += 1) {
        if (Number.isNaN(mean[i])) continue;
        let deviation = 0;
        for (let k = 0; k < p.length; k += 1) deviation += Math.abs(tp[i - k] - mean[i]);
        deviation /= p.length;
        out[i] = deviation === 0 ? 0 : (tp[i] - mean[i]) / (0.015 * deviation);
      }
      return { cci: out };
    },
  },
  {
    // Williams %R (Larry Williams): −100·(HH − C)/(HH − LL), default 14, −20/−80.
    // Source: chartschool.stockcharts.com …/technical-indicators/williams-r.
    type: "willr",
    name: "Williams %R",
    description: "Close within the recent range, −100 to 0",
    category: "momentum",
    pane: "separate",
    params: [lengthParam(14)],
    outputs: [{ key: "r", label: "%R", color: "#c77dff", style: "line" }],
    levels: [-80, -50, -20],
    bounds: [-100, 0],
    calc: (bars, p) => {
      const hi = highest(field(bars, (bar) => bar.high), p.length);
      const lo = lowest(field(bars, (bar) => bar.low), p.length);
      const r = empty(bars.length);
      for (let i = 0; i < bars.length; i += 1) {
        if (Number.isNaN(hi[i])) continue;
        // Written as (C − HH) so a close at the high gives 0, not −0 ("-0.00" in the legend).
        r[i] = hi[i] === lo[i] ? -50 : (100 * (bars[i].close - hi[i])) / (hi[i] - lo[i]);
      }
      return { r };
    },
  },
  {
    // Rate of change: 100·(C − C[n])/C[n]. StockCharts default 12.
    // Source: chartschool.stockcharts.com …/rate-of-change-roc-and-momentum.
    type: "roc",
    name: "Rate of Change",
    description: "Percent change over n bars",
    category: "momentum",
    pane: "separate",
    params: [lengthParam(12)],
    outputs: [{ key: "roc", label: "ROC", color: "#2962ff", style: "line" }],
    levels: [0],
    calc: (bars, p) => {
      const roc = empty(bars.length);
      for (let i = p.length; i < bars.length; i += 1) {
        const base = bars[i - p.length].close;
        if (base !== 0) roc[i] = (100 * (bars[i].close - base)) / base;
      }
      return { roc };
    },
  },

  // ------------------------------------------------------------ volatility
  {
    // Bollinger Bands (John Bollinger): SMA20 ± 2 population σ (TradingView ta.stdev).
    // Source: chartschool.stockcharts.com …/technical-overlays/bollinger-bands.
    type: "bb",
    name: "Bollinger Bands",
    description: "SMA basis with standard-deviation envelopes",
    category: "volatility",
    popularInIndia: true,
    pane: "overlay",
    params: [lengthParam(20), { key: "mult", label: "StdDev", default: 2, min: 0.1, max: 10, step: 0.1 }],
    outputs: [
      { key: "upper", label: "Upper", color: "#2962ff", style: "line" },
      { key: "basis", label: "Basis", color: "#f5b544", style: "line" },
      { key: "lower", label: "Lower", color: "#2962ff", style: "line" },
    ],
    fill: { from: "upper", to: "lower" },
    calc: (bars, p) => {
      const src = closes(bars);
      const basis = sma(src, p.length);
      const dev = stdev(src, basis, p.length);
      const upper = empty(bars.length);
      const lower = empty(bars.length);
      for (let i = 0; i < bars.length; i += 1) {
        upper[i] = basis[i] + p.mult * dev[i];
        lower[i] = basis[i] - p.mult * dev[i];
      }
      return { upper, basis, lower };
    },
  },
  {
    // Keltner Channels, modern (Linda Raschke) version: EMA(20) ± 2·ATR(10).
    // Chester Keltner's 1960 original used a 10-day SMA of typical price.
    // Source: chartschool.stockcharts.com …/technical-overlays/keltner-channels.
    type: "keltner",
    name: "Keltner Channels",
    description: "EMA basis with ATR envelopes",
    category: "volatility",
    pane: "overlay",
    params: [
      lengthParam(20),
      { key: "mult", label: "Multiplier", default: 2, min: 0.1, max: 10, step: 0.1 },
      { key: "atrLength", label: "ATR length", default: 10, min: 1, max: 200 },
    ],
    outputs: [
      { key: "upper", label: "Upper", color: "#2dd4bf", style: "line" },
      { key: "basis", label: "Basis", color: "#f5b544", style: "line" },
      { key: "lower", label: "Lower", color: "#2dd4bf", style: "line" },
    ],
    fill: { from: "upper", to: "lower" },
    calc: (bars, p) => {
      const basis = ema(closes(bars), p.length);
      const atr = rma(trueRange(bars), p.atrLength);
      const upper = empty(bars.length);
      const lower = empty(bars.length);
      for (let i = 0; i < bars.length; i += 1) {
        upper[i] = basis[i] + p.mult * atr[i];
        lower[i] = basis[i] - p.mult * atr[i];
      }
      return { upper, basis, lower };
    },
  },
  {
    // Donchian Channels (Richard Donchian): highest high / lowest low of n bars, midpoint basis.
    // Source: tradingview.com/support/solutions/43000502253-donchian-channels-dc/.
    type: "donchian",
    name: "Donchian Channels",
    description: "Highest high / lowest low of the last n bars",
    category: "volatility",
    pane: "overlay",
    params: [lengthParam(20)],
    outputs: [
      { key: "upper", label: "Upper", color: "#2962ff", style: "line" },
      { key: "basis", label: "Basis", color: "#f59e42", style: "line" },
      { key: "lower", label: "Lower", color: "#2962ff", style: "line" },
    ],
    fill: { from: "upper", to: "lower" },
    calc: (bars, p) => {
      const upper = highest(field(bars, (bar) => bar.high), p.length);
      const lower = lowest(field(bars, (bar) => bar.low), p.length);
      const basis = empty(bars.length);
      for (let i = 0; i < bars.length; i += 1) basis[i] = (upper[i] + lower[i]) / 2;
      return { upper, basis, lower };
    },
  },
  {
    // ATR (Wilder 1978): RMA of true range, default 14.
    // Source: chartschool.stockcharts.com …/technical-indicators/average-true-range-atr.
    type: "atr",
    name: "Average True Range",
    description: "Wilder-smoothed true range (volatility)",
    category: "volatility",
    pane: "separate",
    params: [lengthParam(14)],
    outputs: [{ key: "atr", label: "ATR", color: DOWN, style: "line" }],
    calc: (bars, p) => ({ atr: rma(trueRange(bars), p.length) }),
  },

  // ------------------------------------------------------------ volume
  {
    // Session VWAP: Σ(hlc3·volume)/Σ(volume), reset every IST trading day.
    // Sources: zerodha.com/varsity/chapter/supplementary-notes-1/,
    // tradingview.com/support/solutions/43000502018-volume-weighted-average-price-vwap/.
    // NSE indices carry no volume, so there the line falls back to the
    // equal-weighted session average of hlc3 (a TWAP) instead of a jagged hlc3.
    type: "vwap",
    name: "VWAP",
    description: "Volume-weighted average price, anchored to each session",
    category: "volume",
    popularInIndia: true,
    pane: "overlay",
    params: [],
    outputs: [{ key: "vwap", label: "VWAP", color: "#22d3ee", style: "line" }],
    calc: (bars) => {
      const out = empty(bars.length);
      let day = -1;
      let pv = 0;
      let volume = 0;
      let typicalSum = 0;
      let count = 0;
      for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i];
        const key = istDayNumber(bar.time);
        if (key !== day) {
          day = key;
          pv = 0;
          volume = 0;
          typicalSum = 0;
          count = 0;
        }
        const typical = hlc3(bar);
        pv += typical * bar.volume;
        volume += bar.volume;
        typicalSum += typical;
        count += 1;
        out[i] = volume > 0 ? pv / volume : typicalSum / count;
      }
      return { vwap: out };
    },
  },
  {
    // OBV (Joe Granville): running total of volume signed by the close-to-close direction.
    type: "obv",
    name: "On Balance Volume",
    description: "Cumulative volume signed by close direction",
    category: "volume",
    pane: "separate",
    params: [],
    outputs: [{ key: "obv", label: "OBV", color: "#22d3ee", style: "line" }],
    compact: true,
    calc: (bars) => {
      const out = empty(bars.length);
      let total = 0;
      for (let i = 0; i < bars.length; i += 1) {
        if (i > 0) {
          const change = bars[i].close - bars[i - 1].close;
          total += change > 0 ? bars[i].volume : change < 0 ? -bars[i].volume : 0;
        }
        out[i] = total;
      }
      return { obv: out };
    },
  },
  {
    // MFI (Gene Quong & Avrum Soudack): volume-weighted RSI of hlc3. Raw money
    // flow is positive when hlc3 rises, negative when it falls, ignored when
    // unchanged. 100 − 100/(1 + ΣPMF/ΣNMF), default 14, 80/20.
    // Source: chartschool.stockcharts.com …/technical-indicators/money-flow-index-mfi.
    type: "mfi",
    name: "Money Flow Index",
    description: "Volume-weighted RSI of the typical price",
    category: "volume",
    pane: "separate",
    params: [lengthParam(14)],
    outputs: [{ key: "mfi", label: "MFI", color: "#f5b544", style: "line" }],
    levels: [20, 80],
    bounds: [0, 100],
    calc: (bars, p) => {
      const positive = empty(bars.length);
      const negative = empty(bars.length);
      for (let i = 1; i < bars.length; i += 1) {
        const tp = hlc3(bars[i]);
        const prev = hlc3(bars[i - 1]);
        const flow = tp * bars[i].volume;
        positive[i] = tp > prev ? flow : 0;
        negative[i] = tp < prev ? flow : 0;
      }
      const up = rollingSum(positive, p.length);
      const down = rollingSum(negative, p.length);
      const mfi = empty(bars.length);
      for (let i = 0; i < bars.length; i += 1) {
        if (Number.isNaN(up[i]) || up[i] + down[i] === 0) continue; // no volume (indices)
        mfi[i] = down[i] === 0 ? 100 : 100 - 100 / (1 + up[i] / down[i]);
      }
      return { mfi };
    },
  },
  {
    // Chaikin Money Flow (Marc Chaikin): Σ(MF multiplier·volume)/Σ(volume) over 20,
    // multiplier = ((C − L) − (H − C))/(H − L).
    // Source: chartschool.stockcharts.com …/technical-indicators/chaikin-money-flow-cmf.
    type: "cmf",
    name: "Chaikin Money Flow",
    description: "Accumulation/distribution pressure, −1 to 1",
    category: "volume",
    pane: "separate",
    params: [lengthParam(20)],
    outputs: [{ key: "cmf", label: "CMF", color: "#2dd4bf", style: "line" }],
    levels: [0],
    calc: (bars, p) => {
      const flow = field(bars, (bar) =>
        bar.high === bar.low ? 0 : (((bar.close - bar.low) - (bar.high - bar.close)) / (bar.high - bar.low)) * bar.volume,
      );
      const flowSum = rollingSum(flow, p.length);
      const volumeSum = rollingSum(field(bars, (bar) => bar.volume), p.length);
      const cmf = empty(bars.length);
      for (let i = 0; i < bars.length; i += 1) if (volumeSum[i] > 0) cmf[i] = flowSum[i] / volumeSum[i];
      return { cmf };
    },
  },
  {
    // Elder's Force Index ("Trading for a Living"): EMA13 of (C − C[1])·volume.
    // Source: chartschool.stockcharts.com …/technical-indicators/force-index.
    type: "force",
    name: "Elder Force Index",
    description: "Price change × volume, EMA-smoothed",
    category: "volume",
    pane: "separate",
    params: [lengthParam(13)],
    outputs: [{ key: "force", label: "EFI", color: "#f23645", style: "line" }],
    levels: [0],
    compact: true,
    calc: (bars, p) => {
      const raw = empty(bars.length);
      for (let i = 1; i < bars.length; i += 1) raw[i] = (bars[i].close - bars[i - 1].close) * bars[i].volume;
      return { force: ema(raw, p.length) };
    },
  },

  // ------------------------------------------------------------ levels (session based)
  {
    // Central Pivot Range (popularised by Frank Ochoa, "Secrets of a Pivot Boss";
    // taught in Zerodha Varsity): P = (H+L+C)/3, BC = (H+L)/2, TC = 2P − BC from
    // the previous session. TC can come out below BC (close under the midpoint),
    // so the pair is ordered: tc is always the upper edge.
    // Sources: zerodha.com/varsity/chapter/the-central-pivot-range/,
    // support.zerodha.com …/how-are-pivot-points-derived-while-using-the-cpr.
    type: "cpr",
    name: "Central Pivot Range (CPR)",
    description: "Pivot, top & bottom central levels from the previous session",
    category: "levels",
    popularInIndia: true,
    pane: "overlay",
    params: [],
    outputs: [
      { key: "tc", label: "TC", color: "#2962ff", style: "levels" },
      { key: "pivot", label: "P", color: "#c77dff", style: "levels", width: 1.5 },
      { key: "bc", label: "BC", color: "#2962ff", style: "levels" },
    ],
    fill: { from: "tc", to: "bc" },
    calc: (bars) =>
      previousPeriodLevels(bars, ["tc", "pivot", "bc"], ({ high, low, close }) => {
        const pivot = (high + low + close) / 3;
        const bc = (high + low) / 2;
        const tc = 2 * pivot - bc;
        return { tc: Math.max(tc, bc), pivot, bc: Math.min(tc, bc) };
      }),
  },
  {
    // Classic (floor-trader) pivots from the previous session:
    // P = (H+L+C)/3, R1 = 2P − L, S1 = 2P − H, R2 = P + (H − L), S2 = P − (H − L),
    // R3 = 2P + (H − 2L) = H + 2(P − L), S3 = 2P − (2H − L) = L − 2(H − P).
    // Sources: tradingview.com/support/solutions/43000521824-pivot-points-standard/ ("Traditional"),
    // chartschool.stockcharts.com …/technical-overlays/pivot-points.
    type: "pivots",
    name: "Pivot Points (Classic)",
    description: "Floor pivots P, R1–R3, S1–S3 from the previous session",
    category: "levels",
    popularInIndia: true,
    pane: "overlay",
    params: [],
    outputs: [
      { key: "r3", label: "R3", color: DOWN, style: "levels", dash: [4, 3], noAutoscale: true },
      { key: "r2", label: "R2", color: DOWN, style: "levels" },
      { key: "r1", label: "R1", color: DOWN, style: "levels" },
      { key: "p", label: "P", color: "#f5b544", style: "levels", width: 1.5 },
      { key: "s1", label: "S1", color: UP, style: "levels" },
      { key: "s2", label: "S2", color: UP, style: "levels" },
      { key: "s3", label: "S3", color: UP, style: "levels", dash: [4, 3], noAutoscale: true },
    ],
    calc: (bars) =>
      previousPeriodLevels(bars, ["p", "r1", "r2", "r3", "s1", "s2", "s3"], ({ high, low, close }) => {
        const p = (high + low + close) / 3;
        const range = high - low;
        return {
          p,
          r1: 2 * p - low,
          s1: 2 * p - high,
          r2: p + range,
          s2: p - range,
          r3: 2 * p + (high - 2 * low),
          s3: 2 * p - (2 * high - low),
        };
      }),
  },
  {
    // Camarilla pivots (Nick Stott, 1989): C ± 1.1·(H − L)/k with k = 2, 4, 6, 12
    // for levels 4…1, from the previous session. Traditionally named H1–H4 / L1–L4.
    // Source: tradingview.com/support/solutions/43000521824-pivot-points-standard/ ("Camarilla").
    type: "camarilla",
    name: "Camarilla Pivots",
    description: "H3/H4 & L3/L4 reversal / breakout levels from the previous session",
    category: "levels",
    popularInIndia: true,
    pane: "overlay",
    params: [],
    outputs: [
      { key: "r4", label: "H4", color: DOWN, style: "levels", width: 1.5 },
      { key: "r3", label: "H3", color: "#ff9f7a", style: "levels" },
      { key: "s3", label: "L3", color: "#5fd4b4", style: "levels" },
      { key: "s4", label: "L4", color: UP, style: "levels", width: 1.5 },
    ],
    calc: (bars) =>
      previousPeriodLevels(bars, ["r4", "r3", "s3", "s4"], ({ high, low, close }) => {
        const range = 1.1 * (high - low);
        return { r4: close + range / 2, r3: close + range / 4, s3: close - range / 4, s4: close - range / 2 };
      }),
  },
  {
    // Previous day high / low / close (previous IST session on intraday, previous bar on daily+).
    type: "pdhl",
    name: "Previous Day High/Low",
    description: "PDH, PDL and previous close as flat daily levels",
    category: "levels",
    popularInIndia: true,
    pane: "overlay",
    params: [],
    outputs: [
      { key: "pdh", label: "PDH", color: "#22d3ee", style: "levels", width: 1.5 },
      { key: "pdl", label: "PDL", color: "#f59e42", style: "levels", width: 1.5 },
      { key: "pdc", label: "PDC", color: "#8a93a6", style: "levels", dash: [4, 4] },
    ],
    calc: (bars) =>
      previousPeriodLevels(bars, ["pdh", "pdl", "pdc"], ({ high, low, close }) => ({ pdh: high, pdl: low, pdc: close })),
  },
  {
    // Opening range: high/low of the first N minutes of each IST session (NSE
    // opens 09:15, so ORB 15 = the 09:15–09:30 range). Plotted from the first
    // bar after the range completes; NaN while it is still forming and on
    // daily+ charts. On bars longer than N minutes the first bar is the range.
    type: "orb",
    name: "Opening Range Breakout",
    description: "High/low of the first N minutes of each session",
    category: "levels",
    popularInIndia: true,
    pane: "overlay",
    params: [{ key: "minutes", label: "Range (minutes)", default: 15, min: 1, max: 375 }],
    outputs: [
      { key: "high", label: "ORH", color: UP, style: "levels", width: 1.5 },
      { key: "low", label: "ORL", color: DOWN, style: "levels", width: 1.5 },
    ],
    fill: { from: "high", to: "low" },
    calc: (bars, p) => {
      const high = empty(bars.length);
      const low = empty(bars.length);
      if (!isIntradayData(bars)) return { high, low };
      for (const session of sessionsOf(bars)) {
        const rangeEnd = bars[session.start].time + p.minutes * 60_000;
        let rangeHigh = -Infinity;
        let rangeLow = Infinity;
        for (let i = session.start; i <= session.end; i += 1) {
          const bar = bars[i];
          if (bar.time < rangeEnd || i === session.start) {
            rangeHigh = Math.max(rangeHigh, bar.high);
            rangeLow = Math.min(rangeLow, bar.low);
            continue;
          }
          high[i] = rangeHigh;
          low[i] = rangeLow;
        }
      }
      return { high, low };
    },
  },
  {
    // Smart Money Concepts — see src/core/indicators/smc.ts.
    type: "smc",
    name: "Smart Money Concepts (SMC)",
    description: "Market structure (BOS/CHoCH), order blocks, fair value gaps, equal highs/lows, premium/discount",
    category: "levels",
    popularInIndia: true,
    pane: "overlay",
    guide: "smc",
    params: [
      { key: "swingLength", label: "Swing structure length", default: 50, min: 10, max: 200 },
      { key: "internalLength", label: "Internal structure length", default: 5, min: 2, max: 20 },
      { key: "showSwing", label: "Swing structure (HH/HL, BOS, CHoCH)", default: 1, min: 0, max: 1, toggle: true },
      { key: "showInternal", label: "Internal structure (dashed)", default: 1, min: 0, max: 1, toggle: true },
      { key: "showOrderBlocks", label: "Order blocks", default: 1, min: 0, max: 1, toggle: true },
      { key: "orderBlockCount", label: "Order blocks per side (nearest price)", default: 2, min: 1, max: 10 },
      { key: "showStrongWeak", label: "Strong / weak high & low", default: 1, min: 0, max: 1, toggle: true },
      { key: "showEqualHL", label: "Equal highs / lows", default: 1, min: 0, max: 1, toggle: true },
      { key: "showFvg", label: "Fair value gaps (nearest)", default: 0, min: 0, max: 1, toggle: true },
      { key: "showZones", label: "Premium / discount zones", default: 0, min: 0, max: 1, toggle: true },
      { key: "showHistory", label: "Show full history (busier)", default: 0, min: 0, max: 1, toggle: true },
    ],
    outputs: [],
    calc: () => ({}),
    annotate: (bars, p) => computeSmc(bars, p as unknown as SmcParams),
  },
  {
    // Automatic chart patterns + support/resistance — see src/chart/patterns.ts and docs/research/patterns.md.
    type: "patterns",
    name: "Auto chart patterns",
    description: "Triangles, boxes, double bottoms, flags, VCP, cup & handle with breakout / stop / measured target, plus S/R zones",
    category: "levels",
    pane: "overlay",
    params: [
      { key: "swingAtr", label: "Swing size (× ATR)", default: 2, min: 1, max: 5, step: 0.5 },
      { key: "lookback", label: "Look back (bars)", default: 160, min: 60, max: 400 },
      { key: "maxPatterns", label: "Patterns to draw", default: 2, min: 1, max: 4 },
      { key: "showPatterns", label: "Patterns", default: 1, min: 0, max: 1, toggle: true },
      { key: "showLevels", label: "Support / resistance zones", default: 1, min: 0, max: 1, toggle: true },
    ],
    outputs: [],
    calc: () => ({}),
    annotate: (bars, p) => patternAnnotations(bars, p),
  },
];

export const INDICATORS: Record<string, IndicatorDef> = Object.fromEntries(DEFS.map((def) => [def.type, def]));
export const INDICATOR_LIST = DEFS;

/** Config params merged over the definition's defaults (configs saved before a param existed stay valid). */
export function resolveParams(def: IndicatorDef, params: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const param of def.params) {
    const value = params?.[param.key];
    out[param.key] = typeof value === "number" && Number.isFinite(value) ? value : param.default;
  }
  return out;
}

/** Bar shift of an output for a given config (0 for unshifted outputs). */
export function outputOffset(output: OutputDef, params: Record<string, number>) {
  return output.offset ? Math.round(output.offset(params)) : 0;
}

export function createIndicatorConfig(type: string): IndicatorConfig {
  const def = INDICATORS[type];
  return {
    id: `${type}-${Math.random().toString(36).slice(2, 9)}`,
    type,
    params: Object.fromEntries(def.params.map((param) => [param.key, param.default])),
    colors: Object.fromEntries(
      def.outputs.flatMap((output) =>
        output.negColor ? [[output.key, output.color], [`${output.key}Neg`, output.negColor]] : [[output.key, output.color]],
      ),
    ),
  };
}

/** Short legend title, e.g. "EMA 20" / "MACD 12 26 9". */
export function indicatorTitle(config: IndicatorConfig) {
  const def = INDICATORS[config.type];
  if (!def) return config.type;
  const short: Record<string, string> = {
    sma: "MA",
    ema: "EMA",
    wma: "WMA",
    hma: "HMA",
    vwma: "VWMA",
    vwap: "VWAP",
    bb: "BB",
    keltner: "KC",
    donchian: "DC",
    supertrend: "Supertrend",
    psar: "SAR",
    ichimoku: "Ichimoku",
    adx: "ADX",
    aroon: "Aroon",
    rsi: "RSI",
    macd: "MACD",
    stoch: "Stoch",
    stochrsi: "Stoch RSI",
    cci: "CCI",
    willr: "%R",
    roc: "ROC",
    atr: "ATR",
    obv: "OBV",
    mfi: "MFI",
    cmf: "CMF",
    force: "EFI",
    cpr: "CPR",
    pivots: "Pivots",
    camarilla: "Camarilla",
    pdhl: "PDH/PDL",
    orb: "ORB",
    smc: "SMC",
    patterns: "Patterns",
  };
  const params = def.params
    .filter((param) => !param.toggle)
    .map((param) => config.params[param.key] ?? param.default)
    .join(" ");
  return `${short[def.type] ?? def.name}${params ? ` ${params}` : ""}`;
}
