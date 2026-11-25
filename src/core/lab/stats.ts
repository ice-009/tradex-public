// Statistics for the Signal Lab (src/core/lab/engine.ts). Pure.
//
// The Lab measures forward returns over h sessions from EVERY day, so
// consecutive observations share h − 1 days of return: a 21-session spread
// measured daily is 21 overlapping windows of mostly the same moves. A plain
// t-stat (mean ÷ (sd / √n)) treats them as independent and overstates the
// evidence by roughly √h. The Newey–West (1987) standard error adds the
// series' autocovariances up to `lag` with Bartlett weights 1 − j/(lag + 1);
// lag = h − 1 covers exactly the overlap. Lag 0 is the plain (population
// variance) standard error.
//
// Conventions match statsmodels' HAC with `use_correction=False` (moments over
// n, not n − 1), so a value can be checked there: OLS of the series on a
// constant with cov_type="HAC", maxlags=lag.

export interface SeriesStats {
  /** Observations (days). */
  n: number;
  mean: number | null;
  /** Newey–West t-stat of the mean (lag in the parent), null with < 3 observations or no variance. */
  t: number | null;
  /** Standard deviation (n − 1). */
  sd: number | null;
  /** mean ÷ sd per observation (not annualised): the input the deflated Sharpe ratio wants. */
  sharpe: number | null;
  /** Share of observations above zero. */
  hitRate: number | null;
  /** Sample skewness (population moments: m3 / m2^1.5). */
  skewness: number | null;
  /** Sample kurtosis, NOT excess (m4 / m2²; a normal distribution has 3). */
  kurtosis: number | null;
}

export function mean(values: ArrayLike<number>): number | null {
  if (!values.length) return null;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i];
  return sum / values.length;
}

/** Newey–West (Bartlett kernel) standard error of the mean. */
export function neweyWestSE(values: ArrayLike<number>, lag: number): number | null {
  const n = values.length;
  if (n < 2) return null;
  const m = mean(values)!;
  const e = new Float64Array(n);
  for (let i = 0; i < n; i += 1) e[i] = values[i] - m;
  let gamma0 = 0;
  for (let i = 0; i < n; i += 1) gamma0 += e[i] * e[i];
  let lrv = gamma0 / n;
  const maxLag = Math.min(Math.max(0, Math.floor(lag)), n - 1);
  for (let j = 1; j <= maxLag; j += 1) {
    let gamma = 0;
    for (let i = j; i < n; i += 1) gamma += e[i] * e[i - j];
    lrv += 2 * (1 - j / (maxLag + 1)) * (gamma / n);
  }
  // Bartlett weights keep the long-run variance non-negative; guard rounding anyway.
  return lrv > 0 ? Math.sqrt(lrv / n) : null;
}

/** t-stat of the mean with Newey–West standard errors (lag = horizon − 1 for overlapping h-session returns). */
export function neweyWestT(values: ArrayLike<number>, lag: number): number | null {
  const se = neweyWestSE(values, lag);
  const m = mean(values);
  return se && m !== null ? m / se : null;
}

export function seriesStats(values: ArrayLike<number>, lag: number): SeriesStats {
  const n = values.length;
  const m = mean(values);
  if (m === null) return { n, mean: null, t: null, sd: null, sharpe: null, hitRate: null, skewness: null, kurtosis: null };
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  let up = 0;
  for (let i = 0; i < n; i += 1) {
    const d = values[i] - m;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
    if (values[i] > 0) up += 1;
  }
  const sd = n > 1 ? Math.sqrt(m2 / (n - 1)) : null;
  m2 /= n;
  m3 /= n;
  m4 /= n;
  return {
    n,
    mean: m,
    t: n >= 3 ? neweyWestT(values, lag) : null,
    sd,
    sharpe: sd && sd > 0 ? m / sd : null,
    hitRate: up / n,
    skewness: m2 > 0 ? m3 / m2 ** 1.5 : null,
    kurtosis: m2 > 0 ? m4 / (m2 * m2) : null,
  };
}

/** Every `step`-th value starting at the first: a non-overlapping sample of an h-session series. */
export function everyNth(values: ArrayLike<number>, step: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i += Math.max(1, step)) out.push(values[i]);
  return out;
}

/** Ranks 1..n with ties given their average rank. */
export function averageRanks(values: ArrayLike<number>): Float64Array {
  const n = values.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  const ranks = new Float64Array(n);
  for (let start = 0; start < n; ) {
    let end = start;
    while (end + 1 < n && values[order[end + 1]] === values[order[start]]) end += 1;
    const rank = (start + end) / 2 + 1;
    for (let k = start; k <= end; k += 1) ranks[order[k]] = rank;
    start = end + 1;
  }
  return ranks;
}

/** Pearson correlation; null when either side has no variance. */
export function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ma = mean(a)!;
  const mb = mean(b)!;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

/** Spearman rank correlation (the information coefficient of a signal against its forward returns). */
export const spearman = (a: ArrayLike<number>, b: ArrayLike<number>) => correlation(averageRanks(a), averageRanks(b));
