import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/core/types";
import { computeFeatures } from "./features";
import { factsFrom, scoreSetup } from "./score";
import { SCREEN_MAP, confirmedEntry } from "./screens";

const DAY = 86_400_000;

/** A steady uptrend (100 → ~200 over 260 sessions), then `last` as today's bar. */
function trend(last: (prev: number) => Omit<DailyBar, "t" | "v">, lastVolume = 1_000_000): DailyBar[] {
  const bars: DailyBar[] = [];
  for (let i = 0; i < 260; i += 1) {
    const c = 100 * Math.pow(2, i / 259) * (1 + Math.sin(i / 3) * 0.004);
    bars.push({ t: i * DAY, o: c * 0.997, h: c * 1.006, l: c * 0.992, c, v: 1_000_000 });
  }
  const prev = bars[bars.length - 1].c;
  bars.push({ t: 260 * DAY, ...last(prev), v: lastVolume });
  return bars;
}

const redDay = (prev: number) => ({ o: prev, h: prev * 1.002, l: prev * 0.98, c: prev * 0.983 }); // −1.7%, closes near the low
const strongDay = (prev: number) => ({ o: prev, h: prev * 1.02, l: prev * 0.998, c: prev * 1.019 }); // +1.9%, closes at the high

describe("trend setups wait for strength", () => {
  it("buys at the close on a strong day", () => {
    const f = computeFeatures("X", trend(strongDay), false);
    expect(confirmedEntry(f)).toEqual({ entry: f.close, confirmed: true });
    expect(SCREEN_MAP["pos-trend-template"].plan(f).entry).toBe(f.close);
  });

  it("turns into a buy-stop above the 5-day high on a falling day", () => {
    const f = computeFeatures("X", trend(redDay), false);
    const plan = SCREEN_MAP["pos-trend-template"].plan(f);
    expect(plan.entry).toBeGreaterThan(f.close);
    expect(plan.entry).toBeGreaterThanOrEqual(f.maxHigh5);
    expect(plan.exit).toMatch(/buy-stop just above the 5-day high/);
    // Stop and 3R target follow the new entry.
    expect(plan.target! - plan.entry).toBeCloseTo(3 * (plan.entry - plan.stop), 6);
    expect(SCREEN_MAP["pos-52w-high"].plan(f).entry).toBeGreaterThan(f.close);
  });
});

describe("score: buying into a falling day", () => {
  const f = computeFeatures("X", trend(redDay), false);
  const facts = factsFrom(f);
  const atMarket = { entry: f.close, stop: f.close * 0.95, target: f.close * 1.15, exit: "" };
  const penaltyOf = (score: ReturnType<typeof scoreSetup>) => score.penalties.find((p) => /today/.test(p.label))?.points ?? 0;

  it("is penalised when the plan buys now", () => {
    expect(penaltyOf(scoreSetup(facts, atMarket, { holdDays: 10 }))).toBe(-8);
  });

  it("more on heavy volume (distribution)", () => {
    const heavy = factsFrom(computeFeatures("X", trend(redDay, 3_000_000), false));
    expect(penaltyOf(scoreSetup(heavy, { ...atMarket, entry: heavy.close }, { holdDays: 10 }))).toBe(-12);
  });

  it("isn't penalised for a buy-stop entry or a dip-buying setup", () => {
    expect(penaltyOf(scoreSetup(facts, { ...atMarket, entry: f.close * 1.03 }, { holdDays: 10 }))).toBe(0);
    expect(penaltyOf(scoreSetup(facts, atMarket, { holdDays: 10, buysWeakness: true }))).toBe(0);
    expect(SCREEN_MAP["swing-rsi2"].buysWeakness).toBe(true);
  });
});
