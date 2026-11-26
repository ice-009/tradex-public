import { SCREENS } from "@/core/screener/screens";
import type { Plan, PlanSettings } from "./builder";
import { MIN_T, MIN_TRADES, bucketFor, type MarketState, type ScreenEvidence } from "./evidence";

// Why today's plan is short or empty, in numbers. Pure; the rules themselves
// are in builder.ts (sizing) and evidence.ts (which screens may trade).

/** The most the plan settings accept as risk per trade, %. */
export const MAX_RISK_PCT = 5;
const CAPITAL_STEP = 10_000;
const RISK_STEP = 0.1;

/** Round up to a step, ignoring floating-point dust (1.8000000002 → 1.8). */
const ceilTo = (value: number, step: number) => Math.ceil(value / step - 1e-9) * step;

/** ₹ in lakh / crore, as traders say it: ₹9L, ₹11.5L, ₹1.2Cr. */
export function lakhs(value: number): string {
  const trim = (n: number) => n.toFixed(2).replace(/\.?0+$/, "");
  return value >= 1e7 ? `₹${trim(value / 1e7)}Cr` : `₹${trim(value / 1e5)}L`;
}

export interface SizeHint {
  symbol: string;
  screenId: string;
  lot: number;
  /** ₹ one lot loses at its stop. */
  oneLotRisk: number;
  /** ₹ of one lot at the entry. */
  lotNotional: number;
  /** Smallest capital (rounded up to ₹10,000) at which one lot fits, at the current risk % and leverage cap. */
  capital: number;
  /** Smallest risk % (rounded up to 0.1) at which one lot fits on the current capital; null when that's over MAX_RISK_PCT or the leverage cap stops it anyway. */
  riskPct: number | null;
}

/**
 * For a plan whose matches are all too big to size: the match that needs the
 * least change to fit one lot, and what that change is. Null when nothing is
 * unsized.
 */
export function sizeHint(plan: Pick<Plan, "unsized" | "openNotional">, settings: PlanSettings): SizeHint | null {
  let best: SizeHint | null = null;
  for (const idea of plan.unsized) {
    const { lot, oneLotRisk } = idea.size;
    if (!(lot > 0) || !(oneLotRisk > 0)) continue;
    const lotNotional = lot * idea.entry.price;
    const needsNotional = (lotNotional + plan.openNotional) / settings.maxLeverage;
    const capital = ceilTo(Math.max((oneLotRisk * 100) / settings.riskPct, needsNotional), CAPITAL_STEP);
    const pct = ceilTo((oneLotRisk / settings.capital) * 100, RISK_STEP);
    const riskPct = pct <= MAX_RISK_PCT && needsNotional <= settings.capital ? Math.round(pct * 10) / 10 : null;
    const hint = { symbol: idea.symbol, screenId: idea.screenId, lot, oneLotRisk, lotNotional, capital, riskPct };
    if (!best || capital < best.capital || (capital === best.capital && oneLotRisk < best.oneLotRisk)) best = hint;
  }
  return best;
}

/**
 * Why a screen isn't in the plan, by the evidence rule (evidence.ts) in this
 * market state:
 *   few          fewer than MIN_TRADES signals
 *   lost-lately  made money in its first 60% of signals, lost in the last 40%
 *   lost-early   lost in the first 60%, made money only in the last 40% (needs both)
 *   lost         lost money in both parts
 *   noisy        made money in both parts, but the t-stat isn't over MIN_T
 *   one-state    passes in one market state only, and the state is unknown
 */
export type ExclusionReason = "few" | "lost-lately" | "lost-early" | "lost" | "noisy" | "one-state";

export interface Exclusion {
  id: string;
  name: string;
  reason: ExclusionReason;
  n: number;
  mean: number | null;
  first: number | null;
  last: number | null;
  t: number | null;
  /** First signal day of the last 40%. */
  splitDate: number | null;
  /** Last 12 months, in this state. */
  recent: number | null;
}

export const EXCLUSION_ORDER: ExclusionReason[] = ["lost-lately", "noisy", "lost-early", "few", "one-state", "lost"];

/** Every screen the plan leaves out in this state and why, grouped by reason (EXCLUSION_ORDER), best record first within a group. */
export function excludedScreens(screens: Record<string, ScreenEvidence>, state: MarketState | null, eligible: readonly string[]): Exclusion[] {
  const out: Exclusion[] = [];
  for (const screen of SCREENS) {
    const evidence = screens[screen.id];
    if (!evidence || eligible.includes(screen.id)) continue;
    const bucket = bucketFor(evidence, state);
    const first = bucket.first.mean;
    const last = bucket.last.mean;
    const firstUp = (first ?? 0) > 0;
    const lastUp = (last ?? 0) > 0;
    const reason: ExclusionReason =
      bucket.n < MIN_TRADES
        ? "few"
        : firstUp && !lastUp
          ? "lost-lately"
          : !firstUp && lastUp
            ? "lost-early"
            : !firstUp && !lastUp
              ? "lost"
              : bucket.t === null || bucket.t <= MIN_T
                ? "noisy"
                : "one-state";
    out.push({ id: screen.id, name: screen.name, reason, n: bucket.n, mean: bucket.mean, first, last, t: bucket.t, splitDate: bucket.splitDate, recent: bucket.recent?.mean ?? null });
  }
  return out.sort((a, b) => EXCLUSION_ORDER.indexOf(a.reason) - EXCLUSION_ORDER.indexOf(b.reason) || (b.mean ?? 0) - (a.mean ?? 0));
}
