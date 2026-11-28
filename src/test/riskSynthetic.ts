// Seeded synthetic returns for the risk-model tests: a market factor, sector
// factors and noise, with known correlations.

/** Mulberry32: a small seeded PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draws (Box–Muller). */
export function normal(random: () => number): () => number {
  return () => {
    const u = Math.max(1e-12, random());
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/**
 * T sessions of N stocks: r = σ (√a·m + √b·s_g + √(1 − a − b)·e). Two stocks
 * of one group then have ρ = a + b, of different groups ρ = a. Returns rows
 * (T × N) and the market factor (scaled to σ).
 */
export function factorReturns(options: { t: number; groups: number[]; a: number; b: number; sigma?: number; seed?: number }): { rows: number[][]; market: number[] } {
  const draw = normal(rng(options.seed ?? 7));
  const sigma = options.sigma ?? 0.015;
  const groupCount = Math.max(...options.groups) + 1;
  const rows: number[][] = [];
  const market: number[] = [];
  for (let i = 0; i < options.t; i += 1) {
    const m = draw();
    const sectors = Array.from({ length: groupCount }, () => draw());
    market.push(sigma * m);
    rows.push(options.groups.map((group) => sigma * (Math.sqrt(options.a) * m + Math.sqrt(options.b) * sectors[group] + Math.sqrt(1 - options.a - options.b) * draw())));
  }
  return { rows, market };
}

/** True when the symmetric matrix has a Cholesky factor (positive definite). */
export function isPositiveDefinite(matrix: readonly (readonly number[])[]): boolean {
  const n = matrix.length;
  const l = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1)
    for (let j = 0; j <= i; j += 1) {
      let sum = matrix[i][j];
      for (let k = 0; k < j; k += 1) sum -= l[i][k] * l[j][k];
      if (i === j) {
        if (!(sum > 1e-18)) return false;
        l[i][i] = Math.sqrt(sum);
      } else l[i][j] = sum / l[j][j];
    }
  return true;
}
