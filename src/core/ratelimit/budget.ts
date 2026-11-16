// Pacing work against the broker request budget a Market Data Hub keeps.
//
// The hub is the only process that talks to the broker; it counts every call
// and reports its counters in GET /v1/status (`broker.budget`). Tradex asks the
// hub for quotes on behalf of the screener's live refresh and the Day High/Low
// sweep, and paces those requests from what is left of the hub's day, so one
// Tradex can't spend the budget every other app on the hub shares.
//
// The broker's data-API limits (from 16 Oct 2026):
//   Standard:   5 / second,  50 / minute,    5,000 / day; 50 symbols per quote call;  100 socket symbols
//   Prime:     10 / second, 500 / minute, 5,00,000 / day; 1,000 symbols per quote call; 5,000 socket symbols
//
// Callers ask by priority:
//   user        — something the person just asked for (open a chart, search, order ticket)
//   refresh     — keeping visible things current (watchlist, alerts)
//   background  — scans and sweeps nobody is waiting on (high/low scan, screener)
// Lower priorities may use only a share of each window, so a background sweep can
// never starve a chart. Pure: no I/O.

export type Priority = "user" | "refresh" | "background";

export interface PlanLimits {
  perSecond: number;
  perMinute: number;
  perDay: number;
  /** Symbols per quotes request. */
  quoteBatch: number;
  /** Symbols across all data-socket connections. */
  socketSymbols: number;
}

/** The broker plans a hub can run on (its /v1/status says which). */
export const BROKER_PLANS: Record<"standard" | "prime", PlanLimits> = {
  standard: { perSecond: 5, perMinute: 50, perDay: 5_000, quoteBatch: 50, socketSymbols: 100 },
  prime: { perSecond: 10, perMinute: 500, perDay: 500_000, quoteBatch: 1_000, socketSymbols: 5_000 },
};

/** Fraction of each official limit the hub allows itself (its caps when it hasn't reported them yet). */
export const HEADROOM = { second: 0.6, minute: 0.8, day: 0.95 };

/** Share of the (headroom-adjusted) minute and day windows each priority may fill. */
export const PRIORITY_SHARE: Record<Priority, { minute: number; day: number }> = {
  user: { minute: 1, day: 1 },
  refresh: { minute: 0.75, day: 0.85 },
  background: { minute: 0.5, day: 0.7 },
};

/** The hub's broker budget as the top bar shows it. */
export interface BudgetSnapshot {
  limits: PlanLimits;
  day: number;
  usedToday: number;
  /** The hub's daily ceiling (limits.perDay × headroom). */
  dayCap: number;
  usedThisMinute: number;
  minuteCap: number;
  /** Calls waiting for a response right now. */
  inFlight: number;
  /** True after a 429 today: the hub runs slower for the rest of the day. */
  slowed: boolean;
  byPriority: Record<Priority, number>;
  strikes: number;
  cooldownUntil: number;
}

/**
 * How often a background sweep of `requestsPerSweep` calls can run so that it
 * (a) fits its share of the per-minute window, leaving room for other background
 * work, and (b) spreads the remaining daily budget over the rest of the session.
 * Returns null when the day's budget can't pay for another sweep.
 */
export function sweepIntervalMs(params: {
  requestsPerSweep: number;
  /** Background calls still available today. */
  remainingToday: number;
  /** Minutes until the session (or the period the sweep must last) ends. */
  minutesLeft: number;
  /** Calls per minute background work may make. */
  backgroundPerMinute: number;
  /** Fraction of the background allowance this sweep may take (the rest is for other background work). */
  shareOfBackground?: number;
  minMs?: number;
}): number | null {
  const { requestsPerSweep, remainingToday, minutesLeft, backgroundPerMinute, shareOfBackground = 0.6, minMs = 20_000 } = params;
  const usable = remainingToday * shareOfBackground;
  if (requestsPerSweep < 1) return minMs;
  if (usable < requestsPerSweep) return null;
  const byMinute = (requestsPerSweep / (backgroundPerMinute * shareOfBackground)) * 60_000;
  const sweepsLeft = Math.floor(usable / requestsPerSweep);
  const byDay = (Math.max(1, minutesLeft) * 60_000) / sweepsLeft;
  return Math.round(Math.max(minMs, byMinute, byDay));
}

/**
 * A priority's remaining calls today and per-minute allowance, from the hub's
 * budget counters (its /v1/status).
 */
export function shareOfCaps(caps: { dayCap: number; usedToday: number; minuteCap: number }, priority: Priority): { remainingToday: number; perMinute: number } {
  return {
    remainingToday: Math.max(0, Math.floor(caps.dayCap * PRIORITY_SHARE[priority].day) - caps.usedToday),
    perMinute: Math.max(1, Math.floor(caps.minuteCap * PRIORITY_SHARE[priority].minute)),
  };
}

/** The caps of a fresh day on `plan`, for before the hub has reported its own. */
export function freshCaps(plan: PlanLimits): { dayCap: number; usedToday: number; minuteCap: number } {
  return { dayCap: Math.floor(plan.perDay * HEADROOM.day), usedToday: 0, minuteCap: Math.floor(plan.perMinute * HEADROOM.minute) };
}
