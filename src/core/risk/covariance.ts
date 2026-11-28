// Covariance of daily returns, shrunk toward a constant-correlation target
// (Ledoit & Wolf 2004, "Honey, I shrunk the sample covariance matrix"). Pure.
//
// Why shrink: with 120 sessions and 10–15 stocks the sample covariance is
// noisy — a pair can show ρ = 0.8 or 0.1 by chance — and sizing on that noise
// would cut good ideas or wave through clustered ones. The target keeps each
// stock's own variance and replaces every correlation by the average one; the
// estimate is the blend δ·target + (1 − δ)·sample, with δ the intensity that
// minimises the expected squared error (their closed form, below). Few
// sessions or a noisy sample → δ near 1 (lean on the average); a long, clean
// sample → δ near 0.
//
// Why constant correlation rather than a single-index (NIFTY) target: F&O
// stocks share one dominant market factor, which the average correlation
// already captures, and the constant-correlation target needs no benchmark
// series (it works for any set of stocks, also where NIFTY's own history is a
// stand-in). Same-sector pairs whose sample ρ is well above the average keep
// part of that excess after shrinking — which is the signal the plan sizes on.

export interface ShrunkCovariance {
  /** δ·target + (1 − δ)·sample. */
  cov: number[][];
  sample: number[][];
  target: number[][];
  /** Shrinkage intensity δ in [0, 1]. */
  shrinkage: number;
  /** Mean of the sample's off-diagonal correlations (the target's ρ). */
  meanCorrelation: number;
  /** Sessions used. */
  observations: number;
}

const zeros = (n: number) => Array.from({ length: n }, () => new Array<number>(n).fill(0));

/**
 * `rows` is T sessions × N stocks of returns with no gaps (fill them first).
 * Means are removed; moments use 1/T as in Ledoit & Wolf.
 */
export function shrunkCovariance(rows: readonly (readonly number[])[]): ShrunkCovariance {
  const t = rows.length;
  const n = t ? rows[0].length : 0;
  if (!t || !n) return { cov: [], sample: [], target: [], shrinkage: 1, meanCorrelation: 0, observations: t };
  const means = new Array<number>(n).fill(0);
  for (const row of rows) for (let j = 0; j < n; j += 1) means[j] += row[j] / t;
  const x = rows.map((row) => row.map((value, j) => value - means[j]));

  const sample = zeros(n);
  for (const row of x) for (let i = 0; i < n; i += 1) for (let j = i; j < n; j += 1) sample[i][j] += (row[i] * row[j]) / t;
  for (let i = 0; i < n; i += 1) for (let j = 0; j < i; j += 1) sample[i][j] = sample[j][i];
  const sd = sample.map((row, i) => Math.sqrt(Math.max(0, row[i])));

  // Target: own variances, every correlation = the sample's average.
  let rhoSum = 0;
  let pairs = 0;
  for (let i = 0; i < n; i += 1)
    for (let j = i + 1; j < n; j += 1) {
      if (sd[i] > 0 && sd[j] > 0) {
        rhoSum += sample[i][j] / (sd[i] * sd[j]);
        pairs += 1;
      }
    }
  const rbar = pairs ? rhoSum / pairs : 0;
  const target = zeros(n);
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) target[i][j] = i === j ? sample[i][i] : rbar * sd[i] * sd[j];
  if (n === 1) return { cov: sample.map((row) => [...row]), sample, target, shrinkage: 0, meanCorrelation: 0, observations: t };

  // Optimal intensity: δ = max(0, min(1, κ / T)), κ = (π − ρ) / γ.
  //   π = Σ_ij Var(√T s_ij)            (the sample's estimation error)
  //   ρ = Σ_i π_ii + Σ_i≠j (r̄/2)(√(s_jj/s_ii) θ_ii,ij + √(s_ii/s_jj) θ_jj,ij)
  //   γ = Σ_ij (f_ij − s_ij)²          (how far the target is from the sample)
  let pi = 0;
  let rhoTerm = 0;
  const piDiag = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1)
    for (let j = 0; j < n; j += 1) {
      let piIJ = 0;
      let thetaII = 0;
      let thetaJJ = 0;
      for (const row of x) {
        const cross = row[i] * row[j] - sample[i][j];
        piIJ += cross * cross;
        if (i !== j) {
          thetaII += (row[i] * row[i] - sample[i][i]) * cross;
          thetaJJ += (row[j] * row[j] - sample[j][j]) * cross;
        }
      }
      piIJ /= t;
      pi += piIJ;
      if (i === j) piDiag[i] = piIJ;
      else if (sd[i] > 0 && sd[j] > 0) rhoTerm += (rbar / 2) * ((sd[j] / sd[i]) * (thetaII / t) + (sd[i] / sd[j]) * (thetaJJ / t));
    }
  rhoTerm += piDiag.reduce((sum, value) => sum + value, 0);
  let gamma = 0;
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) gamma += (target[i][j] - sample[i][j]) ** 2;
  const shrinkage = gamma > 0 ? Math.max(0, Math.min(1, (pi - rhoTerm) / gamma / t)) : 1;
  const cov = sample.map((row, i) => row.map((value, j) => shrinkage * target[i][j] + (1 - shrinkage) * value));
  return { cov, sample, target, shrinkage, meanCorrelation: rbar, observations: t };
}

/** Covariance → correlation (0 off the diagonal for a stock with no variance). */
export function toCorrelation(cov: readonly (readonly number[])[]): number[][] {
  const sd = cov.map((row, i) => Math.sqrt(Math.max(0, row[i])));
  return cov.map((row, i) => row.map((value, j) => (i === j ? 1 : sd[i] > 0 && sd[j] > 0 ? Math.max(-1, Math.min(1, value / (sd[i] * sd[j]))) : 0)));
}
