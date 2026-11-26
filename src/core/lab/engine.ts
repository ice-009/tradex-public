import { roundTripCosts, slipped, type CostModel } from "@/core/backtest/costs";
import { MIN_T, MIN_TRADES, SPLIT_FRACTION, splitDay, stateOn, type MarketState } from "@/core/plan/evidence";
import { variantKeyOf } from "./trials";
import { tradeQty } from "@/core/screener/liveRecord";
import type { DailyBar } from "@/core/types";
import { quantileBuckets } from "./quantiles";
import { everyNth, mean, neweyWestSE, neweyWestT, seriesStats, spearman, type SeriesStats } from "./stats";

// The Signal Lab (issue #22): a test bench for any signal — one number per
// stock per day. Pure: the service (src/server/services/lab.ts) and the CLI
// (scripts/lab.ts) load the bars, the point-in-time F&O list and the signal's
// values, and this turns them into one report.
//
// Each formation day (a session's close, as the screens are run):
//  1. The universe is the stocks that were members THAT day (the real F&O list,
//     former members included: `membership`), traded that day, and have a value.
//     Days with fewer than `minStocks` such stocks are skipped.
//  2. They are ranked into `quantiles` buckets by value (quantiles.ts): Q1 the
//     lowest values, Q5 the highest. Ties share a bucket.
//  3. Each stock's forward return over k sessions is close(t + k) / close(t) − 1
//     on its own bars — or, with `forward: "close-open"`, open(t + k) / close(t)
//     − 1: bought at the close, sold at the open k sessions later (k = 1 is the
//     BTST trade, the overnight return). A stock whose bars stop before the data does (delisted,
//     suspended, merged) is closed at its last close — so delisted stocks count
//     with what they really did, not dropped. With too little future left in the
//     data, the observation is left out of that horizon. So is a window holding
//     a session that moved more than ±50% close to close (`maxDailyMove`): a
//     split or bonus the price adjustment missed, not a return — one such
//     outlier would otherwise dominate its bucket. The report counts them.
//  4. Each position pays a futures round trip (costs.ts: slippage on both legs
//     plus charges, at the stock's price, for a ~₹5 lakh position). Net of
//     costs, a long position earns r − c and a short one −r − c.
//
// The long–short spread on a day is the top occupied bucket's mean return minus
// the bottom one's (Q5 − Q1; for a binary signal, matched minus the rest), and
// the net spread pays two round trips. Because a new h-session window starts
// every day, consecutive spreads overlap by h − 1 sessions: t-stats are
// Newey–West with lag h − 1 (stats.ts). The deflated-Sharpe inputs come from a
// non-overlapping sample (every h-th day).
//
// `reverse` ranks by minus the signal (its lowest values in the top bucket):
// for a signal whose expected sign is negative (MAX, volatility), the long leg
// is then Q5 and the net spread is what trading that side would have earned.
//
// Splits: by market regime on the formation day (NIFTY above/below its 200-day
// average, `regimeStates`, as the plan's evidence) and the evidence's
// first-60% / last-40% check (splitDay over the ranked days). Decay: the spread
// at every horizon from 1 to `decayTo` sessions, and the spread of the k-th
// day's return alone (how fast the edge fades). Turnover: the share of a
// bucket's stocks that weren't in it k sessions earlier — every horizon's
// rebalance and the daily one.

export const LAB_ENGINE = "lab/1";
export const DEFAULT_HORIZONS = [1, 5, 10, 21] as const;
export const DEFAULT_QUANTILES = 5;
export const DEFAULT_DECAY = 21;
export const MAX_HORIZON = 63;
/** Fewest ranked stocks a day needs to count. */
export const DEFAULT_MIN_STOCKS = 20;
/**
 * Largest close-to-close move in one session that is taken as real. NSE's widest
 * price band is 20% and F&O stocks have dynamic bands that widen in 5% steps
 * after a cooling-off; a ±50% session in adjusted daily bars is a data error
 * (a missed split or bonus, a bad print) far more often than a real move.
 */
export const MAX_DAILY_MOVE = 0.5;
/**
 * Sessions a stock's bars may end before the data's last session and still
 * count as trading (its newest bars not in yet). Ending earlier, it stopped
 * trading — delisted, merged, suspended — and is closed at its last close.
 */
export const STOPPED_AFTER = 5;
/** Sessions a year, for annualising Sharpe ratios. */
const SESSIONS_PER_YEAR = 252;

/** What a forward return is measured to: the close k sessions later (default), or the open k sessions later (BTST exit). */
export type ForwardReturn = "close-close" | "close-open";
export const FORWARD_RETURNS: readonly ForwardReturn[] = ["close-close", "close-open"];

/** A signal's value for a stock at a session's close; null = no value (not enough history, not applicable). */
export type SignalValues = (day: number, symbol: string) => number | null;

export interface LabSignalMeta {
  id: string;
  name: string;
  kind: "numeric" | "binary";
  params: Record<string, number>;
  /** Ranked by minus the value: the lowest values in the top bucket (default false). */
  reversed?: boolean;
  /** Forward return measured close → close (default) or close → open k sessions later. */
  forward?: ForwardReturn;
}

export interface LabInput {
  signal: LabSignalMeta;
  /** Trading calendar, oldest first (every stock's sessions). */
  dates: readonly number[];
  symbols: readonly string[];
  bars: ReadonlyMap<string, readonly DailyBar[]>;
  values: SignalValues;
  /** Whether a stock was in the universe on a day (point-in-time F&O list). Default: always. */
  membership?: (symbol: string, day: number) => boolean;
  costs: CostModel;
  /** Forward horizons in sessions (default 1, 5, 10, 21). */
  horizons?: readonly number[];
  /**
   * "close-close" (default): close(t + k) / close(t) − 1. "close-open":
   * open(t + k) / close(t) − 1, the BTST exit at the next open (k = 1).
   * Set on `signal.forward`; this wins when both are given.
   */
  forward?: ForwardReturn;
  /** Decay is measured for every horizon 1 … decayTo (default 21). */
  decayTo?: number;
  /** NIFTY vs its 200-day average per session (evidence.ts marketStates). */
  regimeStates?: ReadonlyMap<number, MarketState> | null;
  /** Formation days considered (day keys, inclusive); null = all. */
  from?: number | null;
  to?: number | null;
  quantiles?: number;
  minStocks?: number;
  /** Share of the ranked days in the first part of the stability check (default 0.6). */
  splitFraction?: number;
  /**
   * Largest believable close-to-close move in one session (default 0.5 = ±50%).
   * A forward window containing a bigger one is a data error — a split or bonus
   * the price adjustment missed, a bad print — and is left out.
   */
  maxDailyMove?: number;
}

/** Gross (before costs) and net (after a round trip on each leg) of one series. */
export interface SpreadPair {
  gross: SeriesStats;
  net: SeriesStats;
}

export interface QuantileRow {
  /** 1 = lowest values … q = highest. */
  bucket: number;
  /** Average stocks in the bucket on a ranked day. */
  stocks: number;
  /** Mean forward return of the bucket (equal weight, each day once), its Newey–West t, and net of a long round trip. */
  gross: number | null;
  t: number | null;
  net: number | null;
}

export interface Turnover {
  /** Share of each bucket's stocks that weren't in it `lag` sessions earlier, averaged over days. */
  buckets: Array<number | null>;
  /** The long side (top occupied bucket) and the short side (bottom occupied bucket). */
  long: number | null;
  short: number | null;
}

export interface HorizonReport {
  horizon: number;
  /** Newey–West lag used for this horizon's t-stats (h − 1). */
  lag: number;
  quantiles: QuantileRow[];
  /** Long–short (Q5 − Q1) spread, every ranked day. */
  spread: SpreadPair;
  /** Net spread annualised: the non-overlapping Sharpe × √(252 / h). */
  sharpeAnnual: number | null;
  /**
   * Mean spread if each leg is held between rebalances every h sessions and
   * costs are paid only on the stocks replaced (turnover at lag h). Null for
   * close → open forward returns: those positions are closed at every open, so
   * each rebalance pays a full round trip (the net spread).
   */
  netAtTurnover: number | null;
  /** Average round-trip cost of the long and the short leg (fraction of price). */
  cost: { long: number | null; short: number | null };
  /** Rank correlation of value and forward return per day (information coefficient): mean and Newey–West t. */
  ic: { mean: number | null; t: number | null; days: number };
  /** Spread on days NIFTY was above (up) or below (down) its 200-day average. */
  regimes: { up: SpreadPair; down: SpreadPair; unknown: number };
  /** First 60% / last 40% of the ranked days, split at `splitDate`. */
  split: { splitDate: number | null; first: SpreadPair; last: SpreadPair };
  turnover: Turnover;
  /**
   * Inputs of the deflated Sharpe ratio (#24), from the net spread on every h-th
   * day (non-overlapping): Sharpe per h-session period, its length, skewness and
   * kurtosis (not excess).
   */
  dsr: { sharpe: number | null; n: number; skewness: number | null; kurtosis: number | null; step: number };
  /**
   * That same non-overlapping sample as a series: each formation day (every h-th
   * ranked day with both legs priced) and its net h-session spread, oldest first.
   * Summed, it is the report card's equity curve (#23).
   */
  series: { days: number[]; net: number[] };
  /** Net spread > 0 in both parts of the 60/40 split, Newey–West t > 2 and at least 30 days: the evidence's PASS rule. */
  passes: boolean;
}

export interface DecayPoint {
  horizon: number;
  /** Cumulative spread over `horizon` sessions: gross, net, Newey–West t (gross, lag h − 1). */
  gross: number | null;
  net: number | null;
  t: number | null;
  /** Newey–West standard error (lag h − 1) of the mean net spread: the report card's ±2 se band. */
  netSe: number | null;
  /** Spread of the horizon-th session's return alone (close h − 1 → close h), and its t (lag 0). */
  marginal: number | null;
  marginalT: number | null;
}

export interface LabReport {
  engine: typeof LAB_ENGINE;
  signal: LabSignalMeta & {
    /**
     * Signal id + canonical parameters: one "trial" for the multiple-testing
     * registry (#24, src/core/lab/trials.ts) — the same variant always has the same key.
     */
    variantKey: string;
  };
  quantiles: number;
  horizons: number[];
  /** Ranked formation days (first, last, count) and the calendar sessions in the period. */
  period: { from: number | null; to: number | null; days: number; sessions: number; skippedDays: number };
  universe: { symbols: number; perDay: { min: number; mean: number; max: number } };
  observations: number;
  /** Observations closed at a stock's last close because its bars end before the data's (delisted, suspended). */
  truncated: number;
  /**
   * Data errors: sessions in the period moving more than `maxDailyMove` close to
   * close (`bars`, worst `symbols` first), and the observations left out because
   * one fell inside their forward window.
   */
  dataErrors: { maxDailyMove: number; bars: number; observations: number; symbols: Array<{ symbol: string; bars: number }> };
  /** Mean round-trip cost per position, fraction of price. */
  costPerTrade: number | null;
  /** Buckets occupied on an average day: below `quantiles` for a binary or coarse signal. */
  occupiedBuckets: number;
  byHorizon: HorizonReport[];
  decay: DecayPoint[];
  /** Turnover from one session to the next. */
  dailyTurnover: Turnover;
  notes: string[];
}

/**
 * A run's parameters as the trial record keys them: the signal's own, plus
 * `reverse: 1` and `forward: "close-open"` when set (left out at their
 * defaults, so a plain run keeps its key).
 */
export const variantParams = (params: Record<string, number>, options: { reversed?: boolean; forward?: ForwardReturn } = {}): Record<string, number | string> => ({
  ...params,
  ...(options.reversed ? { reverse: 1 } : {}),
  ...(options.forward === "close-open" ? { forward: "close-open" } : {}),
});

/** One trial's identity: the signal's id and its parameters in canonical form (the trial record's key, trials.ts). */
export const variantKey = (id: string, params: Record<string, number>, options: { reversed?: boolean; forward?: ForwardReturn } = {}) =>
  variantKeyOf(id, variantParams(params, options));

/** Round-trip cost of a position at `price` (slippage both legs + charges), as a fraction of the price. */
export function roundTripFraction(price: number, costs: CostModel, qty = tradeQty(price, null)): number {
  if (!(price > 0)) return 0;
  const entry = slipped("buy", price, costs);
  const exit = slipped("sell", price, costs);
  return (entry - exit) / price + roundTripCosts(entry, exit, qty, costs).total / (price * qty);
}

export class LabInputError extends Error {}

interface Prepared {
  closes: Float64Array;
  /** Opens (close-open forward returns only). */
  opens: Float64Array | null;
  /** Sessions up to each bar whose open gapped beyond `maxDailyMove` from the previous close, or has no open (close-open only). */
  badOpenPrefix: Int32Array | null;
  index: Map<number, number>;
  /** Sessions up to each bar whose close-to-close move is beyond `maxDailyMove` (data errors). */
  badPrefix: Int32Array;
  /** Last bar before the data ends: the stock stopped trading (closed at its last close). */
  stopped: boolean;
}

const emptyStats = (): SeriesStats => seriesStats([], 0);

/** Run the Lab. Throws LabInputError when nothing can be ranked. */
export function runLab(input: LabInput): LabReport {
  const q = Math.max(2, Math.min(10, Math.round(input.quantiles ?? DEFAULT_QUANTILES)));
  const horizons = [...new Set((input.horizons ?? DEFAULT_HORIZONS).map((h) => Math.round(h)).filter((h) => h >= 1 && h <= MAX_HORIZON))].sort((a, b) => a - b);
  if (!horizons.length) throw new LabInputError("Pick at least one horizon between 1 and 63 sessions.");
  const decayTo = Math.max(1, Math.min(MAX_HORIZON, Math.round(input.decayTo ?? DEFAULT_DECAY)));
  const K = Math.max(horizons.at(-1)!, decayTo);
  const minStocks = Math.max(q, Math.round(input.minStocks ?? DEFAULT_MIN_STOCKS));
  const { costs } = input;
  const forward: ForwardReturn = input.forward ?? input.signal.forward ?? "close-close";
  const toOpen = forward === "close-open";
  const reversed = Boolean(input.signal.reversed);
  const values: SignalValues = reversed
    ? (day, symbol) => {
        const value = input.values(day, symbol);
        return value === null ? null : -value;
      }
    : input.values;
  const from = input.from ?? -Infinity;
  const to = input.to ?? Infinity;
  // A series ending more than STOPPED_AFTER sessions before the data does has stopped trading;
  // one missing only the newest session or two is merely not updated yet (no future: left out).
  const stoppedBefore = input.dates[Math.max(0, input.dates.length - 1 - STOPPED_AFTER)] ?? 0;

  const maxMove = input.maxDailyMove ?? MAX_DAILY_MOVE;
  const symbols = [...input.symbols];
  const S = symbols.length;
  const badBars = new Map<string, number>();
  const prepared: Array<Prepared | null> = symbols.map((symbol) => {
    const bars = input.bars.get(symbol);
    if (!bars?.length) return null;
    const closes = new Float64Array(bars.length);
    const badPrefix = new Int32Array(bars.length);
    const opens = toOpen ? new Float64Array(bars.length) : null;
    const badOpenPrefix = toOpen ? new Int32Array(bars.length) : null;
    const index = new Map<number, number>();
    for (let i = 0; i < bars.length; i += 1) {
      closes[i] = bars[i].c;
      index.set(bars[i].t, i);
      const move = i > 0 ? closes[i] / closes[i - 1] - 1 : 0;
      const bad = i > 0 && (!(closes[i] > 0) || !(closes[i - 1] > 0) || Math.abs(move) > maxMove);
      badPrefix[i] = (i > 0 ? badPrefix[i - 1] : 0) + (bad ? 1 : 0);
      let badOpen = false;
      if (opens && badOpenPrefix) {
        // The open must be priced and adjusted like the closes: a gap beyond maxDailyMove
        // from the previous close is a data error (an unadjusted open, a bad print).
        opens[i] = bars[i].o;
        badOpen = !(opens[i] > 0) || (i > 0 && (!(closes[i - 1] > 0) || Math.abs(opens[i] / closes[i - 1] - 1) > maxMove));
        badOpenPrefix[i] = (i > 0 ? badOpenPrefix[i - 1] : 0) + (badOpen ? 1 : 0);
      }
      if ((bad || badOpen) && bars[i].t >= from && bars[i].t <= to) badBars.set(symbol, (badBars.get(symbol) ?? 0) + 1);
    }
    return { closes, opens, badOpenPrefix, index, badPrefix, stopped: bars[bars.length - 1].t < stoppedBefore };
  });

  // Formation days, and per day: bucket (−1 = not ranked) and side (1 long, 2 short) of each stock.
  const days = input.dates.filter((day) => day >= from && day <= to);
  const D = days.length;
  const bucketOf = new Int8Array(D * S).fill(-1);
  const sideOf = new Uint8Array(D * S);
  const ranked: number[] = []; // positions in `days`

  // Spread series per k (1 … K): one entry per ranked day with both legs priced.
  const spreadGross: number[][] = Array.from({ length: K + 1 }, () => []);
  const spreadNet: number[][] = Array.from({ length: K + 1 }, () => []);
  const spreadDay: number[][] = Array.from({ length: K + 1 }, () => []);
  const marginal: number[][] = Array.from({ length: K + 1 }, () => []);
  const legCost: Array<{ long: number[]; short: number[] }> = Array.from({ length: K + 1 }, () => ({ long: [], short: [] }));
  // Per main horizon: each bucket's daily mean gross and net return, and the daily IC.
  const bucketGross = horizons.map(() => Array.from({ length: q }, () => [] as number[]));
  const bucketNet = horizons.map(() => Array.from({ length: q }, () => [] as number[]));
  const icSeries = horizons.map(() => [] as number[]);
  const bucketCounts = new Float64Array(q);

  let observations = 0;
  let truncated = 0;
  let dataErrors = 0;
  let costSum = 0;
  let skippedDays = 0;
  let occupiedSum = 0;
  const seen = new Set<number>();
  let minPerDay = Infinity;
  let maxPerDay = 0;

  // Scratch, reused across days.
  const idx = new Int32Array(S);
  const bar = new Int32Array(S);
  const vals = new Float64Array(S);
  const cost = new Float64Array(S);
  const sumR = new Float64Array(q);
  const sumC = new Float64Array(q);
  const cnt = new Int32Array(q);
  const sumM = new Float64Array(q);
  const cntM = new Int32Array(q);

  for (let d = 0; d < D; d += 1) {
    const day = days[d];
    let n = 0;
    for (let s = 0; s < S; s += 1) {
      const series = prepared[s];
      if (!series) continue;
      const i = series.index.get(day);
      if (i === undefined || !(series.closes[i] > 0)) continue;
      if (input.membership && !input.membership(symbols[s], day)) continue;
      const value = values(day, symbols[s]);
      if (value === null || !Number.isFinite(value)) continue;
      idx[n] = s;
      bar[n] = i;
      vals[n] = value;
      n += 1;
    }
    if (n < minStocks) {
      if (n > 0) skippedDays += 1;
      continue;
    }
    const buckets = quantileBuckets(vals.subarray(0, n), q);
    let top = -1;
    let bottom = q;
    for (let j = 0; j < n; j += 1) {
      top = Math.max(top, buckets[j]);
      bottom = Math.min(bottom, buckets[j]);
    }
    const occupied = new Set(buckets).size;
    if (top === bottom) {
      // Everyone tied (e.g. no stock matched a screen): nothing to compare.
      skippedDays += 1;
      continue;
    }
    ranked.push(d);
    occupiedSum += occupied;
    minPerDay = Math.min(minPerDay, n);
    maxPerDay = Math.max(maxPerDay, n);
    for (let j = 0; j < n; j += 1) {
      const s = idx[j];
      seen.add(s);
      bucketOf[d * S + s] = buckets[j];
      sideOf[d * S + s] = buckets[j] === top ? 1 : buckets[j] === bottom ? 2 : 0;
      bucketCounts[buckets[j]] += 1;
      const price = prepared[s]!.closes[bar[j]];
      cost[j] = roundTripFraction(price, costs);
      costSum += cost[j];
    }
    observations += n;

    let anyTruncated = false;
    const hasTruncated = new Uint8Array(n);
    const hasDataError = new Uint8Array(n);
    for (let k = 1; k <= K; k += 1) {
      sumR.fill(0);
      sumC.fill(0);
      cnt.fill(0);
      sumM.fill(0);
      cntM.fill(0);
      const h = horizons.indexOf(k);
      const icValues: number[] = [];
      const icReturns: number[] = [];
      for (let j = 0; j < n; j += 1) {
        const series = prepared[idx[j]]!;
        const i = bar[j];
        const last = series.closes.length - 1;
        const c0 = series.closes[i];
        // A session moving more than maxDailyMove inside the window is a data error
        // (a missed split or bonus, a bad print): the observation is left out, not clipped.
        // Close → open k: the closes up to t + k − 1 and the opens up to t + k.
        const opens = series.opens;
        const badOpen = series.badOpenPrefix;
        if (
          opens && badOpen
            ? series.badPrefix[Math.min(i + k - 1, last)] !== series.badPrefix[i] || badOpen[Math.min(i + k, last)] !== badOpen[i]
            : series.badPrefix[Math.min(i + k, last)] !== series.badPrefix[i]
        ) {
          hasDataError[j] = 1;
          continue;
        }
        let r: number;
        let m: number;
        if (i + k <= last) {
          if (opens) {
            r = opens[i + k] / c0 - 1;
            // The k-th session's part: close → open for k = 1, open → open after.
            m = k === 1 ? r : opens[i + k] / opens[i + k - 1] - 1;
          } else {
            r = series.closes[i + k] / c0 - 1;
            m = series.closes[i + k] / series.closes[i + k - 1] - 1;
          }
        } else if (series.stopped) {
          // Stopped trading before the data ends: closed at its last close, flat afterwards.
          r = series.closes[last] / c0 - 1;
          m = 0;
          hasTruncated[j] = 1;
          anyTruncated = true;
        } else continue; // not enough future in the data yet
        const b = buckets[j];
        sumR[b] += r;
        sumC[b] += cost[j];
        cnt[b] += 1;
        sumM[b] += m;
        cntM[b] += 1;
        if (h >= 0) {
          icValues.push(vals[j]);
          icReturns.push(r);
        }
      }
      if (cnt[top] && cnt[bottom]) {
        const gross = sumR[top] / cnt[top] - sumR[bottom] / cnt[bottom];
        const longCost = sumC[top] / cnt[top];
        const shortCost = sumC[bottom] / cnt[bottom];
        spreadGross[k].push(gross);
        spreadNet[k].push(gross - longCost - shortCost);
        spreadDay[k].push(day);
        marginal[k].push(sumM[top] / cntM[top] - sumM[bottom] / cntM[bottom]);
        legCost[k].long.push(longCost);
        legCost[k].short.push(shortCost);
      }
      if (h >= 0) {
        for (let b = 0; b < q; b += 1) {
          if (!cnt[b]) continue;
          bucketGross[h][b].push(sumR[b] / cnt[b]);
          bucketNet[h][b].push((sumR[b] - sumC[b]) / cnt[b]);
        }
        const ic = icValues.length >= minStocks ? spearman(icValues, icReturns) : null;
        if (ic !== null) icSeries[h].push(ic);
      }
    }
    for (let j = 0; j < n; j += 1) {
      if (anyTruncated) truncated += hasTruncated[j];
      dataErrors += hasDataError[j];
    }
  }

  if (!ranked.length) {
    throw new LabInputError(
      `No day had ${minStocks} or more stocks with a value to rank${D ? "" : " (no sessions in the period)"}. Pick a longer period or a signal with enough history (most need 1–12 months of warm-up).`,
    );
  }

  // ---- turnover: share of a bucket's (or a side's) stocks that weren't in it `lag` sessions earlier
  const isRanked = new Uint8Array(D);
  for (const d of ranked) isRanked[d] = 1;
  const turnoverAt = (lag: number): Turnover => {
    const share = Array.from({ length: q }, () => ({ sum: 0, days: 0 }));
    const sides = [
      { sum: 0, days: 0 },
      { sum: 0, days: 0 },
    ];
    for (const d of ranked) {
      const p = d - lag;
      if (p < 0 || !isRanked[p]) continue;
      const total = new Int32Array(q);
      const moved = new Int32Array(q);
      const sideTotal = [0, 0];
      const sideMoved = [0, 0];
      for (let s = 0; s < S; s += 1) {
        const b = bucketOf[d * S + s];
        if (b < 0) continue;
        total[b] += 1;
        if (bucketOf[p * S + s] !== b) moved[b] += 1;
        const side = sideOf[d * S + s];
        if (side) {
          sideTotal[side - 1] += 1;
          if (sideOf[p * S + s] !== side) sideMoved[side - 1] += 1;
        }
      }
      for (let b = 0; b < q; b += 1) {
        if (!total[b]) continue;
        share[b].sum += moved[b] / total[b];
        share[b].days += 1;
      }
      for (let k = 0; k < 2; k += 1) {
        if (!sideTotal[k]) continue;
        sides[k].sum += sideMoved[k] / sideTotal[k];
        sides[k].days += 1;
      }
    }
    const avg = (entry: { sum: number; days: number }) => (entry.days ? entry.sum / entry.days : null);
    return { buckets: share.map(avg), long: avg(sides[0]), short: avg(sides[1]) };
  };

  // ---- splits
  const states = input.regimeStates ?? null;
  const stateDays = states ? [...states.keys()].sort((a, b) => a - b) : [];
  const rankedDays = ranked.map((d) => days[d]);
  const splitDate = splitDay(
    rankedDays.map((date) => ({ date })),
    input.splitFraction ?? SPLIT_FRACTION,
  );
  const pick = (k: number, keep: (day: number) => boolean): SpreadPair => {
    const gross: number[] = [];
    const net: number[] = [];
    const dayList = spreadDay[k];
    for (let i = 0; i < dayList.length; i += 1) {
      if (!keep(dayList[i])) continue;
      gross.push(spreadGross[k][i]);
      net.push(spreadNet[k][i]);
    }
    return { gross: seriesStats(gross, k - 1), net: seriesStats(net, k - 1) };
  };
  const stateOf = (day: number) => (states ? stateOn(states as Map<number, MarketState>, stateDays, day) : null);

  const byHorizon: HorizonReport[] = horizons.map((k, h) => {
    const spread: SpreadPair = { gross: seriesStats(spreadGross[k], k - 1), net: seriesStats(spreadNet[k], k - 1) };
    const turnover = turnoverAt(k);
    const longCost = mean(legCost[k].long);
    const shortCost = mean(legCost[k].short);
    // Close → open: every position is sold at the open, so each rebalance is a full round trip (no turnover saving).
    const netAtTurnover =
      !toOpen && spread.gross.mean !== null && longCost !== null && shortCost !== null && turnover.long !== null && turnover.short !== null
        ? spread.gross.mean - turnover.long * longCost - turnover.short * shortCost
        : null;
    const sample = seriesStats(everyNth(spreadNet[k], k), 0);
    const first = pick(k, (day) => splitDate === null || day < splitDate);
    const last = pick(k, (day) => splitDate !== null && day >= splitDate);
    let unknown = 0;
    if (states) for (const day of spreadDay[k]) if (stateOf(day) === null) unknown += 1;
    const quantiles: QuantileRow[] = Array.from({ length: q }, (_, b) => ({
      bucket: b + 1,
      stocks: bucketCounts[b] / ranked.length,
      gross: mean(bucketGross[h][b]),
      t: bucketGross[h][b].length >= 3 ? neweyWestT(bucketGross[h][b], k - 1) : null,
      net: mean(bucketNet[h][b]),
    }));
    return {
      horizon: k,
      lag: k - 1,
      quantiles,
      spread,
      sharpeAnnual: sample.sharpe === null ? null : sample.sharpe * Math.sqrt(SESSIONS_PER_YEAR / k),
      netAtTurnover,
      cost: { long: longCost, short: shortCost },
      ic: { mean: mean(icSeries[h]), t: icSeries[h].length >= 3 ? neweyWestT(icSeries[h], k - 1) : null, days: icSeries[h].length },
      regimes: states
        ? { up: pick(k, (day) => stateOf(day) === "up"), down: pick(k, (day) => stateOf(day) === "down"), unknown }
        : { up: { gross: emptyStats(), net: emptyStats() }, down: { gross: emptyStats(), net: emptyStats() }, unknown: spreadDay[k].length },
      split: { splitDate, first, last },
      turnover,
      dsr: { sharpe: sample.sharpe, n: sample.n, skewness: sample.skewness, kurtosis: sample.kurtosis, step: k },
      series: { days: everyNth(spreadDay[k], k), net: everyNth(spreadNet[k], k) },
      passes: spread.net.n >= MIN_TRADES && (first.net.mean ?? 0) > 0 && (last.net.mean ?? 0) > 0 && spread.net.t !== null && spread.net.t > MIN_T,
    };
  });

  const decay: DecayPoint[] = Array.from({ length: decayTo }, (_, i) => {
    const k = i + 1;
    const gross = mean(spreadGross[k]);
    return {
      horizon: k,
      gross,
      net: mean(spreadNet[k]),
      t: spreadGross[k].length >= 3 ? neweyWestT(spreadGross[k], k - 1) : null,
      netSe: spreadNet[k].length >= 3 ? neweyWestSE(spreadNet[k], k - 1) : null,
      marginal: mean(marginal[k]),
      marginalT: marginal[k].length >= 3 ? neweyWestT(marginal[k], 0) : null,
    };
  });

  const occupiedBuckets = occupiedSum / ranked.length;
  const notes: string[] = [];
  if (toOpen) notes.push("Forward returns are close → open: bought at the formation day's close, sold at the open k sessions later (k = 1 is the BTST trade). The decay's marginal return is the overnight gap for k = 1 and open to open after.");
  if (reversed) notes.push("Reversed: ranked by minus the signal, so Q5 holds its lowest values and the spread is low minus high.");
  if (occupiedBuckets < q - 0.5) {
    notes.push(
      `The signal takes few distinct values (${occupiedBuckets.toFixed(1)} of ${q} buckets occupied on an average day), so tied stocks share a bucket and the spread is the top occupied bucket minus the bottom one${input.signal.kind === "binary" ? ": the stocks the screen matched minus the rest" : ""}.`,
    );
  }
  if (skippedDays) notes.push(`${skippedDays} session${skippedDays === 1 ? " was" : "s were"} skipped: fewer than ${minStocks} stocks had a value, or all values were tied.`);
  const errorSymbols = [...badBars].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([symbol, bars]) => ({ symbol, bars }));
  const errorBars = errorSymbols.reduce((sum, entry) => sum + entry.bars, 0);
  if (errorBars) {
    notes.push(
      `${errorBars} session${errorBars === 1 ? "" : "s"} moved more than ±${Math.round(maxMove * 100)}% close to close${toOpen ? " or previous close to open" : ""} (${errorSymbols
        .slice(0, 6)
        .map((entry) => entry.symbol)
        .join(", ")}${errorSymbols.length > 6 ? ", …" : ""}): treated as data errors (a split or bonus the adjustment missed, a bad print), so the ${dataErrors} observation${dataErrors === 1 ? "" : "s"} whose forward window held one ${dataErrors === 1 ? "was" : "were"} left out. Signal values computed across such a session may be wrong too.`,
    );
  }
  if (truncated) notes.push(`${truncated} observation${truncated === 1 ? "" : "s"} of stocks that stopped trading before the data ends (delisted, suspended or merged) were closed at their last close.`);

  return {
    engine: LAB_ENGINE,
    signal: {
      ...input.signal,
      ...(reversed ? { reversed: true } : {}),
      ...(toOpen ? { forward } : {}),
      variantKey: variantKey(input.signal.id, input.signal.params, { reversed, forward }),
    },
    quantiles: q,
    horizons,
    period: { from: rankedDays[0], to: rankedDays.at(-1)!, days: ranked.length, sessions: D, skippedDays },
    universe: { symbols: seen.size, perDay: { min: minPerDay, mean: observations / ranked.length, max: maxPerDay } },
    observations,
    truncated,
    dataErrors: { maxDailyMove: maxMove, bars: errorBars, observations: dataErrors, symbols: errorSymbols.slice(0, 20) },
    costPerTrade: observations ? costSum / observations : null,
    occupiedBuckets,
    byHorizon,
    decay,
    dailyTurnover: turnoverAt(1),
    notes,
  };
}
