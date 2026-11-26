import "server-only";

import type { LabRequest, LabResponse, LabTrialRecord } from "@/contracts/api";
import { ideaIdOf, labTrialInputs } from "@/core/lab/trialInputs";
import { recordTrials } from "./labTrials";
import { saveLabCard } from "./labCards";
import { COST_PRESETS, type CostPresetId } from "@/core/backtest/costs";
import { DEFAULT_HORIZONS, DEFAULT_QUANTILES, LAB_ENGINE, LabInputError, MAX_HORIZON, runLab, type LabReport } from "@/core/lab/engine";
import { findSignal, resolveParams, signalMeta } from "@/core/lab/signals";
import { marketStates } from "@/core/plan/evidence";
import { makeStamp, type RunStamp } from "@/core/repro/stamp";
import { log } from "@/server/log";
import { storeStart } from "@/core/backtest/phases";
import { istParts } from "@/core/market/session";
import { BacktestError, researchData } from "./backtest";
import { codeVersion, parseStamp, pinOf, type ReplayPin } from "./runStamp";
import { parseUniverse } from "./screener";

// The Signal Lab (issue #22): test any signal — one number per stock per day —
// on the data a backtest of the period reads. The bars, the point-in-time F&O
// list and the data stamp come from the backtester's loader (researchData in
// ./backtest.ts), always from the hub's archive: one series per company across
// ticker renames, and former F&O members the screener's store never held
// (merged, delisted). The default period is the stored 5 years; any period back
// to 1994 is opt-in. Screen signals reuse the backtester's cached signal scan. The engine (src/core/lab) ranks, measures and splits; the
// CLI (scripts/lab.ts) calls this same service, so both print the same report.
//
// Every run carries a run stamp (src/core/repro/stamp.ts, kind "lab"): data
// hash, commit, engine version and the validated request. `replayLab` runs a
// stamp again from scratch on the bars up to its last session.

const MAX_RESULTS = 12;

const globalForLab = globalThis as unknown as { labResults?: Map<string, { report: LabReport; stamp: RunStamp; trials: LabTrialRecord }> };
const results = (globalForLab.labResults ??= new Map());

/**
 * Record a run in the multiple-testing record (#24): one trial per horizon
 * (src/core/lab/trialInputs.ts; contract in src/core/lab/trials.ts). Every run
 * counts, the CLI's and replays included — an identical run (same stamp) is
 * stored once. A failure to record is reported with the run, never hidden:
 * the deflated Sharpe ratio is only honest if every trial is counted.
 */
function recordLabTrials(report: LabReport, stamp: RunStamp, from: number | null): LabTrialRecord {
  const ideaId = ideaIdOf(report);
  const { trials, skipped } = labTrialInputs(report, { stampHash: stamp.hash, from });
  try {
    if (trials.length) recordTrials(trials);
    return { ideaId, recorded: trials.length, skipped, error: null };
  } catch (error) {
    log.warn("Lab trials not recorded", { idea: ideaId, error: error instanceof Error ? error.message : String(error) });
    return { ideaId, recorded: 0, skipped, error: error instanceof Error ? error.message : "The trial record couldn't be written." };
  }
}

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

async function execute(raw: LabRequest, pin: ReplayPin | null): Promise<LabResponse> {
  const signal = findSignal(raw.signal);
  if (!signal) return { status: "error", error: `Unknown signal "${raw.signal}".` };
  // No `from`: the stored 5 years, as a fixed first day, so the stamp says exactly what was read and a replay reads it again.
  const request: LabRequest = { ...raw, from: raw.from ?? storeStart(istParts().day) };
  try {
    const started = Date.now();
    // Always from the hub's archive: one series per company across renames, and the
    // former F&O members (merged, delisted) the screener's store never held.
    const research = await researchData({ universe: request.universe, from: request.from, to: request.to }, pin, { scan: Boolean(signal.usesScan), archive: true });
    const loadMs = Date.now() - started;
    const costs = COST_PRESETS[request.costPreset];
    const key = JSON.stringify([request, research.data.hash]);
    const hit = pin ? undefined : results.get(key);
    // A repeat is the variant's latest run again (another run of it may have replaced its card since).
    if (hit) saveLabCard(hit.report, hit.stamp, { preset: request.costPreset, label: costs.label });
    if (hit) return { status: "ready", report: hit.report, costs: { preset: request.costPreset, label: costs.label }, runtime: { loadMs, signalMs: 0, labMs: 0, scanCached: research.scanCached, cached: true }, stamp: hit.stamp, trials: hit.trials };
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

    const stamp = makeStamp({ kind: "lab", code: codeVersion(LAB_ENGINE), data: research.data, params: { ...request, params }, result: report, createdAt: Date.now() });
    const trials = recordLabTrials(report, stamp, request.from);
    if (!pin) {
      // The variant's report card (#23) shows its latest run; a replay of an older stamp doesn't replace it.
      saveLabCard(report, stamp, { preset: request.costPreset, label: costs.label });
      results.set(key, { report, stamp, trials });
      while (results.size > MAX_RESULTS) results.delete(results.keys().next().value!);
    }
    log.info("Lab run", { signal: signal.id, universe: request.universe, days: report.period.days, stocks: report.universe.symbols, trials: trials.recorded, loadMs, signalMs, labMs });
    return { status: "ready", report, costs: { preset: request.costPreset, label: costs.label }, runtime: { loadMs, signalMs, labMs, scanCached: research.scanCached, cached: false }, stamp, trials };
  } catch (error) {
    if (error instanceof LabError || error instanceof LabInputError || error instanceof BacktestError) return { status: "error", error: error.message };
    throw error;
  }
}

export const runLabRequest = (request: LabRequest) => execute(request, null);

/** "Re-run this": a stamped Lab run again from scratch, on the bars up to its last session. */
export async function replayLab(body: unknown): Promise<LabResponse> {
  const stamp = parseStamp(body, "lab");
  if (!stamp) return { status: "error", error: "That isn't a Signal Lab stamp this version can replay." };
  return execute(parseLabRequest(stamp.params), pinOf(stamp));
}
