import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COST_PRESETS } from "@/core/backtest/costs";
import { runLab, type LabReport } from "@/core/lab/engine";
import { labTrialInputs } from "@/core/lab/trialInputs";
import { makeStamp, type DataStamp } from "@/core/repro/stamp";
import type { DailyBar } from "@/core/types";

// Receipts end to end on a throwaway market database: a factor's card is read
// for its DEFAULT variant only, and it passes (feeds the score) only once the
// trial record says it survives the multiple-testing correction.

const dir = mkdtempSync(path.join(tmpdir(), "tradex-receipts-"));
let receipts: typeof import("./receipts");
let cards: typeof import("./labCards");
let trials: typeof import("./labTrials");

beforeAll(async () => {
  process.env.MARKET_DB_PATH = path.join(dir, "market.db");
  receipts = await import("./receipts");
  cards = await import("./labCards");
  trials = await import("./labTrials");
});

afterAll(() => {
  (globalThis as { marketDb?: { close(): void } }).marketDb?.close();
  rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const T0 = Date.UTC(2021, 0, 4);

/** 30 stocks over 600 sessions; stock s drifts with s: a strong, steady Q5 − Q1 spread. */
function run(id: string, params: Record<string, number> = {}, reversed = false): LabReport {
  let state = 3;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296 - 0.5;
  const dates = Array.from({ length: 600 }, (_, i) => T0 + i * DAY);
  const symbols = Array.from({ length: 30 }, (_, s) => `S${s}`);
  const bars = new Map<string, DailyBar[]>();
  symbols.forEach((symbol, s) => {
    let close = 100;
    bars.set(
      symbol,
      dates.map((t, i) => {
        if (i) close *= 1 + (s - 15) * 0.0004 + next() * 0.01;
        return { t, o: close, h: close, l: close, c: close, v: 1e6 };
      }),
    );
  });
  return runLab({ signal: { id, name: id, kind: "numeric", params, ...(reversed ? { reversed } : {}) }, dates, symbols, bars, values: (_day, symbol) => Number(symbol.slice(1)), costs: COST_PRESETS.none.model, minStocks: 10 });
}

const data: DataStamp = { hash: "d", parts: {}, symbols: [], benchmark: "NIFTY", from: T0, to: T0 + 599 * DAY, sessions: 600, bars: 18_000, membership: null, hub: null };
const stampOf = (report: LabReport, createdAt: number) =>
  makeStamp({ kind: "lab", code: { commit: "test", engine: report.engine }, data, params: { universe: "fno", signal: report.signal.id, params: report.signal.params }, result: report, createdAt });

describe("receipts service (#29)", () => {
  it("has no cards and no passing factor before the Lab is run", () => {
    const response = receipts.labReceipts();
    expect(Object.keys(response.factors).sort()).toEqual(["accumulation", "extension", "pattern", "rr", "rs", "stop", "track", "trend"]);
    expect(Object.values(response.factors).every((card) => card === null)).toBe(true);
    expect(response.screens["btst-20d-high"]).toBeNull();
    expect(response.passing).toEqual([]);
  });

  it("reads a factor's default variant, and passes it only once the trial record clears it", () => {
    // A reversed run of the same factor is another variant: it never stands for the factor.
    const other = run("score-trend", {}, true);
    cards.saveLabCard(other, stampOf(other, 500), { preset: "none", label: "No costs" }, 500);
    expect(receipts.labReceipts().factors.trend).toBeNull();

    const report = run("score-trend");
    expect(report.signal.variantKey).toBe(receipts.defaultVariantKey("score-trend"));
    const stamp = stampOf(report, 1_000);
    cards.saveLabCard(report, stamp, { preset: "none", label: "No costs" }, 1_000);
    let response = receipts.labReceipts();
    expect(response.factors.trend).toMatchObject({ signalId: "score-trend", variantKey: report.signal.variantKey, runAt: 1_000, label: "works", promotable: false, deflation: "unchecked" });
    expect(response.passing).toEqual([]);

    trials.recordTrials(labTrialInputs(report, { stampHash: stamp.hash, from: null }).trials, 1_000);
    response = receipts.labReceipts();
    expect(response.factors.trend).toMatchObject({ label: "works", promotable: true, deflation: "passes" });
    expect(response.passing).toEqual([{ key: "trend", worksIn: "any" }]);
  });
});
