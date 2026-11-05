import type { Bar } from "@/core/types";
import type { Annotations } from "@/core/indicators/smc";

// Automatic chart patterns on any bar series (daily or intraday).
//
// 1. Swings: an ATR-scaled ZigZag — a new swing needs the price to reverse by
//    `swingAtr` × ATR(14) from the last extreme, so the pivots adapt to each
//    stock's volatility instead of a fixed percentage.
// 2. Support / resistance: pivot prices clustered within 0.5 ATR; a level
//    needs at least two touches (Osler, FRBNY 2000, found published S/R levels
//    predict where intraday trends stall).
// 3. Patterns, all long-side breakout setups judged on the most recent pivots:
//    ascending / symmetrical triangle, rectangle (Darvas-style box), double
//    bottom, bull flag, volatility contraction (VCP) and cup with handle.
//    Each has a breakout level, a stop under the structure and a
//    measured-move target (pattern height added to the breakout — the
//    standard ChartSchool / Bulkowski "measure rule"). Descending triangles
//    are reported as bearish so long setups can be warned off.
//
// Thresholds are practitioner conventions, not fitted values; see
// docs/research/patterns.md. Lo, Mamaysky & Wang (2000) found such patterns
// carry some incremental information — not a guarantee.

export type PatternKind = "asc-triangle" | "sym-triangle" | "desc-triangle" | "rectangle" | "double-bottom" | "bull-flag" | "vcp" | "cup-handle";

export interface Pivot {
  index: number;
  price: number;
  type: "H" | "L";
}

export interface SRLevel {
  price: number;
  /** Zone half-width (price units). */
  band: number;
  touches: number;
  lastIndex: number;
  kind: "support" | "resistance";
}

export interface Pattern {
  kind: PatternKind;
  name: string;
  direction: "bull" | "bear";
  /** forming = below the breakout; breakout = closed above it within the last few bars; extended = ran > 1 height past it. */
  status: "forming" | "breakout" | "extended";
  start: number;
  end: number;
  breakout: number;
  stop: number;
  target: number;
  height: number;
  /** 0–100: touches, tightness, volume behaviour, trend alignment. */
  quality: number;
  /** Bars since the breakout bar (null while forming). */
  breakoutAgo: number | null;
  /** Lines that draw the pattern (bar-index / price space). */
  lines: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  notes: string[];
}

export interface PatternResult {
  pivots: Pivot[];
  levels: SRLevel[];
  patterns: Pattern[];
  /** Best bullish pattern by quality (forming or fresh breakout), if any. */
  best: Pattern | null;
  atr: number;
}

export interface PatternParams {
  swingAtr: number;
  lookback: number;
  maxPatterns: number;
  showLevels: number;
  showPatterns: number;
}

export const DEFAULT_PATTERN_PARAMS: PatternParams = { swingAtr: 2, lookback: 160, maxPatterns: 2, showLevels: 1, showPatterns: 1 };

const NAMES: Record<PatternKind, string> = {
  "asc-triangle": "Ascending triangle",
  "sym-triangle": "Symmetrical triangle",
  "desc-triangle": "Descending triangle",
  rectangle: "Rectangle (box)",
  "double-bottom": "Double bottom",
  "bull-flag": "Bull flag",
  vcp: "Volatility contraction (VCP)",
  "cup-handle": "Cup with handle",
};

// ------------------------------------------------------------------ helpers

function atrSeries(bars: Bar[], length = 14): Float64Array {
  const out = new Float64Array(bars.length).fill(NaN);
  let prev = NaN;
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i];
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - bars[i - 1].close), Math.abs(bar.low - bars[i - 1].close));
    if (i < length) {
      prev = Number.isNaN(prev) ? tr : prev + tr;
      if (i === length - 1) prev /= length;
      continue;
    }
    prev = Number.isNaN(prev) ? tr : (prev * (length - 1) + tr) / length;
    out[i] = prev;
  }
  return out;
}

function avgVolume(bars: Bar[], from: number, to: number) {
  let sum = 0;
  let count = 0;
  for (let i = Math.max(0, from); i <= Math.min(bars.length - 1, to); i += 1) {
    sum += bars[i].volume;
    count += 1;
  }
  return count ? sum / count : 0;
}

function smaAt(bars: Bar[], index: number, length: number) {
  if (index < length - 1) return NaN;
  let sum = 0;
  for (let i = index - length + 1; i <= index; i += 1) sum += bars[i].close;
  return sum / length;
}

/** Least-squares line through points; returns value(x). */
function fitLine(points: Array<{ index: number; price: number }>) {
  const n = points.length;
  const mx = points.reduce((sum, p) => sum + p.index, 0) / n;
  const my = points.reduce((sum, p) => sum + p.price, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.index - mx) * (p.price - my);
    den += (p.index - mx) ** 2;
  }
  const slope = den ? num / den : 0;
  return { slope, at: (x: number) => my + slope * (x - mx) };
}

const clamp = (value: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, value));

// ------------------------------------------------------------------ swings & levels

/** ATR-scaled ZigZag. The last pivot is provisional (the current extreme since the last confirmed swing). */
export function findPivots(bars: Bar[], atr: Float64Array, swingAtr: number, from = 0): Pivot[] {
  const pivots: Pivot[] = [];
  let dir: 1 | -1 | 0 = 0;
  let extIndex = from;
  let extPrice = bars[from]?.close ?? 0;
  for (let i = from; i < bars.length; i += 1) {
    const bar = bars[i];
    const threshold = swingAtr * (Number.isNaN(atr[i]) ? bar.close * 0.02 : atr[i]);
    if (dir >= 0) {
      if (bar.high >= extPrice || dir === 0) {
        if (dir === 0 && bar.low < extPrice - threshold) {
          dir = -1;
          extIndex = i;
          extPrice = bar.low;
          continue;
        }
        if (bar.high >= extPrice) {
          extIndex = i;
          extPrice = bar.high;
          if (dir === 0) dir = 1;
        }
      } else if (bar.low <= extPrice - threshold) {
        pivots.push({ index: extIndex, price: extPrice, type: "H" });
        dir = -1;
        extIndex = i;
        extPrice = bar.low;
      }
    } else if (bar.low <= extPrice) {
      extIndex = i;
      extPrice = bar.low;
    } else if (bar.high >= extPrice + threshold) {
      pivots.push({ index: extIndex, price: extPrice, type: "L" });
      dir = 1;
      extIndex = i;
      extPrice = bar.high;
    }
  }
  if (dir !== 0) pivots.push({ index: extIndex, price: extPrice, type: dir === 1 ? "H" : "L" });
  return pivots;
}

/** Cluster pivot prices into support/resistance zones (≥ 2 touches). */
export function findLevels(bars: Bar[], pivots: Pivot[], atr: number): SRLevel[] {
  const close = bars[bars.length - 1].close;
  const tolerance = Math.max(atr * 0.5, close * 0.004);
  const clusters: Array<{ prices: number[]; last: number }> = [];
  for (const pivot of pivots) {
    const cluster = clusters.find((entry) => Math.abs(entry.prices.reduce((a, b) => a + b, 0) / entry.prices.length - pivot.price) <= tolerance);
    if (cluster) {
      cluster.prices.push(pivot.price);
      cluster.last = Math.max(cluster.last, pivot.index);
    } else {
      clusters.push({ prices: [pivot.price], last: pivot.index });
    }
  }
  return clusters
    .filter((cluster) => cluster.prices.length >= 2)
    .map((cluster) => {
      const price = cluster.prices.reduce((a, b) => a + b, 0) / cluster.prices.length;
      return { price, band: tolerance, touches: cluster.prices.length, lastIndex: cluster.last, kind: price >= close ? "resistance" : "support" } as SRLevel;
    })
    .sort((a, b) => a.price - b.price);
}

// ------------------------------------------------------------------ pattern detectors

interface Ctx {
  bars: Bar[];
  pivots: Pivot[];
  atr: number;
  last: number;
  close: number;
  /** Uptrend: close above a rising 50-SMA. */
  uptrend: boolean;
}

function finish(ctx: Ctx, base: Omit<Pattern, "status" | "breakoutAgo" | "target" | "height" | "name" | "quality"> & { height: number; quality: number; target?: number }): Pattern {
  const { bars, last } = ctx;
  let breakoutIndex: number | null = null;
  for (let i = Math.max(base.end, last - 5); i <= last; i += 1) {
    if (bars[i].close > base.breakout && (i === 0 || bars[i - 1].close <= base.breakout)) breakoutIndex = i;
  }
  const target = base.target ?? base.breakout + base.height;
  const status: Pattern["status"] = ctx.close > base.breakout + base.height ? "extended" : breakoutIndex !== null || ctx.close > base.breakout ? "breakout" : "forming";
  let quality = base.quality;
  if (ctx.uptrend && base.direction === "bull") quality += 10;
  // A breakout on expanding volume is the confirmation every source asks for.
  if (breakoutIndex !== null) {
    const baseline = avgVolume(bars, breakoutIndex - 50, breakoutIndex - 1);
    if (baseline > 0 && bars[breakoutIndex].volume >= 1.4 * baseline) quality += 10;
    else quality -= 5;
  }
  if (status === "extended") quality -= 25;
  return {
    ...base,
    name: NAMES[base.kind],
    target,
    status,
    breakoutAgo: breakoutIndex !== null ? last - breakoutIndex : status === "breakout" ? 0 : null,
    quality: clamp(Math.round(quality)),
  };
}

/** Triangles and rectangles from the last 4–6 pivots. */
function detectConsolidation(ctx: Ctx): Pattern[] {
  const { pivots, atr, last } = ctx;
  const recent = pivots.filter((pivot) => pivot.index >= last - 90 && pivot.index < last);
  const highs = recent.filter((pivot) => pivot.type === "H").slice(-3);
  const lows = recent.filter((pivot) => pivot.type === "L").slice(-3);
  if (highs.length < 2 || lows.length < 2) return [];
  const start = Math.min(highs[0].index, lows[0].index);
  if (last - start < 12) return [];

  const top = fitLine(highs);
  const bottom = fitLine(lows);
  const flatTol = atr * 0.6;
  const highsFlat = Math.max(...highs.map((p) => p.price)) - Math.min(...highs.map((p) => p.price)) <= flatTol * 1.5;
  const lowsFlat = Math.max(...lows.map((p) => p.price)) - Math.min(...lows.map((p) => p.price)) <= flatTol * 1.5;
  const lowsRising = lows.every((pivot, i) => i === 0 || pivot.price > lows[i - 1].price + atr * 0.25);
  const highsFalling = highs.every((pivot, i) => i === 0 || pivot.price < highs[i - 1].price - atr * 0.25);
  const touches = highs.length + lows.length;
  const out: Pattern[] = [];

  const lineFor = (fit: ReturnType<typeof fitLine>, from: number) => ({ x1: from, y1: fit.at(from), x2: last, y2: fit.at(last) });

  if (highsFlat && lowsRising) {
    const breakout = Math.max(...highs.map((p) => p.price));
    out.push(
      finish(ctx, {
        kind: "asc-triangle",
        direction: "bull",
        start,
        end: last,
        breakout,
        stop: lows[lows.length - 1].price - atr * 0.25,
        height: breakout - lows[0].price,
        quality: 45 + touches * 5,
        lines: [
          { x1: highs[0].index, y1: breakout, x2: last, y2: breakout },
          lineFor(bottom, lows[0].index),
        ],
        notes: [`${highs.length} touches of a flat top, ${lows.length} rising lows`],
      }),
    );
  } else if (lowsFlat && highsFalling) {
    const floor = Math.min(...lows.map((p) => p.price));
    out.push(
      finish(ctx, {
        kind: "desc-triangle",
        direction: "bear",
        start,
        end: last,
        breakout: top.at(last),
        stop: floor - atr * 0.25,
        height: highs[0].price - floor,
        quality: 30 + touches * 5,
        lines: [lineFor(top, highs[0].index), { x1: lows[0].index, y1: floor, x2: last, y2: floor }],
        notes: ["Flat support with falling highs — bearish bias; a break of the floor targets lower prices"],
      }),
    );
  } else if (highsFalling && lowsRising) {
    const breakout = top.at(last);
    out.push(
      finish(ctx, {
        kind: "sym-triangle",
        direction: "bull",
        start,
        end: last,
        breakout,
        stop: Math.max(bottom.at(last), lows[lows.length - 1].price) - atr * 0.25,
        height: highs[0].price - lows[0].price,
        quality: 40 + touches * 4,
        lines: [lineFor(top, highs[0].index), lineFor(bottom, lows[0].index)],
        notes: ["Converging highs and lows — direction comes from the break; trade only an upside close"],
      }),
    );
  } else if (highsFlat && lowsFlat) {
    const boxTop = Math.max(...highs.map((p) => p.price));
    const boxBottom = Math.min(...lows.map((p) => p.price));
    const depth = (boxTop - boxBottom) / boxTop;
    if (depth >= 0.03 && depth <= 0.2) {
      out.push(
        finish(ctx, {
          kind: "rectangle",
          direction: "bull",
          start,
          end: last,
          breakout: boxTop,
          stop: boxBottom - atr * 0.25,
          height: boxTop - boxBottom,
          quality: 40 + touches * 5 + (ctx.uptrend ? 5 : 0),
          lines: [
            { x1: start, y1: boxTop, x2: last, y2: boxTop },
            { x1: start, y1: boxBottom, x2: last, y2: boxBottom },
          ],
          notes: [`${(depth * 100).toFixed(1)}% deep box — buy a close above the top, stop under the bottom (Darvas)`],
        }),
      );
    }
  }
  return out;
}

/** Two lows within ~3% of each other, ≥ 10 bars apart, with a real rally between (ChartSchool double-bottom reversal). */
function detectDoubleBottom(ctx: Ctx): Pattern[] {
  const { pivots, bars, atr, last } = ctx;
  const recent = pivots.filter((pivot) => pivot.index >= last - 120);
  for (let k = recent.length - 1; k >= 2; k -= 1) {
    const second = recent[k];
    if (second.type !== "L") continue;
    const peak = recent[k - 1];
    const first = recent[k - 2];
    if (peak.type !== "H" || first.type !== "L") continue;
    if (second.index - first.index < 10) continue;
    if (Math.abs(second.price - first.price) / first.price > 0.03) continue;
    const low = Math.min(first.price, second.price);
    // A real rally between the lows...
    if ((peak.price - low) / low < 0.08 || peak.price - low < atr * 2.5) continue;
    // ...and a real downtrend into the first low: it's a reversal pattern ("a significant downtrend of
    // several months", ChartSchool). Here: the high of the 60 bars before is ≥ 15% above the low.
    let priorHigh = 0;
    for (let i = Math.max(0, first.index - 60); i < first.index; i += 1) priorHigh = Math.max(priorHigh, bars[i].high);
    if (priorHigh < first.price * 1.15) continue;
    const vol1 = avgVolume(bars, first.index - 2, first.index + 2);
    const vol2 = avgVolume(bars, second.index - 2, second.index + 2);
    return [
      finish(ctx, {
        kind: "double-bottom",
        direction: "bull",
        start: first.index,
        end: last,
        breakout: peak.price,
        stop: low - atr * 0.25,
        height: peak.price - low,
        quality: 50 + (vol2 < vol1 ? 10 : 0) + (Math.abs(second.price - first.price) / first.price < 0.015 ? 10 : 0),
        lines: [
          { x1: first.index, y1: first.price, x2: peak.index, y2: peak.price },
          { x1: peak.index, y1: peak.price, x2: second.index, y2: second.price },
          { x1: first.index, y1: peak.price, x2: last, y2: peak.price },
        ],
        notes: [`Lows ${(((second.price - first.price) / first.price) * 100).toFixed(1)}% apart, ${second.index - first.index} bars apart${vol2 < vol1 ? ", lighter volume on the second low" : ""}`],
      }),
    ];
  }
  return [];
}

/** A pole of ≥ 3 ATR in ≤ 15 bars, then a 4–15 bar pullback that gives back ≤ 50% of it. */
function detectFlag(ctx: Ctx): Pattern[] {
  const { pivots, bars, atr, last } = ctx;
  const peak = [...pivots].reverse().find((pivot) => pivot.type === "H" && pivot.index < last && last - pivot.index >= 3 && last - pivot.index <= 15);
  if (!peak) return [];
  let poleStart = peak.index;
  for (let i = peak.index; i >= Math.max(0, peak.index - 15); i -= 1) if (bars[i].low < bars[poleStart].low) poleStart = i;
  const pole = peak.price - bars[poleStart].low;
  if (pole < atr * 3.5 || peak.index - poleStart < 3) return [];
  let flagLow = Infinity;
  for (let i = peak.index + 1; i <= last; i += 1) flagLow = Math.min(flagLow, bars[i].low);
  const retrace = (peak.price - flagLow) / pole;
  if (retrace > 0.5 || retrace < 0.1) return [];
  const flagVol = avgVolume(bars, peak.index + 1, last);
  const poleVol = avgVolume(bars, poleStart, peak.index);
  // The flag is a rest: volume should be lighter than on the pole.
  if (!(flagVol < poleVol * 0.9)) return [];
  return [
    finish(ctx, {
      kind: "bull-flag",
      direction: "bull",
      start: poleStart,
      end: last,
      breakout: peak.price,
      stop: flagLow - atr * 0.25,
      height: pole,
      target: peak.price + pole,
      quality: 60 + (flagVol < poleVol * 0.7 ? 10 : 0) + (retrace < 0.38 ? 10 : 0),
      lines: [
        { x1: poleStart, y1: bars[poleStart].low, x2: peak.index, y2: peak.price },
        { x1: peak.index, y1: peak.price, x2: last, y2: peak.price - (peak.price - flagLow) * 0.35 },
        { x1: peak.index, y1: flagLow + (peak.price - flagLow) * 0.35, x2: last, y2: flagLow },
      ],
      notes: [`Pole ${((pole / bars[poleStart].low) * 100).toFixed(1)}%, flag gave back ${(retrace * 100).toFixed(0)}% on ${Math.round((1 - flagVol / poleVol) * 100)}% lighter volume`],
    }),
  ];
}

/** Volatility contraction: ≥ 2 successively smaller pullbacks in an uptrend, the last one ≤ 10% (Minervini; thresholds are community conventions). */
function detectVcp(ctx: Ctx): Pattern[] {
  const { pivots, bars, atr, last } = ctx;
  if (!ctx.uptrend) return [];
  const recent = pivots.filter((pivot) => pivot.index >= last - 100);
  const drops: Array<{ high: Pivot; low: Pivot; depth: number }> = [];
  for (let k = 0; k + 1 < recent.length; k += 1) {
    if (recent[k].type === "H" && recent[k + 1].type === "L") drops.push({ high: recent[k], low: recent[k + 1], depth: (recent[k].price - recent[k + 1].price) / recent[k].price });
  }
  if (drops.length < 2) return [];
  // Walk back from the latest pullback while each earlier one was deeper.
  let count = 1;
  for (let k = drops.length - 1; k > 0; k -= 1) {
    if (drops[k].depth <= drops[k - 1].depth * 0.75) count += 1;
    else break;
  }
  if (count < 2) return [];
  const seq = drops.slice(-count);
  const lastDrop = seq[seq.length - 1];
  if (lastDrop.depth > 0.1) return [];
  const pivot = Math.max(lastDrop.high.price, ...bars.slice(lastDrop.low.index, last + 1).map((bar) => bar.high));
  if (seq[0].depth < 0.08) return [];
  const firstVol = avgVolume(bars, seq[0].high.index, seq[0].low.index);
  const lastVol = avgVolume(bars, lastDrop.high.index, last);
  // Volume drying up in the last contraction is part of the pattern, not a bonus.
  if (!(lastVol < firstVol * 0.85)) return [];
  return [
    finish(ctx, {
      kind: "vcp",
      direction: "bull",
      start: seq[0].high.index,
      end: last,
      breakout: pivot,
      stop: lastDrop.low.price - atr * 0.25,
      height: seq[0].high.price - seq[0].low.price,
      quality: 50 + count * 8 + (lastVol < firstVol * 0.7 ? 10 : 0),
      lines: seq.flatMap((drop) => [{ x1: drop.high.index, y1: drop.high.price, x2: drop.low.index, y2: drop.low.price }]).concat([{ x1: lastDrop.high.index, y1: pivot, x2: last, y2: pivot }]),
      notes: [`${count} contractions: ${seq.map((drop) => `${(drop.depth * 100).toFixed(0)}%`).join(" → ")}, volume ${Math.round((1 - lastVol / firstVol) * 100)}% lighter`],
    }),
  ];
}

/** Cup: a rounded 12–35% decline and recovery over 30–150 bars; handle: a shallow (≤ 1/3 of the cup) pullback near the right rim. */
function detectCup(ctx: Ctx): Pattern[] {
  const { pivots, bars, atr, last } = ctx;
  const highs = pivots.filter((pivot) => pivot.type === "H" && pivot.index >= last - 160);
  for (let r = highs.length - 1; r >= 1; r -= 1) {
    const right = highs[r];
    if (last - right.index > 25) continue;
    for (let l = r - 1; l >= 0; l -= 1) {
      const left = highs[l];
      const length = right.index - left.index;
      if (length < 30 || length > 150) continue;
      if (Math.abs(right.price - left.price) / left.price > 0.05) continue;
      let bottomIndex = left.index;
      for (let i = left.index; i <= right.index; i += 1) if (bars[i].low < bars[bottomIndex].low) bottomIndex = i;
      const bottom = bars[bottomIndex].low;
      const rim = Math.max(left.price, right.price);
      const depth = (rim - bottom) / rim;
      if (depth < 0.12 || depth > 0.35) continue;
      // Rounded, not V-shaped: the bottom sits in the middle half of the cup.
      const position = (bottomIndex - left.index) / length;
      if (position < 0.25 || position > 0.75) continue;
      // Rounded: the cup spends real time near its bottom (≥ 15% of its length in the lowest third).
      let nearBottom = 0;
      for (let i = left.index; i <= right.index; i += 1) if (bars[i].close <= bottom + (rim - bottom) / 3) nearBottom += 1;
      if (nearBottom < length * 0.15) continue;
      let handleLow = Infinity;
      for (let i = right.index + 1; i <= last; i += 1) handleLow = Math.min(handleLow, bars[i].low);
      const hasHandle = Number.isFinite(handleLow) && rim - handleLow <= (rim - bottom) / 3 && last - right.index >= 3;
      if (!hasHandle) continue;
      return [
        finish(ctx, {
          kind: "cup-handle",
          direction: "bull",
          start: left.index,
          end: last,
          breakout: rim,
          stop: handleLow - atr * 0.25,
          height: rim - bottom,
          quality: 60 + (ctx.uptrend ? 5 : 0) + ((rim - handleLow) / (rim - bottom) < 0.2 ? 5 : 0),
          lines: [
            { x1: left.index, y1: left.price, x2: bottomIndex, y2: bottom },
            { x1: bottomIndex, y1: bottom, x2: right.index, y2: right.price },
            { x1: left.index, y1: rim, x2: last, y2: rim },
            { x1: right.index, y1: right.price, x2: last, y2: handleLow },
          ],
          notes: [`Cup ${(depth * 100).toFixed(0)}% deep over ${length} bars, handle ${(((rim - handleLow) / rim) * 100).toFixed(1)}% deep`],
        }),
      ];
    }
  }
  return [];
}

// ------------------------------------------------------------------ entry point

export function detectPatterns(bars: Bar[], params: Partial<PatternParams> = {}): PatternResult {
  const p = { ...DEFAULT_PATTERN_PARAMS, ...params };
  const n = bars.length;
  const empty: PatternResult = { pivots: [], levels: [], patterns: [], best: null, atr: NaN };
  if (n < 40) return empty;
  const atrs = atrSeries(bars);
  const atr = atrs[n - 1];
  if (!Number.isFinite(atr) || atr <= 0) return empty;
  const from = Math.max(0, n - p.lookback);
  const pivots = findPivots(bars, atrs, p.swingAtr, from);
  const last = n - 1;
  const sma50 = smaAt(bars, last, 50);
  const sma50Prev = smaAt(bars, last - 10, 50);
  const ctx: Ctx = { bars, pivots, atr, last, close: bars[last].close, uptrend: bars[last].close > sma50 && sma50 > sma50Prev };

  const patterns = [...detectConsolidation(ctx), ...detectDoubleBottom(ctx), ...detectFlag(ctx), ...detectVcp(ctx), ...detectCup(ctx)]
    // Old breakouts are no longer setups.
    .filter((pattern) => pattern.status !== "breakout" || (pattern.breakoutAgo ?? 0) <= 5)
    .sort((a, b) => b.quality - a.quality);
  const best = patterns.find((pattern) => pattern.direction === "bull" && pattern.status !== "extended") ?? null;
  return { pivots, levels: findLevels(bars, pivots, atr), patterns, best, atr };
}

/** Nearest resistance strictly above `price` and support strictly below it. */
export function nearestLevels(levels: SRLevel[], price: number) {
  const above = levels.filter((level) => level.price - level.band > price).sort((a, b) => a.price - b.price)[0] ?? null;
  const below = levels.filter((level) => level.price + level.band < price).sort((a, b) => b.price - a.price)[0] ?? null;
  return { resistance: above, support: below };
}

// ------------------------------------------------------------------ drawing

const BEAR = "#ef5350";
const PATTERN = "#f7a600";
const TARGET = "#089981";
const STOP = "#f23645";
const LEVEL_R = "#f23645";
const LEVEL_S = "#089981";

/** Annotations for the chart: the best patterns (lines, breakout/target/stop) and the nearest S/R zones. */
export function patternAnnotations(bars: Bar[], params: Partial<PatternParams> = {}): Annotations {
  const p = { ...DEFAULT_PATTERN_PARAMS, ...params };
  const result = detectPatterns(bars, p);
  const ann: Annotations = { boxes: [], lines: [], segments: [], labels: [] };
  if (!bars.length) return ann;
  const last = bars.length - 1;
  const close = bars[last].close;

  if (p.showLevels) {
    const above = result.levels.filter((level) => level.price > close).slice(0, 2);
    const below = result.levels.filter((level) => level.price <= close).slice(-2);
    for (const level of [...above, ...below]) {
      const color = level.price > close ? LEVEL_R : LEVEL_S;
      ann.boxes.push({
        x1: Math.max(0, last - p.lookback),
        x2: null,
        top: level.price + level.band,
        bottom: level.price - level.band,
        color,
        alpha: 0.07,
        border: false,
        label: `${level.price > close ? "R" : "S"} · ${level.touches} touches`,
      });
    }
  }

  if (p.showPatterns) {
    for (const pattern of result.patterns.filter((entry) => entry.status !== "extended").slice(0, p.maxPatterns)) {
      const color = pattern.direction === "bull" ? PATTERN : BEAR;
      for (const line of pattern.lines) ann.segments.push({ ...line, color, labelSide: "above", dashed: false, width: 1.5 });
      ann.labels.push({
        x: pattern.start,
        y: Math.max(...pattern.lines.map((line) => Math.max(line.y1, line.y2))),
        text: `${pattern.name}${pattern.status === "breakout" ? " · breakout" : ""}`,
        color,
        side: "above",
      });
      if (pattern.direction === "bull") {
        ann.lines.push({ x1: pattern.end, x2: null, y: pattern.breakout, color: PATTERN, dashed: true, label: `Breakout ${pattern.breakout.toFixed(2)}`, labelSide: "above", role: "level" });
        ann.lines.push({ x1: pattern.end, x2: null, y: pattern.target, color: TARGET, dashed: true, label: `Pattern target ${pattern.target.toFixed(2)}`, labelSide: "above", role: "level" });
        ann.lines.push({ x1: pattern.end, x2: null, y: pattern.stop, color: STOP, dashed: true, label: `Pattern stop ${pattern.stop.toFixed(2)}`, labelSide: "below", role: "level" });
      }
    }
  }
  return ann;
}
