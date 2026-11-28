import { combinedRisk, linked, pairRho, type PositionKind } from "./exposure";
import type { RiskModel } from "./model";

// Correlation-aware sizing (issue #40): five bank longs are one bet, not five.
// The daily plan (src/core/plan/builder.ts) sizes each idea at the risk per
// trade; with this on, an idea that moves with what you already hold or plan
// to take is cut so its cluster's correlated risk stays under a budget. Pure.
//
//   Peers      the open trades and the plan's ideas already sized (in rank
//              order) whose correlation with the idea is ≥ `threshold`, or
//              ≥ 0.3 in the same industry (exposure.ts `linked`) — the model's
//              ρ (shrunk, 120 sessions), or for a stock without history the
//              industry fallback (same industry 0.6, else 0.3).
//   Cluster    the idea, its peers, and whatever is linked to them in turn
//              (the same single-linkage clusters the exposure view shows), so
//              a bank linked to two of four banks held still counts against
//              all four. Its correlated risk is √(rᵀ C r) of the ₹ risks at
//              the stops (exposure.ts).
//   Budget     `maxCorrelatedRisk` × the risk per trade. The idea's ₹ risk x
//              may go up to the root of  x² + 2x·Σ ρ_k r_k + rᵀC r = budget²
//              (C and ρ_k over the rest of the cluster): whole lots under
//              that; none → skipped.
//
// With budget 2× and ρ ≈ 0.8, two full-size trades fit in a cluster (√3.6 ≈
// 1.9 R) and a third gets ≈ 0.1 R (usually no lot). At ρ 0.45 — two NSE banks
// over the last six months — two fit (1.7 R), a third gets ≈ 0.5 R and a
// fourth nothing: five bank longs carry about 2 R, not 5. Ideas that aren't
// linked to anything are never touched, and the cap only ever lowers lots.

export interface CorrelationSettings {
  /** Cluster budget as a multiple of the risk per trade. */
  maxCorrelatedRisk: number;
  /** ρ at or above which any two positions count as one cluster (same-industry pairs from SECTOR_LINK_RHO). */
  threshold: number;
}

/** Off unless switched on in the plan settings (see the PR for why); these are the values it starts from. */
export const DEFAULT_CORRELATION_SETTINGS: CorrelationSettings = { maxCorrelatedRisk: 2, threshold: 0.5 };

export interface BookEntry {
  symbol: string;
  industry: string;
  kind: PositionKind;
  /** ₹ lost at its stop. */
  risk: number;
}

export interface CorrelatedPeer {
  symbol: string;
  kind: PositionKind;
  rho: number;
  /** No price history for one of them: the industry fallback. */
  assumed: boolean;
}

export interface CorrelationCut {
  lotsBefore: number;
  lotsAfter: number;
  /** Linked to the idea directly, most correlated first. */
  peers: CorrelatedPeer[];
  /** The rest of the cluster (linked to it through a peer). */
  cluster: string[];
  /** ₹ correlated risk of the rest of the cluster on its own, and with the idea at `lotsAfter`. */
  peersRisk: number;
  clusterRisk: number;
  /** ₹ the cluster may carry. */
  budget: number;
  /** "1 lot instead of 2: 0.82 correlated with your open HDFCBANK". */
  text: string;
}

const lotsWord = (n: number) => `${n} lot${n === 1 ? "" : "s"}`;
const peerName = (peer: CorrelatedPeer) => `${peer.kind === "open" ? "your open" : "the plan's"} ${peer.symbol}`;

function cutText(lotsBefore: number, lotsAfter: number, peers: readonly CorrelatedPeer[], extra: number): string {
  const [top, ...rest] = peers;
  const how = top.assumed ? `same industry as ${peerName(top)} (no price history to measure, assumed ρ ${top.rho.toFixed(2)})` : `${top.rho.toFixed(2)} correlated with ${peerName(top)}`;
  const others = rest.length + extra;
  const more = others ? ` and ${others} more` : "";
  return lotsAfter > 0 ? `${lotsWord(lotsAfter)} instead of ${lotsBefore}: ${how}${more}` : `Skipped: ${how}${more}, already at the correlated-risk budget`;
}

/**
 * How many of `lots` lots (each losing `oneLotRisk` ₹ at the stop) fit beside
 * `book` under the cluster budget; null when nothing in the book is a peer or
 * the budget doesn't bind (the idea keeps its lots).
 */
export function correlationCut(
  idea: { symbol: string; industry: string; lots: number; oneLotRisk: number },
  book: readonly BookEntry[],
  riskBudget: number,
  settings: CorrelationSettings,
  model: RiskModel | null,
): CorrelationCut | null {
  if (!(idea.lots > 0) || !(idea.oneLotRisk > 0)) return null;
  const peers = book
    .map((entry) => ({ entry, ...pairRho(model, idea, entry) }))
    .filter((peer) => peer.entry.risk > 0 && linked(idea, peer.entry, peer.rho, settings.threshold))
    .sort((a, b) => b.rho - a.rho || b.entry.risk - a.entry.risk);
  if (!peers.length) return null;
  // Grow the cluster through links between book entries.
  const members = peers.map((peer) => peer.entry);
  for (let i = 0; i < members.length; i += 1) {
    for (const entry of book) {
      if (entry.risk > 0 && !members.includes(entry) && linked(members[i], entry, pairRho(model, members[i], entry).rho, settings.threshold)) members.push(entry);
    }
  }
  const budget = Math.max(0, settings.maxCorrelatedRisk) * riskBudget;
  const peersRisk = combinedRisk(
    members.map((entry) => entry.risk),
    (i, j) => pairRho(model, members[i], members[j]).rho,
  );
  const linear = members.reduce((sum, entry) => sum + pairRho(model, idea, entry).rho * entry.risk, 0);
  const room = budget ** 2 - peersRisk ** 2;
  const maxRisk = room > 0 ? -linear + Math.sqrt(linear ** 2 + room) : 0;
  const lotsAfter = Math.max(0, Math.min(idea.lots, Math.floor(maxRisk / idea.oneLotRisk + 1e-9)));
  if (lotsAfter >= idea.lots) return null;
  const x = lotsAfter * idea.oneLotRisk;
  const list: CorrelatedPeer[] = peers.map((peer) => ({ symbol: peer.entry.symbol, kind: peer.entry.kind, rho: peer.rho, assumed: peer.assumed }));
  return {
    lotsBefore: idea.lots,
    lotsAfter,
    peers: list,
    cluster: [...new Set(members.slice(peers.length).map((entry) => entry.symbol))],
    peersRisk,
    clusterRisk: Math.sqrt(Math.max(0, peersRisk ** 2 + 2 * x * linear + x * x)),
    budget,
    text: cutText(idea.lots, lotsAfter, list, members.length - peers.length),
  };
}
