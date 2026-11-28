import { correlationOf, type RiskModel } from "./model";

// What your open trades and the plan's ideas add up to (issue #40): notional,
// ₹ at risk at the stops, by sector, beta to NIFTY, how many independent bets
// it really is, and which positions move together. Pure.
//
//   Gross risk         Σ ₹ lost if every stop is hit (the plan's own sum).
//   Correlated risk    √(rᵀ C r): the stop risks r combined through the
//                      correlations C of daily returns. Equals the gross sum
//                      when everything moves as one (ρ = 1), √Σr² when nothing
//                      does. A heuristic, not a probability: stops are hit by
//                      paths, not one day's return, but correlated paths are
//                      what make stops fall together.
//   Effective bets     (Σ r)² ÷ rᵀ C r — five bank longs at ρ 0.8 are ≈ 1.2 bets.
//   Daily σ / tail     1-day ₹ volatility √(wᵀ Σ w) on notional w, and the mean
//                      of the worst 5% of days had you held these positions
//                      through the window (historical, ignores stops: gaps go
//                      through them).
//   Beta               Σ notional × β: the ₹ a 1% NIFTY move makes or loses ×100.
//
// A pair the model can't say (a stock without enough history) is assumed
// ρ = SAME_INDUSTRY_RHO in the same industry, OTHER_RHO otherwise — roughly
// what NSE F&O stocks show — and marked as assumed.

export const SAME_INDUSTRY_RHO = 0.6;
export const OTHER_RHO = 0.3;
/**
 * Two stocks of one industry count as one cluster from this ρ up (any two
 * stocks from the `threshold` up). Shrunk 120-session correlations of NSE bank
 * pairs are ≈ 0.3–0.5 (Nov 2026: HDFCBANK–AXISBANK 0.51, ICICIBANK–KOTAKBANK
 * 0.41) against a market-wide average of ≈ 0.25, so a sector link needs a
 * lower bar than an unrelated pair.
 */
export const SECTOR_LINK_RHO = 0.3;

/** Whether two positions are in one cluster: ρ ≥ threshold, or the same industry and ρ ≥ SECTOR_LINK_RHO. */
export function linked(a: { industry: string }, b: { industry: string }, rho: number, threshold: number): boolean {
  return rho >= threshold || (Boolean(a.industry) && a.industry === b.industry && rho >= SECTOR_LINK_RHO);
}
/** Tail loss: the mean of the worst this share of the window's days. */
export const TAIL_SHARE = 0.05;

export type PositionKind = "open" | "idea";

export interface RiskPosition {
  symbol: string;
  kind: PositionKind;
  industry: string;
  qty: number;
  /** Price the exposure is measured at (live or last close; the entry for an idea). */
  price: number;
  stop: number;
  /** ₹ qty × price. */
  notional: number;
  /** ₹ lost if the stop is hit from `price` (0 once the price is at or under it). */
  risk: number;
}

/** A long position's notional and risk at its stop. */
export function riskPosition(position: Omit<RiskPosition, "notional" | "risk">): RiskPosition {
  const qty = Math.max(0, position.qty);
  return { ...position, qty, notional: qty * position.price, risk: qty * Math.max(0, position.price - position.stop) };
}

export interface PairRho {
  rho: number;
  /** The model doesn't hold one of them: the industry fallback was used. */
  assumed: boolean;
}

/** ρ of two positions' stocks: the model's, else the industry fallback. */
export function pairRho(model: RiskModel | null, a: { symbol: string; industry: string }, b: { symbol: string; industry: string }): PairRho {
  if (a.symbol === b.symbol) return { rho: 1, assumed: false };
  const rho = correlationOf(model, a.symbol, b.symbol);
  if (rho !== null) return { rho, assumed: false };
  return { rho: a.industry && a.industry === b.industry ? SAME_INDUSTRY_RHO : OTHER_RHO, assumed: true };
}

/** √(rᵀ C r) of risks `r` (₹) with correlations from `rho(i, j)`. */
export function combinedRisk(risks: readonly number[], rho: (i: number, j: number) => number): number {
  let total = 0;
  for (let i = 0; i < risks.length; i += 1) for (let j = 0; j < risks.length; j += 1) total += risks[i] * risks[j] * (i === j ? 1 : rho(i, j));
  return Math.sqrt(Math.max(0, total));
}

export interface ExposurePosition extends RiskPosition {
  /** Daily σ of the stock's returns; null when it isn't in the model. */
  vol: number | null;
  beta: number | null;
}

export interface SectorExposure {
  industry: string;
  count: number;
  notional: number;
  risk: number;
  /** Of the gross risk. */
  share: number;
}

export interface RiskCluster {
  /** Positions linked (`linked`: ρ ≥ the threshold, or same industry and ρ ≥ SECTOR_LINK_RHO), directly or through each other. */
  symbols: string[];
  grossRisk: number;
  correlatedRisk: number;
}

export interface Exposure {
  positions: ExposurePosition[];
  notional: number;
  grossRisk: number;
  correlatedRisk: number;
  /** (Σ r)² ÷ rᵀ C r; 0 with no risk. */
  effectiveBets: number;
  /** ₹ 1-day σ of the positions in the model (null when none is). */
  dailyVol: number | null;
  /** ₹ mean loss on the worst TAIL_SHARE of the window's days, as a positive number. */
  tailLoss: number | null;
  /** Σ notional × β (₹ of NIFTY-equivalent exposure); null when no position has a beta. */
  betaNotional: number | null;
  /** betaNotional ÷ capital. */
  netBeta: number | null;
  /** Largest first. */
  sectors: SectorExposure[];
  /** Clusters of two or more, most correlated risk first. */
  clusters: RiskCluster[];
  /** Correlations between the positions' stocks (one row per distinct stock, in position order). */
  matrix: { symbols: string[]; rho: number[][]; assumed: boolean[][] };
  /** Positions the model has no history for (their ρ is assumed; no σ, β or tail). */
  uncovered: string[];
}

/** The exposure of `positions` (open and planned, any mix). `threshold` links positions into clusters. */
export function portfolioExposure(positions: readonly RiskPosition[], model: RiskModel | null, options: { capital: number; threshold: number }): Exposure {
  const list = positions.filter((position) => position.qty > 0);
  const rhos = list.map((a) => list.map((b) => pairRho(model, a, b)));
  const risks = list.map((position) => position.risk);
  const grossRisk = risks.reduce((sum, value) => sum + value, 0);
  const correlatedRisk = combinedRisk(risks, (i, j) => rhos[i][j].rho);
  const notional = list.reduce((sum, position) => sum + position.notional, 0);
  const inModel = (symbol: string) => Boolean(model && model.index[symbol] !== undefined);

  // ₹ daily σ on notional, and the historical tail, over the positions the model holds.
  const held = list.filter((position) => inModel(position.symbol));
  let dailyVol: number | null = null;
  let tailLoss: number | null = null;
  if (model && held.length) {
    let variance = 0;
    for (const a of held) for (const b of held) variance += a.notional * b.notional * model.cov[model.index[a.symbol]][model.index[b.symbol]];
    dailyVol = Math.sqrt(Math.max(0, variance));
    const days = model.sessions;
    const pnl = Array.from({ length: days }, (_, t) => held.reduce((sum, position) => sum + position.notional * (Math.exp(model.returns[position.symbol][t]) - 1), 0)).sort((a, b) => a - b);
    const worst = pnl.slice(0, Math.max(1, Math.ceil(days * TAIL_SHARE)));
    tailLoss = Math.max(0, -worst.reduce((sum, value) => sum + value, 0) / worst.length);
  }

  const withBeta = list.filter((position) => model?.beta[position.symbol] != null);
  const betaNotional = withBeta.length ? withBeta.reduce((sum, position) => sum + position.notional * (model!.beta[position.symbol] as number), 0) : null;

  const bySector = new Map<string, SectorExposure>();
  for (const position of list) {
    const industry = position.industry || "Other";
    const entry = bySector.get(industry) ?? { industry, count: 0, notional: 0, risk: 0, share: 0 };
    entry.count += 1;
    entry.notional += position.notional;
    entry.risk += position.risk;
    bySector.set(industry, entry);
  }
  const sectors = [...bySector.values()].map((entry) => ({ ...entry, share: grossRisk > 0 ? entry.risk / grossRisk : 0 })).sort((a, b) => b.risk - a.risk || b.notional - a.notional);

  // Single-linkage clusters on ρ ≥ threshold.
  const parent = list.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) if (linked(list[i], list[j], rhos[i][j].rho, options.threshold)) parent[find(i)] = find(j);
  const groups = new Map<number, number[]>();
  list.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  const clusters = [...groups.values()]
    .filter((members) => new Set(members.map((i) => list[i].symbol)).size > 1)
    .map((members) => ({
      symbols: [...new Set(members.map((i) => list[i].symbol))],
      grossRisk: members.reduce((sum, i) => sum + risks[i], 0),
      correlatedRisk: combinedRisk(
        members.map((i) => risks[i]),
        (a, b) => rhos[members[a]][members[b]].rho,
      ),
    }))
    .sort((a, b) => b.correlatedRisk - a.correlatedRisk);

  const distinct: RiskPosition[] = [];
  for (const position of list) if (!distinct.some((entry) => entry.symbol === position.symbol)) distinct.push(position);
  const cells = distinct.map((a) => distinct.map((b) => pairRho(model, a, b)));

  return {
    positions: list.map((position) => ({ ...position, vol: inModel(position.symbol) ? model!.vol[position.symbol] : null, beta: model?.beta[position.symbol] ?? null })),
    notional,
    grossRisk,
    correlatedRisk,
    effectiveBets: correlatedRisk > 0 ? grossRisk ** 2 / correlatedRisk ** 2 : 0,
    dailyVol,
    tailLoss,
    betaNotional,
    netBeta: betaNotional !== null && options.capital > 0 ? betaNotional / options.capital : null,
    sectors,
    clusters,
    matrix: { symbols: distinct.map((entry) => entry.symbol), rho: cells.map((row) => row.map((cell) => cell.rho)), assumed: cells.map((row) => row.map((cell) => cell.assumed)) },
    uncovered: [...new Set(list.filter((position) => !inModel(position.symbol)).map((position) => position.symbol))],
  };
}
