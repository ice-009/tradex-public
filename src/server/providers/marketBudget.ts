import "server-only";

import { FYERS_PLANS, HEADROOM, shareOfCaps, type PlanLimits, type Priority } from "@/core/ratelimit/budget";
import * as fyersBudget from "@/server/providers/fyers/budget";
import { hubMode, lastHubStatus } from "@/server/providers/hub";

// The broker request budget as the rest of the app sees it, whoever talks to
// the broker:
//  - standalone: Tradex's own Fyers budget (./fyers/budget.ts);
//  - with a Market Data Hub: the hub owns the broker and its budget. Nothing of
//    Tradex's Fyers budget is built or called; pacing (screener quotes, the
//    high/low sweep) follows the hub's counters from its /v1/status.

export type MarketDataVia = "hub" | "fyers";

export const marketDataVia = (): MarketDataVia => (hubMode() ? "hub" : "fyers");

/** Run `fn` with every broker call inside it counted as `priority` (no-op with a hub: it prioritises its own calls). */
export function asPriority<T>(priority: Priority, fn: () => Promise<T>): Promise<T> {
  return hubMode() ? fn() : fyersBudget.asPriority(priority, fn);
}

/** The broker plan's limits: the hub's plan with a hub, else FYERS_PLAN. */
export function planLimits(): { name: "standard" | "prime"; limits: PlanLimits } {
  if (!hubMode()) return fyersBudget.fyersPlan();
  const name = lastHubStatus()?.broker.budget?.plan === "prime" ? "prime" : "standard";
  return { name, limits: FYERS_PLANS[name] };
}

/** Calls `priority` may still make today, and its per-minute allowance. */
export function budgetFor(priority: Priority): { remainingToday: number; perMinute: number } {
  if (!hubMode()) return fyersBudget.budgetFor(priority);
  const budget = lastHubStatus()?.broker.budget;
  if (budget) return shareOfCaps(budget, priority);
  // Not heard from the hub yet: assume a fresh Standard day.
  const limits = FYERS_PLANS.standard;
  return shareOfCaps({ dayCap: Math.floor(limits.perDay * HEADROOM.day), usedToday: 0, minuteCap: Math.floor(limits.perMinute * HEADROOM.minute) }, priority);
}
