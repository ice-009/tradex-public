// The deflated Sharpe ratio: how likely a backtest's Sharpe ratio is to be real
// once you account for how many variants were tried, how short the record is,
// and how far the returns are from normal (fat tails, skew).
//
//   Bailey, D. H. & López de Prado, M. (2012). "The Sharpe Ratio Efficient
//     Frontier". Journal of Risk 15(2). — the probabilistic Sharpe ratio (PSR).
//   Bailey, D. H. & López de Prado, M. (2014). "The Deflated Sharpe Ratio:
//     Correcting for Selection Bias, Backtest Overfitting and Non-Normality".
//     Journal of Portfolio Management 40(5), 94–107. — the deflated Sharpe ratio (DSR).
//
// Units. Every Sharpe ratio here is PER PERIOD and NOT annualised: the mean of
// the period returns divided by their standard deviation, where a "period" is
// whatever one observation of the return series is (a day, a 5-session holding
// period, …). T is the number of those observations, and skewness / kurtosis are
// of the same series. Kurtosis is the plain (non-excess) kind: 3 for a normal
// distribution. Use `perPeriodSharpe` to convert an annualised figure.
//
// PSR(SR*) = Φ( (SR̂ − SR*) · √(T − 1) / √(1 − γ₃·SR̂ + (γ₄ − 1)/4 · SR̂²) )
//   the probability that the true Sharpe ratio is above SR*, given the observed
//   SR̂ over T observations with skewness γ₃ and kurtosis γ₄.
//
// DSR = PSR(SR₀), with SR₀ the Sharpe ratio the best of N independent trials
// would reach by luck alone when every trial's true Sharpe ratio is zero:
//   SR₀ = E[max SR] ≈ √V[SR] · ((1 − γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e)))
//   (γ = Euler–Mascheroni, V[SR] = variance of the Sharpe ratios across the trials).
// Each extra trial raises SR₀, so the bar rises with every variant tried.
//
// No dependencies. Φ is Hart's double-precision rational approximation (as given
// by West 2005, "Better approximations to cumulative normal functions") for
// |x| < 3 and Laplace's continued fraction for the tails; Φ⁻¹ is Acklam's
// rational approximation polished with one Halley step against that Φ. Both
// agree with the exact values to ~1e-14 relative (tests: Python's erfc / inv_cdf).

/** Euler–Mascheroni constant γ. */
export const EULER_GAMMA = 0.5772156649015329;

const SQRT_2PI = Math.sqrt(2 * Math.PI);
const TAIL_TERMS = 80;

/** Standard normal cumulative distribution function Φ(x). */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const z = Math.abs(x);
  let tail: number; // Φ(−|x|)
  if (z > 38.5) {
    tail = 0; // below the smallest double
  } else if (z < 3) {
    const e = Math.exp((-z * z) / 2);
    let num = 3.52624965998911e-2 * z + 0.700383064443688;
    num = num * z + 6.37396220353165;
    num = num * z + 33.912866078383;
    num = num * z + 112.079291497871;
    num = num * z + 221.213596169931;
    num = num * z + 220.206867912376;
    let den = 8.83883476483184e-2 * z + 1.75566716318264;
    den = den * z + 16.064177579207;
    den = den * z + 86.7807322029461;
    den = den * z + 296.564248779674;
    den = den * z + 637.333633378831;
    den = den * z + 793.826512519948;
    den = den * z + 440.413735824752;
    tail = (e * num) / den;
  } else {
    // Laplace's continued fraction for the Mills ratio, evaluated bottom-up:
    // Φ(−z) = φ(z) / (z + 1/(z + 2/(z + 3/(z + …)))). 80 terms is converged for z ≥ 3.
    let f = z;
    for (let k = TAIL_TERMS; k >= 1; k--) f = z + k / f;
    tail = Math.exp((-z * z) / 2) / SQRT_2PI / f;
  }
  return x > 0 ? 1 - tail : tail;
}

const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const P_LOW = 0.02425;

/** Inverse of the standard normal CDF, Φ⁻¹(p): −Infinity at 0, Infinity at 1, NaN outside [0, 1]. */
export function normInv(p: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1) return NaN;
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  let x: number;
  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  } else if (p <= 1 - P_LOW) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  // One Halley step (Acklam's refinement). In the upper tail work with the upper
  // tail probability so 1 − p doesn't lose digits.
  if (x > 0) {
    const e = normCdf(-x) - (1 - p);
    const u = -e * SQRT_2PI * Math.exp((x * x) / 2);
    x -= u / (1 + (x * u) / 2);
  } else {
    const e = normCdf(x) - p;
    const u = e * SQRT_2PI * Math.exp((x * x) / 2);
    x -= u / (1 + (x * u) / 2);
  }
  return x;
}

/** A Sharpe ratio estimate with what its precision depends on. All per period (see the units note above). */
export interface SharpeSample {
  /** Observed Sharpe ratio, per period (mean / standard deviation of the period returns), not annualised. */
  sharpe: number;
  /** Number of return observations behind it. */
  T: number;
  /** Skewness of the returns (0 for normal). */
  skew: number;
  /** Kurtosis of the returns, non-excess (3 for normal). */
  kurt: number;
}

/**
 * Standard deviation of the Sharpe ratio estimate (Mertens / Bailey & López de Prado):
 * √((1 − γ₃·SR + (γ₄ − 1)/4 · SR²) / (T − 1)). NaN when T < 2 or the moments are inconsistent.
 */
export function sharpeStdError({ sharpe, T, skew, kurt }: SharpeSample): number {
  if (![sharpe, T, skew, kurt].every(Number.isFinite) || T < 2) return NaN;
  const variance = 1 - skew * sharpe + ((kurt - 1) / 4) * sharpe * sharpe;
  // For any real distribution kurt ≥ 1 + skew², which makes this ≥ (1 − skew·SR/2)² ≥ 0.
  if (!(variance > 0)) return NaN;
  return Math.sqrt(variance / (T - 1));
}

/**
 * Probabilistic Sharpe ratio: the probability that the true (per-period) Sharpe
 * ratio exceeds `benchmark` (per period; 0 = "better than nothing"). NaN when it can't be computed.
 */
export function probabilisticSharpe(sample: SharpeSample, benchmark = 0): number {
  const se = sharpeStdError(sample);
  if (!Number.isFinite(se) || !Number.isFinite(benchmark)) return NaN;
  return normCdf((sample.sharpe - benchmark) / se);
}

/**
 * Expected maximum Sharpe ratio among `nTrials` independent trials whose true
 * Sharpe ratio is zero, when the estimated Sharpe ratios have variance
 * `varianceSR` across the trials (same units as the Sharpe ratios). 0 for one
 * trial or less (nothing to select from). `nTrials` may be fractional (an
 * effective number of trials).
 */
export function expectedMaxSharpe(nTrials: number, varianceSR: number): number {
  if (!Number.isFinite(nTrials) || !Number.isFinite(varianceSR) || varianceSR < 0) return NaN;
  if (nTrials <= 1 || varianceSR === 0) return 0;
  const z = (1 - EULER_GAMMA) * normInv(1 - 1 / nTrials) + EULER_GAMMA * normInv(1 - 1 / (nTrials * Math.E));
  return Math.sqrt(varianceSR) * z;
}

/** How the selection bias is described: the trials' count and spread, or a ready expected maximum. */
export type DeflationInput = { nTrials: number; varianceSR: number } | { expectedMax: number };

export interface DeflatedSharpe {
  /** P(true SR > SR₀): the deflated Sharpe ratio, in [0, 1]. */
  dsr: number;
  /** P(true SR > 0): the probabilistic Sharpe ratio against a zero benchmark. */
  psr: number;
  /** The benchmark the trials raise: expected maximum Sharpe ratio under the null, per period. */
  sr0: number;
}

/** The deflated Sharpe ratio of the selected trial (its sample) given the trials it was selected from. */
export function deflatedSharpe(sample: SharpeSample, input: DeflationInput): DeflatedSharpe {
  const sr0 = "expectedMax" in input ? input.expectedMax : expectedMaxSharpe(input.nTrials, input.varianceSR);
  return { dsr: probabilisticSharpe(sample, sr0), psr: probabilisticSharpe(sample, 0), sr0 };
}

/**
 * Effective number of independent trials when the M variants' return series
 * are correlated with average pairwise correlation ρ̄: N ≈ ρ̄ + (1 − ρ̄)·M.
 *
 * This is the approximation López de Prado gives for turning correlated trials
 * into an equivalent count of independent ones: all variants perfectly
 * correlated (ρ̄ = 1) is one trial; uncorrelated (ρ̄ = 0) is M trials. It is a
 * heuristic — his more careful method clusters the variants and counts the
 * clusters — but it needs nothing beyond ρ̄. A negative ρ̄ is treated as 0 (no
 * credit for diversification: that would only make the bar lower), and ρ̄ above
 * 1 or missing is clamped / ignored, so the count never drops below 1 or rises above M.
 */
export function effectiveTrials(m: number, avgCorrelation: number | null | undefined): number {
  if (!Number.isFinite(m) || m <= 1) return Math.max(0, Number.isFinite(m) ? m : 0);
  if (avgCorrelation === null || avgCorrelation === undefined || !Number.isFinite(avgCorrelation)) return m;
  const rho = Math.min(1, Math.max(0, avgCorrelation));
  return rho + (1 - rho) * m;
}

/** Pearson correlation of two equally long series (NaN when either is constant or they're too short). */
export function correlation(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return NaN;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
}

/**
 * Average pairwise correlation between the variants' return series (aligned on
 * the same periods; pairs that can't be correlated are skipped). NaN with fewer than two usable series.
 */
export function averageCorrelation(series: ReadonlyArray<readonly number[]>): number {
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < series.length; i++) {
    for (let j = i + 1; j < series.length; j++) {
      const rho = correlation(series[i], series[j]);
      if (Number.isFinite(rho)) {
        sum += rho;
        pairs++;
      }
    }
  }
  return pairs ? sum / pairs : NaN;
}

/** Sample variance (n − 1) of the values; 0 for fewer than two. */
export function sampleVariance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

/** Moments of a return series, for a SharpeSample: per-period Sharpe, skewness and (non-excess) kurtosis. */
export function sharpeSampleOf(returns: readonly number[]): SharpeSample {
  const T = returns.length;
  if (T < 2) return { sharpe: NaN, T, skew: NaN, kurt: NaN };
  const mean = returns.reduce((sum, value) => sum + value, 0) / T;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const value of returns) {
    const d = value - mean;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= T;
  m3 /= T;
  m4 /= T;
  const sd = Math.sqrt((m2 * T) / (T - 1));
  return { sharpe: sd > 0 ? mean / sd : NaN, T, skew: m2 > 0 ? m3 / m2 ** 1.5 : NaN, kurt: m2 > 0 ? m4 / (m2 * m2) : NaN };
}

/** Annualised Sharpe → per period, for `periodsPerYear` periods a year (252 for daily). */
export const perPeriodSharpe = (annual: number, periodsPerYear: number) => annual / Math.sqrt(periodsPerYear);

/** Per-period Sharpe → annualised. */
export const annualisedSharpe = (perPeriod: number, periodsPerYear: number) => perPeriod * Math.sqrt(periodsPerYear);
