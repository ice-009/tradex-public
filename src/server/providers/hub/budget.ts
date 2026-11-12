import "server-only";

import { BROKER_PLANS, freshCaps, shareOfCaps, type PlanLimits, type Priority } from "@/core/ratelimit/budget";
import { lastHubStatus } from "./index";

// The broker request budget as Tradex's services see it. The Market Data Hub
// makes every broker call and keeps the budget; Tradex only reads its counters
// (GET /v1/status, cached in ./index.ts) to pace the screener's live quotes and
// the Day High/Low sweep, so it never spends more than its share of the hub's day.

/** The hub's broker plan (Standard until the hub has said otherwise). */
export function planLimits(): { name: "standard" | "prime"; limits: PlanLimits } {
  const name = lastHubStatus()?.broker.budget?.plan === "prime" ? "prime" : "standard";
  return { name, limits: BROKER_PLANS[name] };
}

/** Calls `priority` may still make today through the hub, and its per-minute allowance. */
export function budgetFor(priority: Priority): { remainingToday: number; perMinute: number } {
  const budget = lastHubStatus()?.broker.budget;
  return shareOfCaps(budget ?? freshCaps(planLimits().limits), priority);
}
