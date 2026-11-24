import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { perPeriodSharpe } from "@/core/lab/deflatedSharpe";
import { variantKeyOf, type TrialInput } from "@/core/lab/trials";

// The trial record end to end on a throwaway market database.

const dir = mkdtempSync(path.join(tmpdir(), "tradex-lab-trials-"));
let service: typeof import("./labTrials");

beforeAll(async () => {
  process.env.MARKET_DB_PATH = path.join(dir, "market.db");
  service = await import("./labTrials");
});

afterAll(() => {
  (globalThis as { marketDb?: { close(): void } }).marketDb?.close();
  rmSync(dir, { recursive: true, force: true });
});

const input = (lookback: number, annual: number, over: Partial<TrialInput> = {}): TrialInput => ({
  ideaId: "momentum",
  variantKey: variantKeyOf("mom", { lookback }),
  params: { lookback },
  period: { from: null, to: 1_700_000_000_000 },
  horizon: 1,
  sharpe: perPeriodSharpe(annual, 252),
  T: 2_500,
  skew: -0.3,
  kurt: 5,
  spreadMean: 0.0004,
  tStat: 3.1,
  stampHash: `stamp-${lookback}-${annual}`,
  ...over,
});

describe("lab trials service", () => {
  it("records, de-duplicates identical runs and lists", () => {
    service.recordTrials([input(10, 0.4), input(20, 1.6), input(20, 0.2, { horizon: 21 })], 1_000);
    service.recordTrial(input(10, 0.4), 2_000); // same stamp: stored once
    service.recordTrial(input(10, 0.5), 3_000); // a re-run on new data: a new run, same trial
    service.recordTrial(input(30, 0.1, { stampHash: "" }), 4_000);
    service.recordTrial(input(30, 0.1, { stampHash: "" }), 5_000); // unstamped runs can't be matched: both kept
    const trials = service.listTrials("momentum");
    expect(trials).toHaveLength(6);
    expect(trials[0]).toMatchObject({ ideaId: "momentum", params: { lookback: 10 }, period: { from: null }, runAt: 1_000, spreadMean: 0.0004 });
    expect(trials.at(-1)?.stampHash).toBe("unstamped:5000");
    expect(service.listTrials("other")).toEqual([]);
  });

  it("summarises and gates promotion", () => {
    const summary = service.trialSummary("momentum");
    expect(summary.runs).toBe(6);
    expect(summary.n).toBe(4);
    expect(summary.best?.variantKey).toBe(variantKeyOf("mom", { lookback: 20 }));
    const best = service.verdict("momentum", variantKeyOf("mom", { lookback: 20 }));
    expect(best?.n).toBe(4);
    expect(best?.dsr).toBeCloseTo(summary.best!.verdict.dsr, 12);
    expect(service.verdict("momentum", variantKeyOf("mom", { lookback: 20 }), { horizon: 21 })?.dsr).toBeLessThan(best!.dsr);
    expect(service.verdict("momentum", "missing")).toBeNull();
    expect(service.isPromotable("momentum")).toBe(best!.passes);
    expect(service.isPromotable("momentum", variantKeyOf("mom", { lookback: 30 }))).toBe(false);
    expect(service.isPromotable("never-tested")).toBe(false);
  });

  it("rejects bad input", () => {
    expect(() => service.recordTrial(input(10, 1, { T: 0 }))).toThrow(/T must/);
  });
});
