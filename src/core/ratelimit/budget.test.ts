import { describe, expect, it } from "vitest";
import { COOLDOWN_MS, FYERS_PLANS, RateBudget, emptyBudgetState, sweepIntervalMs, type Priority } from "./budget";

const DAY = 86_400_000;
const dayOf = (time: number) => Math.floor(time / DAY) * DAY;
const fresh = () => new RateBudget(FYERS_PLANS.standard, emptyBudgetState(0), dayOf);

/** Send as many calls as the budget allows at one instant; each answers `latency` ms later. */
function burst(budget: RateBudget, priority: Priority, at: number, latency = 0) {
  let sent = 0;
  while (budget.check(priority, at).ok) {
    const slot = budget.record(priority, at);
    budget.finish(slot, at + latency);
    sent += 1;
  }
  return sent;
}

/**
 * Simulate callers hammering the budget with random network latency, and record when
 * each call *reaches the server* (anywhere between send and response). Returns arrival times.
 */
function simulate(budget: RateBudget, durationMs: number, seed = 7) {
  let rnd = seed;
  const random = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
  const arrivals: number[] = [];
  const inFlight: Array<{ slot: ReturnType<RateBudget["record"]>; doneAt: number }> = [];
  for (let now = 0; now < durationMs; now += 10) {
    for (const call of inFlight.filter((entry) => entry.doneAt <= now)) budget.finish(call.slot, call.doneAt);
    inFlight.splice(0, inFlight.length, ...inFlight.filter((entry) => entry.doneAt > now));
    while (budget.check(random() < 0.3 ? "user" : "background", now).ok) {
      const slot = budget.record("user", now);
      // Cold-connection calls can take ~1.5 s; most are quick.
      const latency = random() < 0.2 ? 400 + random() * 1200 : 30 + random() * 120;
      const arriveAt = now + random() * latency; // reaches Fyers somewhere in flight
      arrivals.push(arriveAt);
      inFlight.push({ slot, doneAt: now + latency });
    }
  }
  return arrivals.sort((a, b) => a - b);
}

const maxInWindow = (times: number[], windowMs: number) => {
  let best = 0;
  for (let i = 0, j = 0; i < times.length; i += 1) {
    while (times[i] - times[j] >= windowMs) j += 1;
    best = Math.max(best, i - j + 1);
  }
  return best;
};

describe("RateBudget (Fyers Standard)", () => {
  it("allows 3 per second", () => {
    expect(burst(fresh(), "user", 1_000)).toBe(3);
  });

  it("never lets Fyers see more than 3 in any second or 40 in any minute, whatever the latency", () => {
    const arrivals = simulate(fresh(), 5 * 60_000);
    expect(arrivals.length).toBeGreaterThan(100);
    expect(maxInWindow(arrivals, 1_000)).toBeLessThanOrEqual(3);
    expect(maxInWindow(arrivals, 60_000)).toBeLessThanOrEqual(40);
  });

  it("keeps a slow call's slot until a second after its response", () => {
    const budget = fresh();
    const slots = [0, 1, 2].map(() => budget.record("user", 0));
    expect(budget.check("user", 1_500).ok).toBe(false); // all three still in flight
    slots.forEach((slot) => budget.finish(slot, 1_500));
    expect(budget.check("user", 2_000).ok).toBe(false); // answered 0.5 s ago
    expect(budget.check("user", 2_510).ok).toBe(true);
  });

  it("gives background only half the minute, leaving the rest for the user", () => {
    const budget = fresh();
    let background = 0;
    for (let t = 0; t < 30_000; t += 1_000) background += burst(budget, "background", t);
    expect(background).toBe(20);
    let user = 0;
    for (let t = 30_000; t < 40_000; t += 1_000) user += burst(budget, "user", t);
    expect(user).toBe(20);
  });

  it("tells a caller how long to wait for the minute to clear", () => {
    const budget = fresh();
    for (let t = 0; t < 20_000; t += 1_000) burst(budget, "background", t);
    const decision = budget.check("background", 20_000);
    expect(decision).toMatchObject({ ok: false, reason: "minute" });
    if (!decision.ok && "waitMs" in decision) expect(decision.waitMs).toBeGreaterThan(30_000);
  });

  it("caps the day per priority and keeps the end of the day for the user", () => {
    const budget = new RateBudget(FYERS_PLANS.standard, { ...emptyBudgetState(0), usedToday: 3_325 }, dayOf);
    expect(budget.check("background", 1)).toEqual({ ok: false, denied: "day" });
    expect(budget.check("refresh", 1).ok).toBe(true);
    budget.state.usedToday = 4_750;
    expect(budget.check("user", 2)).toEqual({ ok: false, denied: "day" });
  });

  it("pauses after a 429, counts one strike per burst, and runs slower for the rest of the day", () => {
    const budget = fresh();
    budget.rateLimited(5_000);
    budget.rateLimited(5_200); // another in-flight call from the same burst
    expect(budget.check("user", 5_001)).toMatchObject({ ok: false, reason: "cooldown" });
    expect(budget.snapshot(6_000)).toMatchObject({ strikes: 1, slowed: true, minuteCap: 20 });
    expect(burst(budget, "user", 5_200 + COOLDOWN_MS)).toBe(1); // 1 per second now
  });

  it("remembers calls from before a restart", () => {
    const budget = new RateBudget(FYERS_PLANS.standard, emptyBudgetState(0), dayOf, [900, 950, 990]);
    expect(budget.check("user", 1_000).ok).toBe(false);
    expect(budget.snapshot(1_000).usedThisMinute).toBe(3);
  });

  it("starts a new day's counters at the IST day boundary", () => {
    const budget = new RateBudget(FYERS_PLANS.standard, { ...emptyBudgetState(0), usedToday: 4_750, strikes: 2 }, dayOf);
    expect(budget.check("user", DAY + 1).ok).toBe(true);
    expect(budget.snapshot(DAY + 1)).toMatchObject({ usedToday: 0, strikes: 0, slowed: false });
  });
});

describe("sweepIntervalMs", () => {
  it("spreads a 9-call sweep over a full Standard session", () => {
    // 436 instruments = 9 quote calls; background day share = 3,325; 375 minutes.
    const ms = sweepIntervalMs({ requestsPerSweep: 9, remainingToday: 3_325, minutesLeft: 375, backgroundPerMinute: 20 })!;
    expect(ms).toBeGreaterThanOrEqual(60_000);
    expect(ms).toBeLessThan(120_000);
    // Never more than the sweep's share of the minute.
    expect((9 * 60_000) / ms).toBeLessThanOrEqual(20 * 0.6);
  });

  it("speeds up when there's budget to spare late in the day", () => {
    const early = sweepIntervalMs({ requestsPerSweep: 9, remainingToday: 3_325, minutesLeft: 375, backgroundPerMinute: 20 })!;
    const late = sweepIntervalMs({ requestsPerSweep: 9, remainingToday: 3_000, minutesLeft: 30, backgroundPerMinute: 20 })!;
    expect(late).toBeLessThan(early);
  });

  it("stops when the day's budget is spent", () => {
    expect(sweepIntervalMs({ requestsPerSweep: 9, remainingToday: 10, minutesLeft: 100, backgroundPerMinute: 20 })).toBeNull();
  });
});
