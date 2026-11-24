import "server-only";

import type { LabRequest, LabResponse } from "@/contracts/api";
import { COST_PRESETS, type CostPresetId } from "@/core/backtest/costs";
import { DEFAULT_HORIZONS, DEFAULT_QUANTILES, LAB_ENGINE, LabInputError, MAX_HORIZON, runLab, type LabReport } from "@/core/lab/engine";
import { findSignal, resolveParams, signalMeta } from "@/core/lab/signals";
import { marketStates } from "@/core/plan/evidence";
import { makeStamp, type RunStamp } from "@/core/repro/stamp";
import { log } from "@/server/log";
import { screenerStore } from "@/server/providers/dailyStore";
import { BacktestError, backtestInfo, researchData } from "./backtest";
import { codeVersion, parseStamp, pinOf, type ReplayPin } from "./runStamp";
import { parseUniverse } from "./screener";

// The Signal Lab (issue #22): test any signal — one number per stock per day —
// on the same data a backtest reads. The bars, the point-in-time F&O list
// (former members included) and the data stamp come from the backtester's
// loader (researchData in ./backtest.ts: the store's 5 years, or the hub's
// archive back to 1994 for an earlier period, opt-in); screen signals reuse its
// cached signal scan. The engine (src/core/lab) ranks, measures and splits; the
// CLI (scripts/lab.ts) calls this same service, so both print the same report.
//
// Every run carries a run stamp (src/core/repro/stamp.ts, kind "lab"): data
// hash, commit, engine version and the validated request. `replayLab` runs a
// stamp again from scratch on the bars up to its last session.

const MAX_RESULTS = 12;

const globalForLab = globalThis as unknown as { labResults?: Map<string, { report: LabReport; stamp: RunStamp }> };
const results = (globalForLab.labResults ??= new Map());

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

const dayOrNull = (value: unknown) => (value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null);

/** Validate and clamp a request body (anything the client sends). */
export function parseLabRequest(body: unknown): LabRequest {
  const raw = (body ?? {}) as Record<string, unknown>;
  const signal = findSignal(String(raw.signal ?? ""));
  const preset = String(raw.costPreset ?? "futures-2026");
  const horizons = Array.isArray(raw.horizons)
    ? [...new Set(raw.horizons.map((h) => Math.round(Number(h))).filter((h) => Number.isFinite(h) && h >= 1 && h <= MAX_HORIZON))].sort((a, b) => a - b).slice(0, 8)
    : [];
  const quantiles = Math.round(Number(raw.quantiles));
  return {
    universe: parseUniverse(typeof raw.universe === "string" ? raw.universe : null),
    signal: signal?.id ?? String(raw.signal ?? "").slice(0, 80),
    params: signal ? resolveParams(signal, raw.params as Record<string, unknown> | undefined) : {},
    from: dayOrNull(raw.from),
    to: dayOrNull(raw.to),
    horizons: horizons.length ? horizons : [...DEFAULT_HORIZONS],
    quantiles: Number.isFinite(quantiles) ? Math.min(10, Math.max(2, quantiles)) : DEFAULT_QUANTILES,
    costPreset: preset in COST_PRESETS ? (preset as CostPresetId) : "futures-2026",
  };
}

class LabError extends Error {}

async function execute(request: LabRequest, pin: ReplayPin | null): Promise<LabResponse> {
  const signal = findSignal(request.signal);
  if (!signal) return { status: "error", error: `Unknown signal "${request.signal}".` };
  try {
    const started = Date.now();
    const research = await researchData({ universe: request.universe, from: request.from, to: request.to }, pin, { scan: Boolean(signal.usesScan) });
    const loadMs = Date.now() - started;
    const costs = COST_PRESETS[request.costPreset];
    const key = JSON.stringify([request, research.data.hash]);
    const hit = pin ? undefined : results.get(key);
    if (hit) return { status: "ready", report: hit.report, costs: { preset: request.costPreset, label: costs.label }, runtime: { loadMs, signalMs: 0, labMs: 0, scanCached: research.scanCached, cached: true }, stamp: hit.stamp };
    if (!research.symbols.length) throw new LabError("No daily bars for this universe and period yet: they are read from the Market Data Hub.");

    const params = resolveParams(signal, request.params);
    const signalStarted = Date.now();
    const values = await signal.build(
      { dates: research.dates, symbols: research.symbols, bars: research.bars, benchmark: research.benchmark, isMember: research.isMember ?? undefined, scan: research.scan, pause: yieldToEventLoop },
      params,
    );
    const signalMs = Date.now() - signalStarted;
    const labStarted = Date.now();
    const report = runLab({
      signal: signalMeta(signal, params),
      dates: research.dates,
      symbols: research.symbols,
      bars: research.bars,
      values,
      membership: research.isMember ?? undefined,
      costs: costs.model,
      horizons: request.horizons,
      quantiles: request.quantiles,
      regimeStates: marketStates(research.benchmark),
      from: request.from,
      to: request.to,
    });
    const sessions = research.dates.filter((day) => day >= (report.period.from ?? 0) && day <= (report.period.to ?? 0));
    const universeNote = research.universeNote(sessions);
    report.notes.push(...research.warnings, ...(universeNote ? [universeNote] : []));
    const labMs = Date.now() - labStarted;

    // ---- TRIALS HOOK (#24) ------------------------------------------------
    // When src/core/lab/trials.ts and deflatedSharpe.ts land, record this run as
    // one trial and fill report.trials here, before the stamp hashes the report:
    //   recordTrial({ variantKey: report.signal.variantKey, dsr: report.byHorizon.map((h) => h.dsr), … })
    //   report.trials = { trials: n, deflatedSharpe: … }
    // Every input DSR needs is already in report.byHorizon[i].dsr (Sharpe per
    // h-session period, n, skewness, kurtosis — non-overlapping).
    // -----------------------------------------------------------------------

    const stamp = makeStamp({ kind: "lab", code: codeVersion(LAB_ENGINE), data: research.data, params: { ...request, params }, result: report, createdAt: Date.now() });
    if (!pin) {
      results.set(key, { report, stamp });
      while (results.size > MAX_RESULTS) results.delete(results.keys().next().value!);
    }
    log.info("Lab run", { signal: signal.id, universe: request.universe, days: report.period.days, stocks: report.universe.symbols, loadMs, signalMs, labMs });
    return { status: "ready", report, costs: { preset: request.costPreset, label: costs.label }, runtime: { loadMs, signalMs, labMs, scanCached: research.scanCached, cached: false }, stamp };
  } catch (error) {
    if (error instanceof LabError || error instanceof LabInputError || error instanceof BacktestError) return { status: "error", error: error.message };
    throw error;
  }
}

export const runLabRequest = (request: LabRequest) => execute(request, null);

/**
 * Bring a universe's stored daily bars up to date from the hub and wait for it
 * (the CLI; the Lab panel asks /api/backtest?universe= and shows the progress).
 * Returns the store's message when it couldn't read everything.
 */
export async function syncStoredBars(universe: string, maxWaitMs = 10 * 60_000): Promise<string | null> {
  const started = Date.now();
  await backtestInfo(universe);
  while (screenerStore.isSyncing() && Date.now() - started < maxWaitMs) await new Promise((resolve) => setTimeout(resolve, 500));
  const { progress } = screenerStore;
  return progress.phase === "error" || progress.queued ? progress.message : null;
}

/** "Re-run this": a stamped Lab run again from scratch, on the bars up to its last session. */
export async function replayLab(body: unknown): Promise<LabResponse> {
  const stamp = parseStamp(body, "lab");
  if (!stamp) return { status: "error", error: "That isn't a Signal Lab stamp this version can replay." };
  return execute(parseLabRequest(stamp.params), pinOf(stamp));
}
