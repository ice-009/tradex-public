import type { CostModel } from "@/core/backtest/costs";
import { SPLIT_FRACTION, splitDay, stateOn, type MarketState } from "@/core/plan/evidence";
import type { DailyBar } from "@/core/types";
import { MAX_DAILY_MOVE, roundTripFraction, type SignalValues } from "./engine";
import { quantileBuckets } from "./quantiles";
import { neweyWestT, seriesStats } from "./stats";

// Portfolio-level overlays for the Signal Lab (issue #27). The Lab's engine
// ranks every day and measures forward returns from each; an overlay acts on
// the long–short PORTFOLIO over time, which ranking can't show (scaling the
// whole book leaves every rank unchanged). Pure.
//
// monthlySpread: the classic monthly long–short portfolio of a signal. On the
// last session of each calendar month the day's members with a value are
// ranked into quantiles (quantiles.ts, as the Lab does); the top bucket is held
// long and the bottom one short until the next month's last session, each leg
// equal-weighted and rebalanced to equal weights daily. A stock with no bar on a
// session (suspended, or stopped trading: closed at its last close) earns 0 that
// session; a session moving beyond ±50% is a data error and earns 0 too
// (counted). Costs: each stock entering a leg pays a futures round trip at its
// formation price (roundTripFraction, ~₹5 lakh a position) — the Lab's "net @
// turnover" convention; the daily re-weighting inside a month is not charged.
//
// volManaged (Barroso & Santa-Clara 2015, "Momentum has its moments", JFE
// 116(1)): each month the book is scaled by w = σ_target / σ̂, where σ̂² is the
// monthly variance forecast from the last `lookback` (126) daily returns of the
// long–short portfolio: σ̂² = 21 · Σ r_d² / 126. w is set at the formation
// close from returns up to that close, so there is no look-ahead. The target
// only sets the book's size: by default it is chosen so the managed book's
// realised volatility equals the unmanaged one's over the evaluated months (ex
// post, so both carry the same risk and their drawdowns compare; Sharpe ratios
// don't depend on it). Costs scale with
// w, and resizing the positions kept from last month pays half a round trip on
// the change.

export interface MonthlyInput {
  dates: readonly number[];
  symbols: readonly string[];
  bars: ReadonlyMap<string, readonly DailyBar[]>;
  values: SignalValues;
  membership?: (symbol: string, day: number) => boolean;
  costs: CostModel;
  quantiles?: number;
  minStocks?: number;
  maxDailyMove?: number;
  /** Formation days considered (inclusive). */
  from?: number | null;
  to?: number | null;
}

export interface MonthRow {
  /** Formation session (a month's last) and the session the month's holding ends. */
  formation: number;
  end: number;
  sessions: number;
  /** Stocks ranked, and in each leg. */
  ranked: number;
  long: number;
  short: number;
  /** Long leg − short leg over the month (each leg compounded), before costs. */
  gross: number;
  /** Turnover of each leg (share of its stocks new since last month; 1 the first month). */
  turnover: { long: number; short: number };
  /** Average round-trip cost of a position in each leg. */
  legCost: { long: number; short: number };
  /** Entry costs this month: turnover × leg cost, both legs. */
  cost: number;
  net: number;
}

export interface DailySpread {
  day: number;
  /** Long leg's return − short leg's that session. */
  spread: number;
}

export interface MonthlySpread {
  months: MonthRow[];
  daily: DailySpread[];
  /** Stock-sessions earning 0 as data errors (a move beyond maxDailyMove). */
  dataErrors: number;
  /** Months skipped: too few stocks with a value, or all tied. */
  skipped: number;
}

const month = (day: number) => {
  const date = new Date(day);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
};

/** The last session of each calendar month in `dates` (the newest month only when another follows it). */
export function monthEnds(dates: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < dates.length; i += 1) if (month(dates[i + 1]) !== month(dates[i])) out.push(dates[i]);
  return out;
}

/** The monthly long–short portfolio of a signal: one row per month held, and its daily returns. */
export function monthlySpread(input: MonthlyInput): MonthlySpread {
  const q = Math.max(2, Math.min(10, Math.round(input.quantiles ?? 5)));
  const minStocks = Math.max(q, Math.round(input.minStocks ?? 20));
  const maxMove = input.maxDailyMove ?? MAX_DAILY_MOVE;
  const from = input.from ?? -Infinity;
  const to = input.to ?? Infinity;
  const position = new Map(input.dates.map((day, i) => [day, i]));
  const index = new Map<string, Map<number, number>>();
  const indexOf = (symbol: string) => {
    let entry = index.get(symbol);
    if (!entry) index.set(symbol, (entry = new Map((input.bars.get(symbol) ?? []).map((bar, i) => [bar.t, i]))));
    return entry;
  };
  const ends = monthEnds(input.dates).filter((day) => day >= from && day <= to);
  const months: MonthRow[] = [];
  const daily: DailySpread[] = [];
  let dataErrors = 0;
  let skipped = 0;
  let previous: { long: Set<string>; short: Set<string> } | null = null;

  for (let m = 0; m + 1 < ends.length; m += 1) {
    const formation = ends[m];
    const end = ends[m + 1];
    const ranked: Array<{ symbol: string; value: number; price: number }> = [];
    for (const symbol of input.symbols) {
      const i = indexOf(symbol).get(formation);
      if (i === undefined) continue;
      const price = input.bars.get(symbol)![i].c;
      if (!(price > 0)) continue;
      if (input.membership && !input.membership(symbol, formation)) continue;
      const value = input.values(formation, symbol);
      if (value === null || !Number.isFinite(value)) continue;
      ranked.push({ symbol, value, price });
    }
    const buckets = ranked.length >= minStocks ? quantileBuckets(Float64Array.from(ranked, (entry) => entry.value), q) : null;
    let top = -1;
    let bottom = q;
    if (buckets) {
      for (const b of buckets) {
        top = Math.max(top, b);
        bottom = Math.min(bottom, b);
      }
    }
    if (!buckets || top === bottom) {
      skipped += 1;
      previous = null;
      continue;
    }
    const legs = { long: [] as typeof ranked, short: [] as typeof ranked };
    ranked.forEach((entry, j) => {
      if (buckets[j] === top) legs.long.push(entry);
      else if (buckets[j] === bottom) legs.short.push(entry);
    });
    const legCost = (leg: typeof ranked) => leg.reduce((sum, entry) => sum + roundTripFraction(entry.price, input.costs), 0) / leg.length;
    const turnoverOf = (leg: typeof ranked, before: Set<string> | undefined) => (before ? leg.filter((entry) => !before.has(entry.symbol)).length / leg.length : 1);
    const cost = { long: legCost(legs.long), short: legCost(legs.short) };
    const turnover = { long: turnoverOf(legs.long, previous?.long), short: turnoverOf(legs.short, previous?.short) };

    // Daily returns of each leg from the formation close to the month's end.
    const p0 = position.get(formation)!;
    const p1 = position.get(end)!;
    let growth = { long: 1, short: 1 };
    const legReturn = (leg: typeof ranked, day: number) => {
      let sum = 0;
      for (const entry of leg) {
        const i = indexOf(entry.symbol).get(day);
        if (i === undefined || i === 0) continue; // no bar that session: flat
        const bars = input.bars.get(entry.symbol)!;
        const r = bars[i].c / bars[i - 1].c - 1;
        if (!Number.isFinite(r) || Math.abs(r) > maxMove) {
          dataErrors += 1;
          continue;
        }
        sum += r;
      }
      return sum / leg.length;
    };
    for (let p = p0 + 1; p <= p1; p += 1) {
      const day = input.dates[p];
      const rl = legReturn(legs.long, day);
      const rs = legReturn(legs.short, day);
      growth = { long: growth.long * (1 + rl), short: growth.short * (1 + rs) };
      daily.push({ day, spread: rl - rs });
    }
    const gross = growth.long - growth.short;
    const entryCost = turnover.long * cost.long + turnover.short * cost.short;
    months.push({
      formation,
      end,
      sessions: p1 - p0,
      ranked: ranked.length,
      long: legs.long.length,
      short: legs.short.length,
      gross,
      turnover,
      legCost: cost,
      cost: entryCost,
      net: gross - entryCost,
    });
    previous = { long: new Set(legs.long.map((entry) => entry.symbol)), short: new Set(legs.short.map((entry) => entry.symbol)) };
  }
  return { months, daily, dataErrors, skipped };
}

export interface ManagedMonth extends MonthRow {
  /** Exposure this month (1 = the unmanaged book). */
  weight: number;
  /** Forecast monthly volatility of the unmanaged book at formation. */
  forecastVol: number;
}

export interface VolManagedOptions {
  /** Daily returns in the variance forecast (default 126). */
  lookback?: number;
  /** Target monthly volatility σ_target; default: the one at which the managed book's realised volatility equals the unmanaged one's over the evaluated months (ex post, scale only). */
  targetMonthlyVol?: number | null;
}

export interface VolManaged {
  /** The unmanaged book over the months a forecast exists for (the comparison's months). */
  plain: MonthRow[];
  managed: ManagedMonth[];
  targetMonthlyVol: number;
  lookback: number;
}

/** Barroso–Santa-Clara volatility scaling of a monthly long–short book. */
export function volManaged(spread: MonthlySpread, options: VolManagedOptions = {}): VolManaged {
  const lookback = Math.max(5, Math.round(options.lookback ?? 126));
  const days = spread.daily.map((entry) => entry.day);
  // Prefix sums of squared daily returns, by position in the daily series.
  const sq = new Float64Array(spread.daily.length + 1);
  spread.daily.forEach((entry, i) => (sq[i + 1] = sq[i] + entry.spread * entry.spread));
  const upTo = (day: number) => {
    // Number of daily returns dated on or before `day`.
    let lo = 0;
    let hi = days.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid] <= day) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const raw: Array<{ row: MonthRow; vol: number }> = [];
  for (const row of spread.months) {
    const k = upTo(row.formation);
    if (k < lookback) continue;
    const variance = (21 * (sq[k] - sq[k - lookback])) / lookback;
    if (!(variance > 0)) continue;
    raw.push({ row, vol: Math.sqrt(variance) });
  }
  const plain = raw.map((entry) => entry.row);
  const plainVol = seriesStats(
    plain.map((row) => row.gross),
    0,
  ).sd;
  // Unit-target weights first; the target then only rescales them.
  const unitGross = raw.map((entry) => entry.row.gross / entry.vol);
  const unitVol = seriesStats(unitGross, 0).sd;
  // Default target: the forecast volatility at which the managed book's realised volatility equals the plain one's.
  const target = options.targetMonthlyVol ?? (plainVol && unitVol ? plainVol / unitVol : 0);
  const managed: ManagedMonth[] = [];
  // The managed book starts from the plain one's size.
  let lastWeight = 1;
  for (const { row, vol } of raw) {
    const weight = target > 0 ? target / vol : 0;
    // Positions kept from last month are resized: half a round trip on the change.
    const resize = Math.abs(weight - lastWeight) * (((1 - row.turnover.long) * row.legCost.long + (1 - row.turnover.short) * row.legCost.short) / 2);
    const cost = weight * row.cost + resize;
    managed.push({ ...row, weight, forecastVol: vol, gross: weight * row.gross, cost, net: weight * row.gross - cost });
    lastWeight = weight;
  }
  return { plain, managed, targetMonthlyVol: target, lookback };
}

export interface PeriodReturn {
  label: string;
  /** Months whose holding ended in [from, to] (inclusive day keys). */
  from: number;
  to: number;
  months: number;
  /** Compounded net return over those months; null when none. */
  net: number | null;
}

export interface OverlayStats {
  months: number;
  from: number | null;
  to: number | null;
  /** Monthly net: mean, Newey–West t (lag 3), sd, annualised Sharpe (× √12). */
  mean: number | null;
  t: number | null;
  sd: number | null;
  sharpeAnnual: number | null;
  /** Per-month Sharpe, skewness, kurtosis (not excess): the deflated Sharpe inputs. */
  sharpe: number | null;
  skewness: number | null;
  kurtosis: number | null;
  hitRate: number | null;
  /** Compounded growth of 1 (net) and the deepest fall from a peak. */
  growth: number | null;
  maxDrawdown: number | null;
  worst: Array<{ end: number; net: number }>;
  regimes: { up: { months: number; mean: number | null; t: number | null }; down: { months: number; mean: number | null; t: number | null } };
  split: { splitDate: number | null; first: { months: number; mean: number | null }; last: { months: number; mean: number | null } };
  periods: PeriodReturn[];
  /** Average exposure (managed books), min and max. */
  weight: { mean: number; min: number; max: number } | null;
}

export const NW_LAG_MONTHS = 3;

export interface CrashPeriod {
  label: string;
  from: number;
  to: number;
}

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** The crash and rebound windows the overlay is judged on. */
export const CRASH_PERIODS: CrashPeriod[] = [
  { label: "2008 (crash)", from: day("2008-01-01"), to: day("2008-12-31") },
  { label: "Mar–Jun 2009 (rebound)", from: day("2009-03-01"), to: day("2009-06-30") },
  { label: "Mar–Apr 2020 (COVID crash and rebound)", from: day("2020-03-01"), to: day("2020-04-30") },
];

const meanT = (values: number[]) => {
  const stats = seriesStats(values, NW_LAG_MONTHS);
  return { months: values.length, mean: stats.mean, t: stats.t };
};

/** Statistics of a monthly book's net returns. */
export function overlayStats(
  rows: ReadonlyArray<MonthRow & { weight?: number }>,
  options: { regimeStates?: ReadonlyMap<number, MarketState> | null; periods?: CrashPeriod[]; splitFraction?: number } = {},
): OverlayStats {
  const net = rows.map((row) => row.net);
  const stats = seriesStats(net, NW_LAG_MONTHS);
  let growth = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const r of net) {
    growth *= 1 + r;
    peak = Math.max(peak, growth);
    maxDrawdown = Math.max(maxDrawdown, 1 - growth / peak);
  }
  const states = options.regimeStates ?? null;
  const stateDays = states ? [...states.keys()].sort((a, b) => a - b) : [];
  const stateOf = (formation: number) => (states ? stateOn(states as Map<number, MarketState>, stateDays, formation) : null);
  const splitDate = splitDay(
    rows.map((row) => ({ date: row.formation })),
    options.splitFraction ?? SPLIT_FRACTION,
  );
  const part = (keep: (row: MonthRow) => boolean) => {
    const values = rows.filter(keep).map((row) => row.net);
    return { months: values.length, mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
  };
  const weights = rows.map((row) => row.weight).filter((w): w is number => w !== undefined);
  return {
    months: rows.length,
    from: rows[0]?.formation ?? null,
    to: rows.at(-1)?.end ?? null,
    mean: stats.mean,
    t: stats.t,
    sd: stats.sd,
    sharpeAnnual: stats.sharpe === null ? null : stats.sharpe * Math.sqrt(12),
    sharpe: stats.sharpe,
    skewness: stats.skewness,
    kurtosis: stats.kurtosis,
    hitRate: stats.hitRate,
    growth: rows.length ? growth : null,
    maxDrawdown: rows.length ? maxDrawdown : null,
    worst: [...rows]
      .sort((a, b) => a.net - b.net)
      .slice(0, 5)
      .map((row) => ({ end: row.end, net: row.net })),
    regimes: {
      up: meanT(rows.filter((row) => stateOf(row.formation) === "up").map((row) => row.net)),
      down: meanT(rows.filter((row) => stateOf(row.formation) === "down").map((row) => row.net)),
    },
    split: { splitDate, first: part((row) => splitDate === null || row.formation < splitDate), last: part((row) => splitDate !== null && row.formation >= splitDate) },
    periods: (options.periods ?? CRASH_PERIODS).map((period) => {
      const inside = rows.filter((row) => row.end >= period.from && row.end <= period.to);
      return { label: period.label, from: period.from, to: period.to, months: inside.length, net: inside.length ? inside.reduce((g, row) => g * (1 + row.net), 1) - 1 : null };
    }),
    weight: weights.length ? { mean: weights.reduce((a, b) => a + b, 0) / weights.length, min: Math.min(...weights), max: Math.max(...weights) } : null,
  };
}

/** t-stat of the monthly difference managed − plain (paired, Newey–West lag 3). */
export function differenceT(plain: readonly MonthRow[], managed: readonly MonthRow[]): number | null {
  const n = Math.min(plain.length, managed.length);
  const diff = Array.from({ length: n }, (_, i) => managed[i].net - plain[i].net);
  return n >= 3 ? neweyWestT(diff, NW_LAG_MONTHS) : null;
}
