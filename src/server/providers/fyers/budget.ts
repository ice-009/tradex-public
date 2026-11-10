import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync, writeFile } from "node:fs";
import path from "node:path";
import { istDayKey } from "@/core/market/session";
import { FYERS_PLANS, RateBudget, emptyBudgetState, type BudgetSnapshot, type PlanLimits, type Priority } from "@/core/ratelimit/budget";

// The one gate every Fyers Data API call goes through (see src/core/ratelimit/budget.ts
// for the policy). Day counters are saved to .cache so a server restart doesn't
// forget what was already spent today.
//
// Priority travels with the async call chain: wrap background work in
// `asPriority("background", () => ...)` and every Fyers call inside it is
// counted and throttled as background. Anything unwrapped counts as "user".

const STATE_FILE = path.join(process.cwd(), ".cache", "fyers-usage.json");
const SAVE_DEBOUNCE_MS = 2_000;

export class BudgetExhaustedError extends Error {
  constructor(priority: Priority) {
    super(`Fyers daily data budget for ${priority} requests is used up`);
    this.name = "BudgetExhaustedError";
  }
}

export function fyersPlan(): { name: "standard" | "prime"; limits: PlanLimits } {
  const name = process.env.FYERS_PLAN?.toLowerCase() === "prime" ? "prime" : "standard";
  return { name, limits: FYERS_PLANS[name] };
}

function load(): RateBudget {
  const today = istDayKey();
  let state = emptyBudgetState(today);
  let recentDone: number[] = [];
  try {
    const { recentDone: savedRecent, ...saved } = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (saved?.day === today && typeof saved.usedToday === "number") state = { ...state, ...saved };
    // Calls answered within the last minute before a restart still count against Fyers' windows.
    if (Array.isArray(savedRecent)) recentDone = savedRecent.filter((time: unknown) => typeof time === "number" && Date.now() - time < 60_000);
  } catch {
    // first run, or an unreadable file: start the day at zero
  }
  return new RateBudget(fyersPlan().limits, state, istDayKey, recentDone);
}

const globalForBudget = globalThis as unknown as { fyersBudget?: RateBudget; fyersBudgetSave?: ReturnType<typeof setTimeout> | null };

/**
 * The budget, built on first use (not on import): with a Market Data Hub
 * configured, Tradex never calls Fyers, so this is never constructed.
 */
function getBudget(): RateBudget {
  // A hot reload that changes the RateBudget class must not keep an old-shaped instance.
  if (!(globalForBudget.fyersBudget instanceof RateBudget) || typeof globalForBudget.fyersBudget.finish !== "function") globalForBudget.fyersBudget = load();
  return globalForBudget.fyersBudget;
}

function scheduleSave() {
  if (globalForBudget.fyersBudgetSave) return;
  globalForBudget.fyersBudgetSave = setTimeout(() => {
    globalForBudget.fyersBudgetSave = null;
    try {
      mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    } catch {
      // exists
    }
    const budget = getBudget();
    writeFile(STATE_FILE, JSON.stringify({ ...budget.state, recentDone: budget.recentDone(Date.now()) }), () => {});
  }, SAVE_DEBOUNCE_MS);
}

const priorityContext = new AsyncLocalStorage<Priority>();

/** Run `fn` with every Fyers call inside it counted as `priority`. */
export function asPriority<T>(priority: Priority, fn: () => Promise<T>): Promise<T> {
  return priorityContext.run(priority, fn);
}

export function currentPriority(): Priority {
  return priorityContext.getStore() ?? "user";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a slot for one call at the current priority, then count it. Call the
 * returned function when the response (or an error) arrives: the call keeps its
 * slot until then, plus the window length, so network delays can't bunch calls up
 * at Fyers' end. Throws BudgetExhaustedError when the day's share is spent.
 */
export async function acquireFyersSlot(): Promise<() => void> {
  const priority = currentPriority();
  const budget = getBudget();
  waiting[priority] += 1;
  try {
    for (;;) {
      const now = Date.now();
      const decision = budget.check(priority, now);
      // A free slot goes to the most important caller waiting: a chart you opened
      // is served before the watchlist refresh, which goes before background scans.
      if (decision.ok && !higherWaiting(priority)) {
        const slot = budget.record(priority, now);
        scheduleSave();
        return () => {
          budget.finish(slot, Date.now());
          scheduleSave();
        };
      }
      if (!decision.ok && "denied" in decision) throw new BudgetExhaustedError(priority);
      await sleep(decision.ok ? 25 : Math.max(20, decision.waitMs));
    }
  } finally {
    waiting[priority] -= 1;
  }
}

/** Callers currently queued for a slot, per priority. */
const waiting: Record<Priority, number> = { user: 0, refresh: 0, background: 0 };
const RANK: Record<Priority, number> = { user: 0, refresh: 1, background: 2 };
const higherWaiting = (priority: Priority) => (Object.keys(waiting) as Priority[]).some((other) => RANK[other] < RANK[priority] && waiting[other] > 0);

/** Fyers answered 429: pause all calls until the minute clears (a 4th strike in a day blocks the account). */
export function reportRateLimited() {
  const budget = getBudget();
  budget.rateLimited(Date.now());
  scheduleSave();
  console.warn(
    `Fyers returned 429 — pausing data calls for a minute; strike ${budget.state.strikes} today, running at ${budget.secondCap}/s and ${budget.minuteCap}/min for the rest of the day.`,
  );
}

export function budgetSnapshot(): BudgetSnapshot & { plan: "standard" | "prime"; coolingDown: boolean } {
  const now = Date.now();
  const snapshot = getBudget().snapshot(now);
  return { ...snapshot, plan: fyersPlan().name, coolingDown: snapshot.cooldownUntil > now };
}

/** Calls `priority` may still make today, and its per-minute allowance. */
export function budgetFor(priority: Priority) {
  const budget = getBudget();
  return { remainingToday: budget.remainingToday(priority, Date.now()), perMinute: budget.minuteShare(priority) };
}
