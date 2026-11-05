import type { Bar } from "@/core/types";

// Smart Money Concepts (SMC): market-structure annotations computed from bars.
//
// Our own implementation of the concepts popularised by ICT and by LuxAlgo's
// "Smart Money Concepts" TradingView script (which INDmoney-style SMC overlays
// follow): swing/internal structure, BOS/CHoCH, order blocks, fair value gaps,
// equal highs/lows and premium/discount zones. No code is taken from that
// (CC BY-NC-SA) script; the detection rules are documented in the functions below.
//
// Everything is expressed in bar-index / price space; the engine maps it to
// pixels. A box or line with x2 = null runs to the right edge of the chart.

export interface AnnBox {
  x1: number;
  x2: number | null;
  top: number;
  bottom: number;
  color: string;
  alpha: number;
  label?: string;
  border?: boolean;
}

export interface AnnLine {
  x1: number;
  x2: number | null;
  y: number;
  color: string;
  dashed: boolean;
  label?: string;
  labelSide: "above" | "below";
  bold?: boolean;
  /** "level" lines (a pattern's breakout / target / stop) are hidden while a trade plan shows the same levels. */
  role?: "level";
}

export interface AnnSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  label?: string;
  labelSide: "above" | "below";
  /** Default true (SMC structure lines); chart patterns draw solid trendlines. */
  dashed?: boolean;
  width?: number;
}

export interface AnnLabel {
  x: number;
  y: number;
  text: string;
  color: string;
  side: "above" | "below";
}

export interface Annotations {
  boxes: AnnBox[];
  lines: AnnLine[];
  segments: AnnSegment[];
  labels: AnnLabel[];
}

export const SMC_COLORS = {
  bull: "#089981",
  bear: "#f23645",
  bullOb: "#2962ff",
  bearOb: "#f23645",
  bullFvg: "#089981",
  bearFvg: "#f59e42",
  premium: "#f23645",
  discount: "#089981",
  equilibrium: "#8a93a6",
  text: "#c9cfdb",
};

const BULL = 1;
const BEAR = -1;

interface Pivot {
  price: number;
  index: number;
  crossed: boolean;
}

interface OrderBlock {
  top: number;
  bottom: number;
  index: number;
  bias: number;
  mitigated: boolean;
}

interface Structure {
  length: number;
  leg: number; // BULL = currently in an up-leg, BEAR = down-leg (starts BEAR, like a fresh chart)
  top: Pivot | null;
  bottom: Pivot | null;
  trend: number; // 0 until the first break
  orderBlocks: OrderBlock[];
}

/** Wilder ATR, with a shorter period while history is shorter than `length`. */
function atrSeries(bars: Bar[], length: number) {
  const out = new Float64Array(bars.length);
  let prev = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const tr = i === 0 ? bar.high - bar.low : Math.max(bar.high - bar.low, Math.abs(bar.high - bars[i - 1].close), Math.abs(bar.low - bars[i - 1].close));
    const period = Math.min(length, i + 1);
    prev = i === 0 ? tr : (prev * (period - 1) + tr) / period;
    out[i] = prev;
  }
  return out;
}

export interface SmcParams {
  swingLength: number;
  internalLength: number;
  showSwing: number;
  showInternal: number;
  showOrderBlocks: number;
  orderBlockCount: number;
  showFvg: number;
  showEqualHL: number;
  showZones: number;
  showStrongWeak: number;
  /** 0 = clean "present" view (recent structure, nearest zones); 1 = everything since the first bar. */
  showHistory: number;
}

export function computeSmc(bars: Bar[], params: SmcParams): Annotations {
  const out: Annotations = { boxes: [], lines: [], segments: [], labels: [] };
  const n = bars.length;
  if (n < 10) return out;

  const atr = atrSeries(bars, 200);
  // Very large candles make misleading order blocks; use their body-side extreme instead
  // (high-volatility bars swap high/low for OB selection).
  const parsedHigh = new Float64Array(n);
  const parsedLow = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const volatile = bars[i].high - bars[i].low >= 2 * atr[i];
    parsedHigh[i] = volatile ? bars[i].low : bars[i].high;
    parsedLow[i] = volatile ? bars[i].high : bars[i].low;
  }

  const swing: Structure = { length: Math.max(2, Math.round(params.swingLength)), leg: BEAR, top: null, bottom: null, trend: 0, orderBlocks: [] };
  const internal: Structure = { length: Math.max(2, Math.round(params.internalLength)), leg: BEAR, top: null, bottom: null, trend: 0, orderBlocks: [] };
  const equal: Structure = { length: 3, leg: BEAR, top: null, bottom: null, trend: 0, orderBlocks: [] };

  // Trailing extremes since the last swing pivots → premium/discount + strong/weak.
  let trailTop = NaN;
  let trailTopIndex = 0;
  let trailBottom = NaN;
  let trailBottomIndex = 0;

  // FVG auto-threshold: 2 × running mean of |candle body %|.
  let deltaSum = 0;
  const fvgs: Array<{ top: number; bottom: number; index: number; bias: number; filled: boolean }> = [];
  const eqSegments: AnnSegment[] = [];
  const swingBreaks: AnnLine[] = [];
  const internalBreaks: AnnLine[] = [];
  const swingLabels: AnnLabel[] = [];

  /** Advance pivot detection; returns which pivot (if any) was confirmed at bar i - length. */
  const detectPivot = (s: Structure, i: number): "high" | "low" | null => {
    const j = i - s.length;
    if (j < 0) return null;
    let maxHigh = -Infinity;
    let minLow = Infinity;
    for (let k = j + 1; k <= i; k += 1) {
      if (bars[k].high > maxHigh) maxHigh = bars[k].high;
      if (bars[k].low < minLow) minLow = bars[k].low;
    }
    let leg = s.leg;
    if (bars[j].high > maxHigh) leg = BEAR; // bar j is the highest of the window → a down-leg began there
    else if (bars[j].low < minLow) leg = BULL;
    if (leg === s.leg) return null;
    s.leg = leg;
    return leg === BULL ? "low" : "high";
  };

  const breakStructure = (s: Structure, i: number, isInternal: boolean) => {
    const close = bars[i].close;
    const top = s.top;
    const bottom = s.bottom;
    // Internal breaks that coincide with the swing level are drawn once, by the swing structure.
    if (top && !top.crossed && close > top.price && !(isInternal && swing.top && swing.top.price === top.price)) {
      const tag = s.trend === BEAR ? "CHoCH" : "BOS";
      s.trend = BULL;
      top.crossed = true;
      if (isInternal ? params.showInternal : params.showSwing) {
        (isInternal ? internalBreaks : swingBreaks).push({ x1: top.index, x2: i, y: top.price, color: SMC_COLORS.bull, dashed: isInternal, label: tag, labelSide: "above", bold: !isInternal });
      }
      // Bullish order block: the lowest candle of the leg that broke structure.
      let k = top.index;
      for (let m = top.index; m < i; m += 1) if (parsedLow[m] < parsedLow[k]) k = m;
      s.orderBlocks.push({ top: parsedHigh[k], bottom: parsedLow[k], index: k, bias: BULL, mitigated: false });
    } else if (bottom && !bottom.crossed && close < bottom.price && !(isInternal && swing.bottom && swing.bottom.price === bottom.price)) {
      const tag = s.trend === BULL ? "CHoCH" : "BOS";
      s.trend = BEAR;
      bottom.crossed = true;
      if (isInternal ? params.showInternal : params.showSwing) {
        (isInternal ? internalBreaks : swingBreaks).push({ x1: bottom.index, x2: i, y: bottom.price, color: SMC_COLORS.bear, dashed: isInternal, label: tag, labelSide: "below", bold: !isInternal });
      }
      let k = bottom.index;
      for (let m = bottom.index; m < i; m += 1) if (parsedHigh[m] > parsedHigh[k]) k = m;
      s.orderBlocks.push({ top: parsedHigh[k], bottom: parsedLow[k], index: k, bias: BEAR, mitigated: false });
    }
    // Mitigation: price trading through the far side of the block retires it.
    for (const ob of s.orderBlocks) {
      if (ob.mitigated || ob.index >= i) continue;
      if (ob.bias === BULL ? bars[i].low < ob.bottom : bars[i].high > ob.top) ob.mitigated = true;
    }
  };

  for (let i = 0; i < n; i += 1) {
    const bar = bars[i];

    // ---- swing pivots (labels + trailing extremes)
    const swingPivot = detectPivot(swing, i);
    if (swingPivot === "high") {
      const j = i - swing.length;
      const price = bars[j].high;
      if (params.showSwing && swing.top) {
        swingLabels.push({ x: j, y: price, text: price > swing.top.price ? "HH" : "LH", color: SMC_COLORS.text, side: "above" });
      }
      swing.top = { price, index: j, crossed: false };
      trailTop = price;
      trailTopIndex = j;
    } else if (swingPivot === "low") {
      const j = i - swing.length;
      const price = bars[j].low;
      if (params.showSwing && swing.bottom) {
        swingLabels.push({ x: j, y: price, text: price < swing.bottom.price ? "LL" : "HL", color: SMC_COLORS.text, side: "below" });
      }
      swing.bottom = { price, index: j, crossed: false };
      trailBottom = price;
      trailBottomIndex = j;
    }
    if (!Number.isNaN(trailTop) && bar.high > trailTop) {
      trailTop = bar.high;
      trailTopIndex = i;
    }
    if (!Number.isNaN(trailBottom) && bar.low < trailBottom) {
      trailBottom = bar.low;
      trailBottomIndex = i;
    }

    // ---- internal pivots
    const internalPivot = detectPivot(internal, i);
    if (internalPivot === "high") {
      const j = i - internal.length;
      internal.top = { price: bars[j].high, index: j, crossed: false };
    } else if (internalPivot === "low") {
      const j = i - internal.length;
      internal.bottom = { price: bars[j].low, index: j, crossed: false };
    }

    // ---- equal highs / lows (3-bar pivots within 0.1 ATR of the previous one)
    const equalPivot = detectPivot(equal, i);
    if (equalPivot) {
      const j = i - equal.length;
      const isHigh = equalPivot === "high";
      const price = isHigh ? bars[j].high : bars[j].low;
      const previous = isHigh ? equal.top : equal.bottom;
      if (previous && Math.abs(price - previous.price) < 0.1 * atr[i]) {
        eqSegments.push({
          x1: previous.index,
          y1: previous.price,
          x2: j,
          y2: price,
          color: isHigh ? SMC_COLORS.bear : SMC_COLORS.bull,
          label: isHigh ? "EQH" : "EQL",
          labelSide: isHigh ? "above" : "below",
        });
      }
      if (isHigh) equal.top = { price, index: j, crossed: false };
      else equal.bottom = { price, index: j, crossed: false };
    }

    // ---- structure breaks + order blocks
    breakStructure(internal, i, true);
    breakStructure(swing, i, false);

    // ---- fair value gaps
    if (i >= 2) {
      const middle = bars[i - 1];
      const deltaPct = middle.open ? ((middle.close - middle.open) / middle.open) * 100 : 0;
      deltaSum += Math.abs(deltaPct);
      const threshold = (deltaSum / (i - 1)) * 2;
      const first = bars[i - 2];
      if (bar.low > first.high && middle.close > first.high && deltaPct > threshold) {
        fvgs.push({ top: bar.low, bottom: first.high, index: i - 1, bias: BULL, filled: false });
      } else if (bar.high < first.low && middle.close < first.low && -deltaPct > threshold) {
        fvgs.push({ top: first.low, bottom: bar.high, index: i - 1, bias: BEAR, filled: false });
      }
    }
    for (const gap of fvgs) {
      if (gap.filled || gap.index >= i - 1) continue;
      if (gap.bias === BULL ? bar.low < gap.bottom : bar.high > gap.top) gap.filled = true;
    }
  }

  // ---- output. The default "present" view keeps only what matters for the
  // current price: the latest few structure breaks and the zones nearest price.
  const history = params.showHistory === 1;
  const recent = <T,>(items: T[], count: number) => (history ? items : items.slice(-count));
  const close = bars[n - 1].close;

  out.lines.push(...recent(swingBreaks, 3), ...recent(internalBreaks, 3));
  out.labels.push(...recent(swingLabels, 4));

  /** Nearest boxes on each side of price, skipping ones that mostly overlap a box already chosen. */
  const nearest = <T extends { top: number; bottom: number; bias: number }>(items: T[], perSide: number) => {
    const pick = (side: T[]) => {
      const chosen: T[] = [];
      for (const item of side) {
        if (chosen.length >= perSide) break;
        const overlaps = chosen.some((other) => {
          const shared = Math.min(other.top, item.top) - Math.max(other.bottom, item.bottom);
          return shared > 0.5 * Math.min(other.top - other.bottom, item.top - item.bottom);
        });
        if (!overlaps) chosen.push(item);
      }
      return chosen;
    };
    if (history) return items;
    const below = items.filter((item) => item.bias === BULL && item.bottom <= close).sort((a, b) => b.top - a.top);
    const above = items.filter((item) => item.bias === BEAR && item.top >= close).sort((a, b) => a.bottom - b.bottom);
    return [...pick(below), ...pick(above)];
  };

  if (params.showOrderBlocks) {
    const perSide = Math.max(1, Math.round(params.orderBlockCount));
    const candidates = [
      ...(params.showSwing ? swing.orderBlocks.filter((ob) => !ob.mitigated).map((ob) => ({ ...ob, swing: true })) : []),
      ...(params.showInternal ? internal.orderBlocks.filter((ob) => !ob.mitigated).map((ob) => ({ ...ob, swing: false })) : []),
    ];
    for (const ob of nearest(candidates, perSide)) {
      out.boxes.push({
        x1: ob.index,
        x2: null,
        top: ob.top,
        bottom: ob.bottom,
        color: ob.bias === BULL ? SMC_COLORS.bullOb : SMC_COLORS.bearOb,
        alpha: ob.swing ? 0.2 : 0.13,
        label: ob.swing ? "Swing OB" : "OB",
        border: true,
      });
    }
  }

  if (params.showFvg) {
    for (const gap of nearest(fvgs.filter((item) => !item.filled), 1)) {
      out.boxes.push({
        x1: gap.index,
        x2: null,
        top: gap.top,
        bottom: gap.bottom,
        color: gap.bias === BULL ? SMC_COLORS.bullFvg : SMC_COLORS.bearFvg,
        alpha: 0.12,
        label: "FVG",
      });
    }
  }

  if (params.showEqualHL) out.segments.push(...recent(eqSegments, 2));

  const hasRange = !Number.isNaN(trailTop) && !Number.isNaN(trailBottom) && trailTop > trailBottom;
  if (params.showZones && hasRange) {
    const x1 = Math.max(trailTopIndex, trailBottomIndex);
    const top = trailTop;
    const bottom = trailBottom;
    out.boxes.push(
      { x1, x2: null, top, bottom: 0.95 * top + 0.05 * bottom, color: SMC_COLORS.premium, alpha: 0.1, label: "Premium" },
      { x1, x2: null, top: 0.525 * top + 0.475 * bottom, bottom: 0.525 * bottom + 0.475 * top, color: SMC_COLORS.equilibrium, alpha: 0.12, label: "Equilibrium" },
      { x1, x2: null, top: 0.95 * bottom + 0.05 * top, bottom, color: SMC_COLORS.discount, alpha: 0.1, label: "Discount" },
    );
  }
  if (params.showStrongWeak && hasRange) {
    // A high is "strong" when the swing trend is down (sellers defended it); otherwise it's a weak, likely target.
    out.lines.push(
      { x1: trailTopIndex, x2: null, y: trailTop, color: SMC_COLORS.bear, dashed: false, label: swing.trend === BEAR ? "Strong High" : "Weak High", labelSide: "above" },
      { x1: trailBottomIndex, x2: null, y: trailBottom, color: SMC_COLORS.bull, dashed: false, label: swing.trend === BULL ? "Strong Low" : "Weak Low", labelSide: "below" },
    );
  }

  return out;
}
