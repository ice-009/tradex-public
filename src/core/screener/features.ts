import type { Bar } from "@/core/types";
import { INDICATORS, ema, sma, type Series } from "@/core/indicators/indicators";
import { detectPatterns, nearestLevels, type PatternKind } from "@/core/indicators/patterns";

/** The best bullish chart pattern on the daily chart (see src/chart/patterns.ts). */
export interface PatternSummary {
  kind: PatternKind;
  name: string;
  status: "forming" | "breakout" | "extended";
  breakout: number;
  stop: number;
  target: number;
  quality: number;
  breakoutAgo: number | null;
  note: string;
}

// Per-symbol metrics the screens are written against. Computed from daily
// bars (oldest → newest); the last bar is "today" (live or last close).
// Anything that can't be computed for lack of history is NaN, and every
// comparison against NaN is false — so short histories simply don't match.

export interface DailyInput {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  dp?: number;
}

export interface Features {
  symbol: string;
  barCount: number;
  date: number;
  live: boolean;

  open: number;
  high: number;
  low: number;
  close: number;
  prevClose: number;
  prevHigh: number;
  changePct: number;
  /** Close location value: 0 = closed at the low, 1 = at the high. */
  clv: number;
  rangePct: number;

  volume: number;
  avgVol20: number;
  avgVol50: number;
  volRatio20: number;
  volRatio50: number;
  /** Average daily traded value over 20 sessions, ₹ crore. */
  turnoverCr20: number;

  sma5: number;
  sma20: number;
  /** Yesterday's close and 20-day SMA, for "reclaimed the 20-day average". */
  sma20Prev: number;
  ema20: number;
  ema25: number;
  ema50: number;
  ema50Prev5: number;
  sma50: number;
  sma150: number;
  sma200: number;
  sma200Prev22: number;

  rsi14: number;
  rsi14Prev: number;
  rsi2: number;
  atr14: number;
  atr20: number;
  adx14: number;
  plusDI: number;
  minusDI: number;

  /** Highest high / lowest low of the N sessions BEFORE today. */
  high20Prev: number;
  low10Prev: number;
  high52: number;
  low52: number;
  minLow3: number;
  minLow5: number;
  baseHigh: number; // prior 30 sessions
  baseLow: number;

  nr7: boolean;
  insideDay: boolean;

  /** Bull flag: % gain over the 10 sessions before the last 5 (the pole). */
  flagPolePct: number;
  /** Bull flag: high-low range of the last 5 closes, % of their low (the flag). */
  flagRangePct: number;
  /** Highest high / lowest low of the last 5 sessions (the flag's box). */
  maxHigh5: number;

  /** Today's open vs yesterday's close, %. */
  gapPct: number;
  /**
   * Most recent "event" day in the 10 sessions before today: a gap of ≥ 4%
   * (up or down) on ≥ 3× 50-day volume — usually results or other news.
   * NaN fields when there was none.
   */
  eventAgo: number;
  eventGapPct: number;
  eventLow: number;
  eventHigh: number;
  eventClose: number;
  /** Lowest low since the event day (event day included). */
  lowSinceEvent: number;

  ret5: number;
  ret21: number;

  /** Best bullish chart pattern (null when none). */
  pattern: PatternSummary | null;
  /** A bearish pattern (descending triangle) is forming. */
  bearishPattern: string | null;
  /** Nearest S/R zone above / below the close (NaN when none). */
  resistance: number;
  support: number;
  /** Chandelier exit for longs: 22-day high − 3 × ATR(22) (LeBeau; StockCharts defaults). */
  chandelier: number;
  /** Volume on up days ÷ volume on down days over 20 sessions (accumulation > 1). */
  upDownVol20: number;
  /** How stretched the close is above its 20 EMA, in ATRs. */
  ext20Atr: number;

  ret63: number;
  ret126: number;
  ret189: number;
  ret252: number;
  /** IBD-style weighted 12-month performance (approximation; IBD's RS formula is proprietary). */
  rsScore: number;
  /** Percentile 1–99 of rsScore within the scanned universe (filled in by the caller). */
  rsRank: number;

  deliveryPct: number;
  deliveryAvg20: number;
  deliveryDate: number;
}

/** An "event" day: a gap at least this big (%, either way)... */
export const EVENT_GAP_PCT = 4;
/** ...on at least this multiple of the 50-day average volume. */
export const EVENT_VOL_X = 3;

const at = (series: Series, offset = 0) => series[series.length - 1 - offset] ?? NaN;

function windowExtreme(values: number[], end: number, length: number, pick: "max" | "min") {
  const start = end - length;
  if (start < 0) return NaN;
  let result = pick === "max" ? -Infinity : Infinity;
  for (let i = start; i < end; i += 1) result = pick === "max" ? Math.max(result, values[i]) : Math.min(result, values[i]);
  return result;
}

function average(values: number[], end: number, length: number) {
  const start = end - length;
  if (start < 0) return NaN;
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += values[i];
  return sum / length;
}

function pctChange(closes: number[], lookback: number) {
  const n = closes.length;
  return n > lookback ? (closes[n - 1] / closes[n - 1 - lookback] - 1) * 100 : NaN;
}

export function computeFeatures(symbol: string, input: DailyInput[], live: boolean): Features {
  const n = input.length;
  const bars: Bar[] = input.map((bar) => ({ time: bar.t, open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v }));
  const closes = input.map((bar) => bar.c);
  const highs = input.map((bar) => bar.h);
  const lows = input.map((bar) => bar.l);
  const volumes = input.map((bar) => bar.v);
  const closeSeries = Float64Array.from(closes);
  const today = input[n - 1];
  const yesterday = input[n - 2];

  const rsi14 = INDICATORS.rsi.calc(bars, { length: 14 }).rsi;
  const atr22 = INDICATORS.atr.calc(bars, { length: 22 }).atr;
  const rsi2 = INDICATORS.rsi.calc(bars, { length: 2 }).rsi;
  const atr14 = INDICATORS.atr.calc(bars, { length: 14 }).atr;
  const atr20 = INDICATORS.atr.calc(bars, { length: 20 }).atr;
  const adx = INDICATORS.adx.calc(bars, { length: 14 });
  const sma200 = sma(closeSeries, 200);
  const sma20 = sma(closeSeries, 20);
  const ema50 = ema(closeSeries, 50);

  // "Today" is excluded from its own baseline so a volume spike isn't diluted by itself.
  const avgVol20 = average(volumes, n - 1, 20);
  const avgVol50 = average(volumes, n - 1, 50);
  let turnover = 0;
  for (let i = Math.max(0, n - 21); i < n - 1; i += 1) turnover += closes[i] * volumes[i];
  const turnoverCr20 = n > 21 ? turnover / 20 / 1e7 : NaN;

  const range = today.h - today.l;
  const ranges = input.map((bar) => bar.h - bar.l);
  const nr7 = n >= 7 && ranges.slice(n - 7, n - 1).every((prior) => range < prior);

  // Bull flag (trader-scanner rule, on closes): pole = 10 sessions before the last 5, flag = last 5 closes.
  const flagCloses = closes.slice(n - 5);
  const flagPolePct = n >= 16 ? (closes[n - 6] / closes[n - 16] - 1) * 100 : NaN;
  const flagRangePct = n >= 5 ? (Math.max(...flagCloses) / Math.min(...flagCloses) - 1) * 100 : NaN;

  // Event days (gap ≥ EVENT_GAP_PCT on ≥ EVENT_VOL_X × 50-day volume) in the 10 sessions before today.
  let eventIndex = -1;
  for (let i = n - 2; i >= Math.max(51, n - 11); i -= 1) {
    const gap = (input[i].o / input[i - 1].c - 1) * 100;
    const baseline = average(volumes, i, 50);
    if (Math.abs(gap) >= EVENT_GAP_PCT && baseline > 0 && input[i].v >= EVENT_VOL_X * baseline) {
      eventIndex = i;
      break;
    }
  }
  let lowSinceEvent = NaN;
  if (eventIndex >= 0) {
    lowSinceEvent = Infinity;
    for (let i = eventIndex; i < n; i += 1) lowSinceEvent = Math.min(lowSinceEvent, lows[i]);
  }

  const patterns = detectPatterns(bars);
  const best = patterns.best;
  const bearish = patterns.patterns.find((pattern) => pattern.direction === "bear" && pattern.status === "forming");
  const levels = nearestLevels(patterns.levels, today.c);
  let upVol = 0;
  let downVol = 0;
  for (let i = Math.max(1, n - 20); i < n; i += 1) {
    if (input[i].c > input[i - 1].c) upVol += input[i].v;
    else if (input[i].c < input[i - 1].c) downVol += input[i].v;
  }

  const ret63 = pctChange(closes, 63);
  const ret126 = pctChange(closes, 126);
  const ret189 = pctChange(closes, 189);
  const ret252 = pctChange(closes, Math.min(252, n - 1));

  // Delivery % only exists on completed (bhavcopy) sessions.
  let deliveryIndex = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (input[i].dp !== undefined) {
      deliveryIndex = i;
      break;
    }
  }
  const priorDelivery: number[] = [];
  for (let i = deliveryIndex - 1; i >= 0 && priorDelivery.length < 20; i -= 1) {
    if (input[i].dp !== undefined) priorDelivery.push(input[i].dp as number);
  }

  return {
    symbol,
    barCount: n,
    date: today.t,
    live,
    open: today.o,
    high: today.h,
    low: today.l,
    close: today.c,
    prevClose: yesterday?.c ?? NaN,
    prevHigh: yesterday?.h ?? NaN,
    changePct: yesterday ? (today.c / yesterday.c - 1) * 100 : NaN,
    clv: range > 0 ? (today.c - today.l) / range : 0.5,
    rangePct: today.c ? (range / today.c) * 100 : NaN,
    volume: today.v,
    avgVol20,
    avgVol50,
    volRatio20: avgVol20 > 0 ? today.v / avgVol20 : NaN,
    volRatio50: avgVol50 > 0 ? today.v / avgVol50 : NaN,
    turnoverCr20,
    sma5: at(sma(closeSeries, 5)),
    sma20: at(sma20),
    sma20Prev: at(sma20, 1),
    ema20: at(ema(closeSeries, 20)),
    ema25: at(ema(closeSeries, 25)),
    ema50: at(ema50),
    ema50Prev5: at(ema50, 5),
    sma50: at(sma(closeSeries, 50)),
    sma150: at(sma(closeSeries, 150)),
    sma200: at(sma200),
    sma200Prev22: at(sma200, 22),
    rsi14: at(rsi14),
    rsi14Prev: at(rsi14, 1),
    rsi2: at(rsi2),
    atr14: at(atr14),
    atr20: at(atr20),
    adx14: at(adx.adx),
    plusDI: at(adx.plusDI),
    minusDI: at(adx.minusDI),
    high20Prev: windowExtreme(highs, n - 1, 20, "max"),
    low10Prev: windowExtreme(lows, n - 1, 10, "min"),
    high52: windowExtreme(highs, n, Math.min(252, n), "max"),
    low52: windowExtreme(lows, n, Math.min(252, n), "min"),
    minLow3: windowExtreme(lows, n, 3, "min"),
    minLow5: windowExtreme(lows, n, 5, "min"),
    baseHigh: windowExtreme(highs, n - 1, 30, "max"),
    baseLow: windowExtreme(lows, n - 1, 30, "min"),
    nr7,
    insideDay: Boolean(yesterday && today.h <= yesterday.h && today.l >= yesterday.l),
    flagPolePct,
    flagRangePct,
    maxHigh5: windowExtreme(highs, n, 5, "max"),
    gapPct: yesterday ? (today.o / yesterday.c - 1) * 100 : NaN,
    eventAgo: eventIndex >= 0 ? n - 1 - eventIndex : NaN,
    eventGapPct: eventIndex >= 0 ? (input[eventIndex].o / input[eventIndex - 1].c - 1) * 100 : NaN,
    eventLow: eventIndex >= 0 ? input[eventIndex].l : NaN,
    eventHigh: eventIndex >= 0 ? input[eventIndex].h : NaN,
    eventClose: eventIndex >= 0 ? input[eventIndex].c : NaN,
    lowSinceEvent,
    ret5: pctChange(closes, 5),
    ret21: pctChange(closes, 21),
    pattern: best
      ? {
          kind: best.kind,
          name: best.name,
          status: best.status,
          breakout: best.breakout,
          stop: best.stop,
          target: best.target,
          quality: best.quality,
          breakoutAgo: best.breakoutAgo,
          note: best.notes[0] ?? "",
        }
      : null,
    bearishPattern: bearish ? bearish.name : null,
    resistance: levels.resistance?.price ?? NaN,
    support: levels.support?.price ?? NaN,
    chandelier: windowExtreme(highs, n, Math.min(22, n), "max") - 3 * at(atr22),
    upDownVol20: downVol > 0 ? upVol / downVol : upVol > 0 ? 3 : NaN,
    ext20Atr: (today.c - at(ema(closeSeries, 20))) / at(atr14),
    ret63,
    ret126,
    ret189,
    ret252,
    rsScore: volAdjustedMomentum(closes),
    rsRank: NaN,
    deliveryPct: deliveryIndex >= 0 ? (input[deliveryIndex].dp as number) : NaN,
    deliveryAvg20: priorDelivery.length >= 10 ? priorDelivery.reduce((sum, value) => sum + value, 0) / priorDelivery.length : NaN,
    deliveryDate: deliveryIndex >= 0 ? input[deliveryIndex].t : NaN,
  };
}

/** Annualised volatility (%) of daily log returns over the last `days` sessions; NaN with too little data. */
export function annualVolatility(closes: number[], days: number): number {
  const n = closes.length;
  if (n < days + 1) return NaN;
  const returns: number[] = [];
  for (let i = n - days; i < n; i += 1) if (closes[i - 1] > 0 && closes[i] > 0) returns.push(Math.log(closes[i] / closes[i - 1]));
  if (returns.length < days * 0.8) return NaN;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * 252) * 100;
}

/**
 * Volatility-adjusted momentum, as NSE ranks its Nifty200 Momentum 30 index:
 * the 6- and 12-month price returns, each divided by the stock's own volatility
 * over that span, averaged. A steady +30% outranks a wild +30%, which is less
 * reliable and crashes harder. Falls back to the 6-month ratio with under a
 * year of history; NaN with under ~6 months.
 */
export function volAdjustedMomentum(closes: number[]): number {
  const n = closes.length;
  const ratio = (days: number) => {
    if (n <= days) return NaN;
    const ret = (closes[n - 1] / closes[n - 1 - days] - 1) * 100;
    const vol = annualVolatility(closes, days);
    return Number.isFinite(ret) && vol > 0 ? ret / vol : NaN;
  };
  const six = ratio(126);
  const twelve = ratio(252);
  if (!Number.isFinite(six)) return NaN;
  return Number.isFinite(twelve) ? (six + twelve) / 2 : six;
}

/** Fill rsRank (1–99 percentile of rsScore) across a universe in place. */
export function rankRelativeStrength(features: Features[]) {
  const scored = features.filter((feature) => Number.isFinite(feature.rsScore)).sort((a, b) => a.rsScore - b.rsScore);
  scored.forEach((feature, index) => {
    feature.rsRank = scored.length > 1 ? Math.round(1 + (98 * index) / (scored.length - 1)) : 50;
  });
}
