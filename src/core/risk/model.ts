import { shrunkCovariance, toCorrelation } from "./covariance";
import type { ReturnSeries } from "./returns";

// The risk model behind correlation-aware sizing and the exposure view (issue
// #40): for the stocks you hold and the plan's ideas, each one's daily
// volatility, beta to NIFTY and the correlations between them, from the last
// RISK_LOOKBACK (120) sessions of daily returns. Pure.
//
//   Window   120 sessions (≈ 6 months). 60 is too few for 10–15 stocks (the
//            sample has more noise than signal, even shrunk); a year or more
//            mixes in regimes that are gone (a sector's correlation with the
//            market moves with rates, results seasons, flows). In the Time
//            Machine the window ends at the day shown.
//   Shrinkage  toward constant correlation, Ledoit–Wolf intensity
//            (./covariance.ts). Correlations below come from the shrunk matrix.
//   Gaps     a stock with returns on fewer than MIN_COVERAGE of the sessions
//            (newly listed, long halt) is left out of the model — sizing and the
//            exposure view then fall back to its industry (exposure.ts). Other
//            gaps are filled with the stock's mean return (zero after demeaning),
//            which shrinks its variance a little; with ≥ 80% coverage that is
//            under 20%.
//   Beta     ordinary least squares on NIFTY's returns over the same sessions
//            (the sample, not shrunk); null without NIFTY bars.

/** Least share of the window's sessions a stock needs returns on to be in the model. */
export const MIN_COVERAGE = 0.8;
/** Fewest sessions for a model at all. */
export const MIN_SESSIONS = 30;

export interface RiskModel {
  /** Stocks in the model, in matrix order. */
  symbols: string[];
  index: Record<string, number>;
  /** Day keys of the window's first and last return. */
  from: number | null;
  to: number | null;
  sessions: number;
  /** Shrunk covariance and its correlations (daily log returns). */
  cov: number[][];
  corr: number[][];
  /** Daily volatility (σ of log returns) per stock. */
  vol: Record<string, number>;
  /** Beta to NIFTY per stock; null without benchmark returns. */
  beta: Record<string, number | null>;
  /** Ledoit–Wolf δ and the target's average correlation. */
  shrinkage: number;
  meanCorrelation: number;
  /** Gap-filled returns per stock (for the historical tail loss in exposure.ts). */
  returns: Record<string, number[]>;
  /** Asked for but left out: too little history in the window. */
  excluded: string[];
}

const mean = (values: readonly number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

function olsBeta(stock: readonly (number | null)[], market: readonly (number | null)[]): number | null {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < stock.length; i += 1) {
    const s = stock[i];
    const m = market[i];
    if (s !== null && m !== null && Number.isFinite(s) && Number.isFinite(m)) pairs.push([s, m]);
  }
  if (pairs.length < MIN_SESSIONS) return null;
  const ms = mean(pairs.map(([s]) => s));
  const mm = mean(pairs.map(([, m]) => m));
  let cov = 0;
  let varM = 0;
  for (const [s, m] of pairs) {
    cov += (s - ms) * (m - mm);
    varM += (m - mm) ** 2;
  }
  return varM > 0 ? cov / varM : null;
}

/** The model for `series` (every stock in it, or only `symbols`). Null when the window is under MIN_SESSIONS. */
export function buildRiskModel(series: ReturnSeries, symbols: readonly string[] = Object.keys(series.returns)): RiskModel | null {
  const t = series.sessions.length;
  if (t < MIN_SESSIONS) return null;
  const wanted = [...new Set(symbols)];
  const kept: string[] = [];
  const excluded: string[] = [];
  const filled: Record<string, number[]> = {};
  for (const symbol of wanted) {
    const raw = series.returns[symbol] ?? [];
    const valid = raw.filter((value): value is number => value !== null && Number.isFinite(value));
    if (raw.length !== t || valid.length < MIN_COVERAGE * t) {
      excluded.push(symbol);
      continue;
    }
    const fill = mean(valid);
    filled[symbol] = raw.map((value) => (value !== null && Number.isFinite(value) ? value : fill));
    kept.push(symbol);
  }
  const rows = series.sessions.map((_, i) => kept.map((symbol) => filled[symbol][i]));
  const shrunk = shrunkCovariance(kept.length ? rows : []);
  const corr = toCorrelation(shrunk.cov);
  const hasBenchmark = series.benchmark.length === t && series.benchmark.some((value) => value !== null);
  return {
    symbols: kept,
    index: Object.fromEntries(kept.map((symbol, i) => [symbol, i])),
    from: series.sessions[0] ?? null,
    to: series.sessions.at(-1) ?? null,
    sessions: t,
    cov: shrunk.cov,
    corr,
    vol: Object.fromEntries(kept.map((symbol, i) => [symbol, Math.sqrt(Math.max(0, shrunk.cov[i][i]))])),
    beta: Object.fromEntries(kept.map((symbol) => [symbol, hasBenchmark ? olsBeta(series.returns[symbol], series.benchmark) : null])),
    shrinkage: shrunk.shrinkage,
    meanCorrelation: shrunk.meanCorrelation,
    returns: filled,
    excluded,
  };
}

/** The model's correlation of two stocks, or null when either isn't in it. */
export function correlationOf(model: RiskModel | null, a: string, b: string): number | null {
  if (!model) return null;
  const i = model.index[a];
  const j = model.index[b];
  return i === undefined || j === undefined ? null : model.corr[i][j];
}
