import type { Bar } from "@/core/types";
import { detectPatternsWithAtr, nearestLevels } from "@/core/indicators/patterns";
import { EVENT_GAP_PCT, EVENT_VOL_X, computeFeatures, type DailyInput, type Features } from "./features";

// Fast path for replaying the screens over history (backtest scan, evidence,
// track record, issue #14). Those replays call computeFeatures once per stock
// per session on a sliding 260-bar window, and computeFeatures rebuilds every
// array and every indicator series from scratch each time.
//
// featureCursor(symbol, bars).at(i, from) returns exactly — bit for bit —
// computeFeatures(symbol, bars.slice(from, i + 1), false), but:
//
// - Everything that doesn't depend on where the window starts is computed once
//   per stock over its whole history: the OHLCV columns, Bar objects, true
//   range, directional movement, log returns, the prior 20/50-session volume
//   averages, the last session with delivery data and the 52-week high / low.
// - The moving averages, RSI, ATR and ADX do depend on the window start (an
//   EMA or Wilder average is seeded from the first bars it sees, and a running
//   SMA sum accumulates rounding from there), so to stay identical they are
//   still run over the window, but in one fused pass with no allocation,
//   keeping only the values the screens read (today, and yesterday / 5 / 22
//   sessions ago where a feature needs it) instead of whole output series.
//   The same pass fills the chart patterns' ATR series, which detectPatterns
//   would otherwise recompute.
// - Everything else reads the precomputed columns by index instead of copying
//   the window.
//
// The arithmetic is the same as computeFeatures and the indicator functions it
// calls (same operations in the same order), which is what makes the results
// identical. featureCursor.test.ts checks every field against computeFeatures
// on seeded data. If you change a feature in computeFeatures, change it here
// too — the test will fail until you do.

export interface FeatureCursor {
  /** Features of the session at `index`, computed on the bars from `from` (default 0) to `index` inclusive. */
  at(index: number, from?: number): Features;
  /** False when the stock has non-finite or absurd bars, so every call goes through computeFeatures itself. */
  readonly fast: boolean;
}

const EMA20 = 2 / (20 + 1);
const EMA25 = 2 / (25 + 1);
const EMA50 = 2 / (50 + 1);

/** RSI from its average gain and loss (indicators.ts rsiOf). */
const rsiOf = (gain: number, loss: number) => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));

/**
 * Bars the fast path handles: finite prices and volume, far from overflow. With
 * those, no intermediate value is NaN, so the indicator functions' NaN handling
 * never triggers and the fused loop below can leave it out. Anything else
 * (bad rows in the data) goes through computeFeatures itself.
 */
const sane = (value: number) => Number.isFinite(value) && Math.abs(value) < 1e100;

/** Mean of src[from..to) (features.ts `average`, same summation order). */
function mean(src: Float64Array, from: number, to: number, length: number) {
  let sum = 0;
  for (let j = from; j < to; j += 1) sum += src[j];
  return sum / length;
}

/** Highest value of src[from..to] inclusive (features.ts windowExtreme: Math.max from −Infinity). */
function highest(src: Float64Array, from: number, to: number) {
  let result = -Infinity;
  for (let j = from; j <= to; j += 1) result = Math.max(result, src[j]);
  return result;
}

function lowest(src: Float64Array, from: number, to: number) {
  let result = Infinity;
  for (let j = from; j <= to; j += 1) result = Math.min(result, src[j]);
  return result;
}

/** Extreme of src over the `width` bars ending at a bar (from bar width − 1 on), in O(1) per query. */
function blockExtremes(src: Float64Array, width: number, pick: (a: number, b: number) => number) {
  const total = src.length;
  const forward = new Float64Array(total);
  const backward = new Float64Array(total);
  for (let j = 0; j < total; j += 1) forward[j] = j % width === 0 ? src[j] : pick(forward[j - 1], src[j]);
  for (let j = total - 1; j >= 0; j -= 1) backward[j] = j % width === width - 1 || j === total - 1 ? src[j] : pick(backward[j + 1], src[j]);
  return (end: number) => pick(backward[end - width + 1], forward[end]);
}

export function featureCursor(symbol: string, input: DailyInput[]): FeatureCursor {
  const total = input.length;
  const O = new Float64Array(total);
  const H = new Float64Array(total);
  const L = new Float64Array(total);
  const C = new Float64Array(total);
  const V = new Float64Array(total);
  const bars: Bar[] = new Array(total);
  let fast = true;
  for (let j = 0; j < total; j += 1) {
    const bar = input[j];
    fast &&= sane(bar.o) && sane(bar.h) && sane(bar.l) && sane(bar.c) && sane(bar.v);
    O[j] = bar.o;
    H[j] = bar.h;
    L[j] = bar.l;
    C[j] = bar.c;
    V[j] = bar.v;
    bars[j] = { time: bar.t, open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v };
  }

  // Window-independent per-bar columns (each needs only the bar and the one before it).
  const TR = new Float64Array(total); // true range from the second bar of a window on (indicators.ts trueRange)
  const PDM = new Float64Array(total); // +DM / −DM (indicators.ts dmi)
  const MDM = new Float64Array(total);
  const LOGRET = new Float64Array(total); // log return (features.ts annualVolatility), valid where LOGOK
  const LOGOK = new Uint8Array(total);
  for (let j = 1; j < total; j += 1) {
    const prevClose = C[j - 1];
    TR[j] = Math.max(H[j] - L[j], Math.abs(H[j] - prevClose), Math.abs(L[j] - prevClose));
    const upMove = H[j] - H[j - 1];
    const downMove = L[j - 1] - L[j];
    PDM[j] = upMove > downMove && upMove > 0 ? upMove : 0;
    MDM[j] = downMove > upMove && downMove > 0 ? downMove : 0;
    if (C[j - 1] > 0 && C[j] > 0) {
      LOGOK[j] = 1;
      LOGRET[j] = Math.log(C[j] / C[j - 1]);
    }
  }
  // Average volume of the 20 / 50 sessions before bar j (NaN with fewer before it in the whole history;
  // callers check the window has them too).
  const AVG20 = new Float64Array(total).fill(NaN);
  const AVG50 = new Float64Array(total).fill(NaN);
  for (let j = 20; j < total; j += 1) AVG20[j] = mean(V, j - 20, j, 20);
  for (let j = 50; j < total; j += 1) AVG50[j] = mean(V, j - 50, j, 50);
  // Latest bar at or before j with delivery %, or −1.
  const LASTDP = new Int32Array(total);
  for (let j = 0; j < total; j += 1) LASTDP[j] = input[j].dp !== undefined ? j : j > 0 ? LASTDP[j - 1] : -1;
  // 52-week (252-bar) high / low ending at each bar, for windows that long (van Herk / Gil-Werman:
  // running extremes within 252-bar blocks, forwards and backwards). Math.max / Math.min give the
  // same value whatever the grouping, so this equals the plain scan in features.ts.
  const HIGH52 = blockExtremes(H, 252, Math.max);
  const LOW52 = blockExtremes(L, 252, Math.min);
  const PATTERN_ATR = new Float64Array(total);

  /** features.ts annualVolatility over the `days` sessions ending at e, for a window of n bars. */
  function annualVolatility(e: number, n: number, days: number) {
    if (n < days + 1) return NaN;
    let count = 0;
    let sum = 0;
    for (let j = e - days + 1; j <= e; j += 1) {
      if (!LOGOK[j]) continue;
      sum += LOGRET[j];
      count += 1;
    }
    if (count < days * 0.8) return NaN;
    const average = sum / count;
    let variance = 0;
    for (let j = e - days + 1; j <= e; j += 1) if (LOGOK[j]) variance += (LOGRET[j] - average) ** 2;
    return Math.sqrt((variance / (count - 1)) * 252) * 100;
  }

  /** features.ts volAdjustedMomentum. */
  function momentum(e: number, n: number) {
    const ratio = (days: number) => {
      if (n <= days) return NaN;
      const ret = (C[e] / C[e - days] - 1) * 100;
      const vol = annualVolatility(e, n, days);
      return Number.isFinite(ret) && vol > 0 ? ret / vol : NaN;
    };
    const six = ratio(126);
    const twelve = ratio(252);
    if (!Number.isFinite(six)) return NaN;
    return Number.isFinite(twelve) ? (six + twelve) / 2 : six;
  }

  function at(e: number, s = 0): Features {
    if (!fast) return computeFeatures(symbol, input.slice(s, e + 1), false);
    const n = e - s + 1;
    const today = input[e];
    const yesterday = n >= 2 ? input[e - 1] : undefined;

    // ---- One pass over the window for everything seeded at its first bar.
    //
    // Each block below is the same state machine as the indicators.ts function
    // named in its comment, specialised to finite input (no NaN skipping or
    // resets — such stocks take the fallback path) and keeping only the values
    // the features read. Same operations, same order: an SMA is a running sum
    // divided by its length; an EMA / Wilder average is seeded with the sum of
    // its first `length` values divided by `length`, then updated recursively.
    // Local index k = j − s counts bars from the window start; the RSI and DMI
    // series start on the window's second bar (k = 1), the rest on its first.
    let sum5 = 0;
    let sum20 = 0;
    let sum50 = 0;
    let sum150 = 0;
    let sum200 = 0;
    let ema20 = 0;
    let ema25 = 0;
    let ema50 = 0;
    let gain14 = 0;
    let loss14 = 0;
    let gain2 = 0;
    let loss2 = 0;
    let atr14 = 0;
    let atr20 = 0;
    let atr22 = 0;
    let dmTr = 0;
    let dmPlus = 0;
    let dmMinus = 0;
    let adx = 0;
    let plusDI = NaN;
    let minusDI = NaN;
    let sma20Prev = NaN;
    let sma200Prev22 = NaN;
    let ema50Prev5 = NaN;
    let rsi14Prev = NaN;
    // The chart patterns' own ATR(14) series over the window, for detectPatterns (reused buffer).
    const patternAtr = PATTERN_ATR;
    let patternAtrPrev = 0;
    // Warm-up: the first 50 bars, where averages are still being seeded.
    const warm = Math.min(e, s + 49);
    for (let j = s; j <= warm; j += 1) {
      const k = j - s;
      const c = C[j];

      // sma: running sums (divided only where a value is read).
      sum5 += c;
      if (k >= 5) sum5 -= C[j - 5];
      sum20 += c;
      if (k >= 20) sum20 -= C[j - 20];
      sum50 += c;
      if (k >= 50) sum50 -= C[j - 50];
      sum150 += c;
      if (k >= 150) sum150 -= C[j - 150];
      sum200 += c;
      if (k >= 200) sum200 -= C[j - 200];

      // ema: alpha · value + (1 − alpha) · prev after an SMA seed.
      if (k < 20) {
        ema20 += c;
        if (k === 19) ema20 /= 20;
      } else ema20 = EMA20 * c + (1 - EMA20) * ema20;
      if (k < 25) {
        ema25 += c;
        if (k === 24) ema25 /= 25;
      } else ema25 = EMA25 * c + (1 - EMA25) * ema25;
      if (k < 50) {
        ema50 += c;
        if (k === 49) ema50 /= 50;
      } else ema50 = EMA50 * c + (1 - EMA50) * ema50;

      // atr: rma of the true range, the window's first bar using its own high − low.
      const tr = k === 0 ? H[j] - L[j] : TR[j];
      if (k < 14) {
        atr14 += tr;
        if (k === 13) atr14 /= 14;
      } else atr14 = (atr14 * 13 + tr) / 14;
      if (k < 20) {
        atr20 += tr;
        if (k === 19) atr20 /= 20;
      } else atr20 = (atr20 * 19 + tr) / 20;
      if (k < 22) {
        atr22 += tr;
        if (k === 21) atr22 /= 22;
      } else atr22 = (atr22 * 21 + tr) / 22;

      // patterns.ts atrSeries: from the second bar, the first 13 true ranges summed and divided
      // by 14, then Wilder updates; a value from the 15th bar (k = 14) on.
      if (k === 0) patternAtr[0] = NaN;
      else if (k < 14) {
        patternAtrPrev = k === 1 ? tr : patternAtrPrev + tr;
        if (k === 13) patternAtrPrev /= 14;
        patternAtr[k] = NaN;
      } else {
        patternAtrPrev = (patternAtrPrev * 13 + tr) / 14;
        patternAtr[k] = patternAtrPrev;
      }

      if (k >= 1) {
        const m = k - 1;
        // rsiOf: rma of gains and losses.
        const change = c - C[j - 1];
        const gain = Math.max(change, 0);
        const loss = Math.max(-change, 0);
        if (m < 14) {
          gain14 += gain;
          loss14 += loss;
          if (m === 13) {
            gain14 /= 14;
            loss14 /= 14;
          }
        } else {
          gain14 = (gain14 * 13 + gain) / 14;
          loss14 = (loss14 * 13 + loss) / 14;
        }
        if (m < 2) {
          gain2 += gain;
          loss2 += loss;
          if (m === 1) {
            gain2 /= 2;
            loss2 /= 2;
          }
        } else {
          gain2 = (gain2 * 1 + gain) / 2;
          loss2 = (loss2 * 1 + loss) / 2;
        }

        // dmi: rma of true range and ±DM, then DI, DX and the rma of DX (ADX).
        if (m < 14) {
          dmTr += TR[j];
          dmPlus += PDM[j];
          dmMinus += MDM[j];
          if (m === 13) {
            dmTr /= 14;
            dmPlus /= 14;
            dmMinus /= 14;
          }
        } else {
          dmTr = (dmTr * 13 + TR[j]) / 14;
          dmPlus = (dmPlus * 13 + PDM[j]) / 14;
          dmMinus = (dmMinus * 13 + MDM[j]) / 14;
        }
        if (m >= 13) {
          plusDI = dmTr === 0 ? 0 : (100 * dmPlus) / dmTr;
          minusDI = dmTr === 0 ? 0 : (100 * dmMinus) / dmTr;
          const sum = plusDI + minusDI;
          const dx = (100 * Math.abs(plusDI - minusDI)) / (sum === 0 ? 1 : sum);
          const q = m - 13;
          if (q < 14) {
            adx += dx;
            if (q === 13) adx /= 14;
          } else adx = (adx * 13 + dx) / 14;
        }
      }

      if (j === e - 1) {
        if (k >= 19) sma20Prev = sum20 / 20;
        if (k >= 14) rsi14Prev = rsiOf(gain14, loss14);
      }
      if (j === e - 5 && k >= 49) ema50Prev5 = ema50;
      if (j === e - 22 && k >= 199) sma200Prev22 = sum200 / 200;
    }
    // The rest of the window (k ≥ 50): every average past its seed, so the same
    // updates as above without the warm-up branches. This is most of the work.
    for (let j = warm + 1; j <= e; j += 1) {
      const k = j - s;
      const c = C[j];
      sum5 += c;
      sum5 -= C[j - 5];
      sum20 += c;
      sum20 -= C[j - 20];
      sum50 += c;
      sum50 -= C[j - 50];
      sum150 += c;
      if (k >= 150) sum150 -= C[j - 150];
      sum200 += c;
      if (k >= 200) sum200 -= C[j - 200];
      ema20 = EMA20 * c + (1 - EMA20) * ema20;
      ema25 = EMA25 * c + (1 - EMA25) * ema25;
      ema50 = EMA50 * c + (1 - EMA50) * ema50;
      const tr = TR[j];
      atr14 = (atr14 * 13 + tr) / 14;
      atr20 = (atr20 * 19 + tr) / 20;
      atr22 = (atr22 * 21 + tr) / 22;
      patternAtrPrev = (patternAtrPrev * 13 + tr) / 14;
      patternAtr[k] = patternAtrPrev;
      const change = c - C[j - 1];
      const gain = Math.max(change, 0);
      const loss = Math.max(-change, 0);
      gain14 = (gain14 * 13 + gain) / 14;
      loss14 = (loss14 * 13 + loss) / 14;
      gain2 = (gain2 * 1 + gain) / 2;
      loss2 = (loss2 * 1 + loss) / 2;
      dmTr = (dmTr * 13 + tr) / 14;
      dmPlus = (dmPlus * 13 + PDM[j]) / 14;
      dmMinus = (dmMinus * 13 + MDM[j]) / 14;
      plusDI = dmTr === 0 ? 0 : (100 * dmPlus) / dmTr;
      minusDI = dmTr === 0 ? 0 : (100 * dmMinus) / dmTr;
      const sum = plusDI + minusDI;
      adx = (adx * 13 + (100 * Math.abs(plusDI - minusDI)) / (sum === 0 ? 1 : sum)) / 14;

      if (j === e - 1) {
        sma20Prev = sum20 / 20;
        rsi14Prev = rsiOf(gain14, loss14);
      }
      if (j === e - 5) ema50Prev5 = ema50;
      if (j === e - 22 && k >= 199) sma200Prev22 = sum200 / 200;
    }
    // Values on the last bar: NaN until the series has `length` values (k = n − 1 on the last bar).
    const last = n - 1;
    const sma5Now = last >= 4 ? sum5 / 5 : NaN;
    const sma20Now = last >= 19 ? sum20 / 20 : NaN;
    const sma50Now = last >= 49 ? sum50 / 50 : NaN;
    const sma150Now = last >= 149 ? sum150 / 150 : NaN;
    const sma200Now = last >= 199 ? sum200 / 200 : NaN;
    const ema20Now = last >= 19 ? ema20 : NaN;
    const ema25Now = last >= 24 ? ema25 : NaN;
    const ema50Now = last >= 49 ? ema50 : NaN;
    const rsi14Now = last >= 14 ? rsiOf(gain14, loss14) : NaN;
    const rsi2Now = last >= 2 ? rsiOf(gain2, loss2) : NaN;
    const atr14Now = last >= 13 ? atr14 : NaN;
    const atr20Now = last >= 19 ? atr20 : NaN;
    const atr22Now = last >= 21 ? atr22 : NaN;
    const adxNow = last >= 27 ? adx : NaN;
    const plusDINow = last >= 14 ? plusDI : NaN;
    const minusDINow = last >= 14 ? minusDI : NaN;

    // ---- Volume baselines ("today" excluded from its own baseline).
    const avgVol20 = n - 1 - 20 < 0 ? NaN : AVG20[e];
    const avgVol50 = n - 1 - 50 < 0 ? NaN : AVG50[e];
    let turnoverCr20 = NaN;
    if (n > 21) {
      let turnover = 0;
      for (let j = e - 20; j < e; j += 1) turnover += C[j] * V[j];
      turnoverCr20 = turnover / 20 / 1e7;
    }

    const range = today.h - today.l;
    let nr7 = n >= 7;
    for (let j = e - 6; nr7 && j < e; j += 1) nr7 = range < H[j] - L[j];

    const flagPolePct = n >= 16 ? (C[e - 5] / C[e - 15] - 1) * 100 : NaN;
    const flagRangePct = n >= 5 ? (Math.max(C[e - 4], C[e - 3], C[e - 2], C[e - 1], C[e]) / Math.min(C[e - 4], C[e - 3], C[e - 2], C[e - 1], C[e]) - 1) * 100 : NaN;

    // Event days in the 10 sessions before today (window-relative bounds as in computeFeatures).
    let eventIndex = -1;
    for (let k = n - 2; k >= Math.max(51, n - 11); k -= 1) {
      const j = s + k;
      const gap = (O[j] / C[j - 1] - 1) * 100;
      const baseline = AVG50[j];
      if (Math.abs(gap) >= EVENT_GAP_PCT && baseline > 0 && V[j] >= EVENT_VOL_X * baseline) {
        eventIndex = j;
        break;
      }
    }
    let lowSinceEvent = NaN;
    if (eventIndex >= 0) lowSinceEvent = lowest(L, eventIndex, e);

    const patterns = detectPatternsWithAtr(bars.slice(s, e + 1), () => patternAtr.subarray(0, n));
    const best = patterns.best;
    const bearish = patterns.patterns.find((pattern) => pattern.direction === "bear" && pattern.status === "forming");
    const levels = nearestLevels(patterns.levels, today.c);

    let upVol = 0;
    let downVol = 0;
    for (let j = s + Math.max(1, n - 20); j <= e; j += 1) {
      if (C[j] > C[j - 1]) upVol += V[j];
      else if (C[j] < C[j - 1]) downVol += V[j];
    }

    const pctChange = (lookback: number) => (n > lookback ? (C[e] / C[e - lookback] - 1) * 100 : NaN);

    // Delivery: the latest session with delivery % in the window, and up to 20 before it.
    const deliveryIndex = LASTDP[e] >= s ? LASTDP[e] : -1;
    let deliverySum = 0;
    let deliveryCount = 0;
    if (deliveryIndex > s) {
      for (let j = LASTDP[deliveryIndex - 1]; j >= s && deliveryCount < 20; j = j > 0 ? LASTDP[j - 1] : -1) {
        deliverySum += input[j].dp as number;
        deliveryCount += 1;
      }
    }

    const high52 = n >= 252 ? HIGH52(e) : highest(H, s, e);
    const low52 = n >= 252 ? LOW52(e) : lowest(L, s, e);
    const eventAt = eventIndex >= 0 ? input[eventIndex] : undefined;

    return {
      symbol,
      barCount: n,
      date: today.t,
      live: false,
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
      sma5: sma5Now,
      sma20: sma20Now,
      sma20Prev,
      ema20: ema20Now,
      ema25: ema25Now,
      ema50: ema50Now,
      ema50Prev5,
      sma50: sma50Now,
      sma150: sma150Now,
      sma200: sma200Now,
      sma200Prev22,
      rsi14: rsi14Now,
      rsi14Prev,
      rsi2: rsi2Now,
      atr14: atr14Now,
      atr20: atr20Now,
      adx14: adxNow,
      plusDI: plusDINow,
      minusDI: minusDINow,
      high20Prev: n - 1 - 20 < 0 ? NaN : highest(H, e - 20, e - 1),
      low10Prev: n - 1 - 10 < 0 ? NaN : lowest(L, e - 10, e - 1),
      high52,
      low52,
      minLow3: n < 3 ? NaN : lowest(L, e - 2, e),
      minLow5: n < 5 ? NaN : lowest(L, e - 4, e),
      baseHigh: n - 1 - 30 < 0 ? NaN : highest(H, e - 30, e - 1),
      baseLow: n - 1 - 30 < 0 ? NaN : lowest(L, e - 30, e - 1),
      nr7,
      insideDay: Boolean(yesterday && today.h <= yesterday.h && today.l >= yesterday.l),
      flagPolePct,
      flagRangePct,
      maxHigh5: n < 5 ? NaN : highest(H, e - 4, e),
      gapPct: yesterday ? (today.o / yesterday.c - 1) * 100 : NaN,
      eventAgo: eventAt ? e - eventIndex : NaN,
      eventGapPct: eventAt ? (eventAt.o / input[eventIndex - 1].c - 1) * 100 : NaN,
      eventLow: eventAt ? eventAt.l : NaN,
      eventHigh: eventAt ? eventAt.h : NaN,
      eventClose: eventAt ? eventAt.c : NaN,
      lowSinceEvent,
      ret5: pctChange(5),
      ret21: pctChange(21),
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
      chandelier: highest(H, e + 1 - Math.min(22, n), e) - 3 * atr22Now,
      upDownVol20: downVol > 0 ? upVol / downVol : upVol > 0 ? 3 : NaN,
      ext20Atr: (today.c - ema20Now) / atr14Now,
      ret63: pctChange(63),
      ret126: pctChange(126),
      ret189: pctChange(189),
      ret252: pctChange(Math.min(252, n - 1)),
      rsScore: momentum(e, n),
      rsRank: NaN,
      deliveryPct: deliveryIndex >= 0 ? (input[deliveryIndex].dp as number) : NaN,
      deliveryAvg20: deliveryCount >= 10 ? deliverySum / deliveryCount : NaN,
      deliveryDate: deliveryIndex >= 0 ? input[deliveryIndex].t : NaN,
    };
  }

  return { at, fast };
}
