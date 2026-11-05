import { describe, expect, it } from "vitest";
import { COVERAGE_SLACK_MS, PREFETCH_SPECS, estimateCalls, isCovered, planPrefetch } from "./prefetch";

describe("prefetch planning", () => {
  it("counts a series as covered when it reaches the target (with a little slack)", () => {
    expect(isCovered(1_000, 1_000)).toBe(true);
    expect(isCovered(1_000 + COVERAGE_SLACK_MS, 1_000)).toBe(true);
    expect(isCovered(1_000 + COVERAGE_SLACK_MS + 1, 1_000)).toBe(false);
    expect(isCovered(null, 1_000)).toBe(false);
  });

  it("plans only what's missing, daily first, and estimates the calls", () => {
    const have = new Set(["A:daily", "B:m15"]);
    const jobs = planPrefetch(["A", "B"], ["m15", "daily"], (symbol, spec) => have.has(`${symbol}:${spec.kind}`));
    expect(jobs.map((job) => `${job.symbol}:${job.spec.kind}`)).toEqual(["B:daily", "A:m15"]);
    expect(estimateCalls(jobs)).toBe(PREFETCH_SPECS.daily.callsPerSymbol + PREFETCH_SPECS.m15.callsPerSymbol);
  });

  it("respects the chosen kinds", () => {
    expect(planPrefetch(["A"], ["daily"], () => false).map((job) => job.spec.kind)).toEqual(["daily"]);
  });
});
