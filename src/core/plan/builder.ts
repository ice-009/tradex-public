import { SCREEN_MAP, type ScreenerRow } from "@/core/screener/screens";
import { bucketFor, eligibleIn, type MarketState, type ScreenEvidence } from "./evidence";
import { entryKind, entryText, exitRuleFor, exitText, holdSessionsFor, type EntryKind, type ExitRule } from "./instructions";

// The daily trade plan: which of today's screener matches to take, how many
// lots, and how to get in and out. Pure.
//
//   1. Candidates are today's matches of screens that PASS the evidence rule
//      in the current market state (NIFTY above / below its 200-day average).
//   2. One idea per stock: the eligible match with the highest expected net R.
//   3. Ranked by that expected R (the screen's 5-year mean in this state). A
//      screen's score breaks ties between its own signals only where the
//      evidence says the score picks better trades; elsewhere it is noise, so
//      ties stay in symbol order.
//   4. F&O-ban stocks and stocks already held are left out (and listed).
//   5. Free slots = max open − open trades. Each idea is sized at risk % of
//      capital ÷ (entry − stop), in whole lots, under a cap on total notional
//      (leverage × capital, as the backtester does). An idea whose single lot
//      risks more than the budget is kept aside as "too big for your risk"
//      (shown, not hidden) and doesn't take a slot; the plan keeps going until
//      the slots are filled.

export interface PlanSettings {
  /** Trading capital, ₹. */
  capital: number;
  /** % of capital risked per trade (entry − stop × quantity). */
  riskPct: number;
  maxOpen: number;
  /** Total open notional ≤ capital × this (stock-futures margin is ~20–25% of notional). */
  maxLeverage: number;
}

export const DEFAULT_PLAN_SETTINGS: PlanSettings = { capital: 500_000, riskPct: 1, maxOpen: 5, maxLeverage: 4 };

export interface OpenPosition {
  symbol: string;
  /** Entry price × quantity, ₹. */
  notional: number;
}

export interface PlanInput {
  results: Record<string, ScreenerRow[]>;
  evidence: Record<string, ScreenEvidence>;
  state: MarketState | null;
  banned: ReadonlySet<string>;
  open: OpenPosition[];
  lots: Record<string, number>;
  settings: PlanSettings;
}

export type SizeStatus = "ok" | "too-big" | "no-room";

export interface PlanSize {
  status: SizeStatus;
  lot: number;
  lots: number;
  qty: number;
  /** ₹ lost at the stop with this size. */
  risk: number;
  notional: number;
  /** ₹ one lot loses at the stop (why "too big"). */
  oneLotRisk: number;
}

export interface PlanIdea {
  symbol: string;
  name: string;
  screenId: string;
  row: ScreenerRow;
  /** The screen's mean net R per trade in this market state (5-year replay). */
  expectedR: number;
  /** Last 12 months, all market states. */
  recentR: number | null;
  recentN: number;
  /** Trades behind expectedR. */
  sampleN: number;
  entry: { kind: EntryKind; price: number; text: string };
  stop: number;
  target: number | null;
  exitRule: ExitRule;
  exitText: string;
  holdSessions: number;
  size: PlanSize;
  /** Other eligible screens the stock matched today. */
  alsoMatched: string[];
  /** The score ordered this screen's ties (it ranks trades in the evidence). */
  scoreRanks: boolean;
}

export interface Plan {
  state: MarketState | null;
  riskBudget: number;
  openCount: number;
  freeSlots: number;
  /** Screens allowed in this state, best expected R first. */
  eligible: string[];
  /** The trades to take, in rank order: at most one per free slot. */
  ideas: PlanIdea[];
  /** Ideas ranked among them that can't be sized: one lot risks more than the budget, or no room under the leverage cap. */
  unsized: PlanIdea[];
  /** Sizeable ideas left over once the slots were full. */
  more: PlanIdea[];
  skipped: { banned: string[]; held: string[]; noLot: string[] };
}

function sizeIdea(entry: number, stop: number, lot: number, budget: number, room: number): PlanSize {
  const perShare = entry - stop;
  const oneLotRisk = perShare * lot;
  let lots = Math.floor(budget / oneLotRisk);
  if (lots < 1) return { status: "too-big", lot, lots: 0, qty: 0, risk: 0, notional: 0, oneLotRisk };
  if (lots * lot * entry > room) lots = Math.floor(room / (lot * entry));
  if (lots < 1) return { status: "no-room", lot, lots: 0, qty: 0, risk: 0, notional: 0, oneLotRisk };
  const qty = lots * lot;
  return { status: "ok", lot, lots, qty, risk: qty * perShare, notional: qty * entry, oneLotRisk };
}

export function buildPlan(input: PlanInput): Plan {
  const { results, evidence, state, banned, open, lots, settings } = input;
  const held = new Set(open.map((position) => position.symbol));
  const riskBudget = (settings.capital * settings.riskPct) / 100;
  const freeSlots = Math.max(0, Math.round(settings.maxOpen) - open.length);
  const eligible = Object.values(evidence)
    .filter((entry) => SCREEN_MAP[entry.screenId] && eligibleIn(entry, state))
    .sort((a, b) => (bucketFor(b, state).mean ?? 0) - (bucketFor(a, state).mean ?? 0))
    .map((entry) => entry.screenId);

  // One candidate per stock: its eligible match with the highest expected R.
  const best = new Map<string, { screenId: string; row: ScreenerRow; expectedR: number; others: string[] }>();
  for (const screenId of eligible) {
    const expectedR = bucketFor(evidence[screenId], state).mean ?? 0;
    for (const row of results[screenId] ?? []) {
      if (!(row.plan.entry - row.plan.stop > 0)) continue;
      const current = best.get(row.symbol);
      if (!current) best.set(row.symbol, { screenId, row, expectedR, others: [] });
      else current.others.push(screenId); // `eligible` is sorted best first, so the first match stays
    }
  }

  const skipped = { banned: [] as string[], held: [] as string[], noLot: [] as string[] };
  const candidates: PlanIdea[] = [];
  for (const [symbol, { screenId, row, expectedR, others }] of best) {
    if (banned.has(symbol)) {
      skipped.banned.push(symbol);
      continue;
    }
    if (held.has(symbol)) {
      skipped.held.push(symbol);
      continue;
    }
    if (!(lots[symbol] > 0)) {
      skipped.noLot.push(symbol);
      continue;
    }
    const screen = SCREEN_MAP[screenId];
    const bucket = bucketFor(evidence[screenId], state);
    const kind = entryKind(screen, row.plan, row.close);
    const rule = exitRuleFor(screen, row.plan);
    const hold = holdSessionsFor(screen);
    candidates.push({
      symbol,
      name: row.name,
      screenId,
      row,
      expectedR,
      recentR: evidence[screenId].all.recent.mean,
      recentN: evidence[screenId].all.recent.n,
      sampleN: bucket.n,
      entry: { kind, price: row.plan.entry, text: entryText(kind, row.plan.entry) },
      stop: row.plan.stop,
      target: row.plan.target,
      exitRule: rule,
      exitText: exitText(rule, row.plan, hold),
      holdSessions: hold,
      size: { status: "ok", lot: lots[symbol], lots: 0, qty: 0, risk: 0, notional: 0, oneLotRisk: 0 },
      alsoMatched: others,
      scoreRanks: Boolean(bucket.score?.ranks),
    });
  }
  candidates.sort(
    (a, b) =>
      b.expectedR - a.expectedR ||
      (a.screenId === b.screenId && a.scoreRanks ? b.row.score - a.row.score : 0) ||
      a.symbol.localeCompare(b.symbol),
  );

  let room = settings.capital * settings.maxLeverage - open.reduce((sum, position) => sum + position.notional, 0);
  let taken = 0;
  const ideas: PlanIdea[] = [];
  const unsized: PlanIdea[] = [];
  const more: PlanIdea[] = [];
  for (const idea of candidates) {
    idea.size = sizeIdea(idea.entry.price, idea.stop, idea.size.lot, riskBudget, Math.max(0, room));
    if (taken >= freeSlots) {
      if (idea.size.status === "ok") more.push(idea);
    } else if (idea.size.status !== "ok") {
      unsized.push(idea);
    } else {
      ideas.push(idea);
      taken += 1;
      room -= idea.size.notional;
    }
  }
  for (const list of Object.values(skipped)) list.sort();
  return { state, riskBudget, openCount: open.length, freeSlots, eligible, ideas, unsized, more, skipped };
}
