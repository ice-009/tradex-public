import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COST_PRESETS } from "@/core/backtest/costs";
import { runLab, type LabReport } from "@/core/lab/engine";
import { labTrialInputs } from "@/core/lab/trialInputs";
import { makeStamp, type DataStamp } from "@/core/repro/stamp";
import type { DailyBar } from "@/core/types";

// Report cards end to end on a throwaway market database: a run is saved per
// variant, the index and the card read it back with verdicts from the trial record.

const dir = mkdtempSync(path.join(tmpdir(), "tradex-lab-cards-"));
let cards: typeof import("./labCards");
let trials: typeof import("./labTrials");

beforeAll(async () => {
  process.env.MARKET_DB_PATH = path.join(dir, "market.db");
  cards = await import("./labCards");
  trials = await import("./labTrials");
});

afterAll(() => {
  (globalThis as { marketDb?: { close(): void } }).marketDb?.close();
  rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const T0 = Date.UTC(2022, 0, 3);

/** 30 stocks over 400 sessions; stock s drifts with s, plus seeded noise: Q5 beats Q1. */
function run(lookback: number): LabReport {
  let state = 11;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296 - 0.5;
  const dates = Array.from({ length: 400 }, (_, i) => T0 + i * DAY);
  const symbols = Array.from({ length: 30 }, (_, s) => `S${s}`);
  const bars = new Map<string, DailyBar[]>();
  symbols.forEach((symbol, s) => {
    let close = 100;
    bars.set(
      symbol,
      dates.map((t, i) => {
        if (i) close *= 1 + (s - 15) * 0.0002 + next() * 0.03;
        return { t, o: close, h: close, l: close, c: close, v: 1e6 };
      }),
    );
  });
  return runLab({
    signal: { id: "momentum-12-1", name: "Momentum 12−1", kind: "numeric", params: { lookback, skip: 21 } },
    dates,
    symbols,
    bars,
    values: (_day, symbol) => Number(symbol.slice(1)),
    costs: COST_PRESETS.none.model,
    minStocks: 10,
  });
}

const data: DataStamp = { hash: "d", parts: {}, symbols: [], benchmark: "NIFTY", from: T0, to: T0 + 399 * DAY, sessions: 400, bars: 12_000, membership: null, hub: null };
const stampOf = (report: LabReport, createdAt: number) =>
  makeStamp({ kind: "lab", code: { commit: "test", engine: report.engine }, data, params: { universe: "fno", signal: report.signal.id, params: report.signal.params }, result: report, createdAt });

describe("lab report cards", () => {
  it("lists every signal, unrun ones with no verdict", () => {
    const index = cards.labCardIndex();
    expect(index.cards.length).toBeGreaterThan(4);
    expect(index.cards.every((card) => card.latest === null)).toBe(true);
    expect(cards.labCard("momentum-12-1")).toMatchObject({ variants: [], card: null });
    expect(cards.labCard("no-such-signal")).toBeNull();
  });

  it("saves the latest report per variant and judges it against the trial record", () => {
    const a = run(252);
    const b = run(126);
    const stampA = stampOf(a, 1_000);
    expect(cards.saveLabCard(a, stampA, { preset: "none", label: "No costs" }, 1_000)).toBe(true);
    expect(cards.saveLabCard(b, stampOf(b, 2_000), { preset: "none", label: "No costs" }, 2_000)).toBe(true);
    // Re-running a variant replaces its card.
    expect(cards.saveLabCard(a, stampA, { preset: "none", label: "No costs" }, 3_000)).toBe(true);

    let card = cards.labCard("momentum-12-1")!;
    expect(card.variants.map((variant) => variant.params.lookback)).toEqual([252, 126]);
    expect(card.card?.variant).toMatchObject({ variantKey: a.signal.variantKey, runAt: 3_000, universe: "fno" });
    expect(card.card?.report.byHorizon[0].series.net.length).toBeGreaterThan(0);
    expect(card.card?.verdicts.map((verdict) => verdict.horizon)).toEqual(a.horizons);
    // Not in the trial record yet: unchecked.
    expect(card.card?.verdicts.every((verdict) => verdict.deflation === "unchecked")).toBe(true);
    expect(cards.labCard("momentum-12-1", b.signal.variantKey)?.card?.variant.params.lookback).toBe(126);
    expect(cards.labCard("momentum-12-1", "unknown variant")?.card?.variant.runAt).toBe(3_000);

    trials.recordTrials(labTrialInputs(a, { stampHash: stampA.hash, from: null }).trials, 3_000);
    card = cards.labCard("momentum-12-1")!;
    const primary = card.card!.verdicts.find((verdict) => verdict.horizon === card.card!.primary)!;
    expect(primary.trials).toBe(a.horizons.length);
    expect(primary.deflation).not.toBe("unchecked");

    const index = cards.labCardIndex().cards.find((entry) => entry.signal.id === "momentum-12-1")!;
    expect(index.latest).toMatchObject({ variantKey: a.signal.variantKey, variants: 2, verdict: { label: primary.label, horizon: card.card!.primary } });
  });
});
