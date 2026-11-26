import "server-only";

import { COST_PRESETS, type CostPresetId } from "@/core/backtest/costs";
import { storeStart } from "@/core/backtest/phases";
import { istParts } from "@/core/market/session";
import { differenceT, monthlySpread, overlayStats, volManaged, type OverlayStats } from "@/core/lab/overlay";
import { findSignal, resolveParams } from "@/core/lab/signals";
import { variantKeyOf, trialInputError, type TrialInput } from "@/core/lab/trials";
import { marketStates } from "@/core/plan/evidence";
import { makeStamp, type RunStamp } from "@/core/repro/stamp";
import { recordTrials } from "./labTrials";
import { buildSignalValues, industryNote, loadSignalData } from "./lab";
import { codeVersion } from "./runStamp";
import { parseUniverse } from "./screener";

// Volatility-managed momentum (issue #27; Barroso & Santa-Clara 2015): a
// signal's monthly long–short book (top quintile long, bottom short, rebalanced
// at each month's last close) with and without scaling by the inverse of its
// recent realised volatility (src/core/lab/overlay.ts). Same data as a Lab run of
// the signal (./lab.ts loadSignalData: the hub's archive, the point-in-time F&O
// list, futures costs). Both books are recorded as trials of one idea,
// "vol-managed-momentum" (horizon 21 = monthly, 12 observations a year), so the
// multiple-testing guard (#24) counts them like any Lab run.

export const OVERLAY_ENGINE = "lab-overlay/1";
export const OVERLAY_IDEA = "vol-managed-momentum";

export interface OverlayRequest {
  signal: string;
  params?: Record<string, unknown>;
  universe?: string;
  /** First formation day (day key); default the stored 5 years. */
  from?: number | null;
  to?: number | null;
  /** Also report the months formed on or after this day (e.g. 2010-01-01). */
  subFrom?: number | null;
  costPreset?: CostPresetId;
  quantiles?: number;
  /** Daily returns in the volatility forecast (default 126). */
  lookback?: number;
}

export interface OverlayBook {
  full: OverlayStats;
  sub: OverlayStats | null;
}

export interface OverlayResult {
  signal: { id: string; name: string; params: Record<string, number> };
  universe: string;
  costs: string;
  lookback: number;
  targetMonthlyVol: number;
  plain: OverlayBook;
  managed: OverlayBook;
  /** Newey–West t of managed − plain monthly net (full period, and the sub-period). */
  differenceT: { full: number | null; sub: number | null };
  dataErrors: number;
  skippedMonths: number;
  notes: string[];
  stamp: RunStamp;
  trials: { recorded: number; error: string | null; variantKeys: string[] };
}

export class OverlayError extends Error {}

export async function runOverlay(raw: OverlayRequest): Promise<OverlayResult> {
  const signal = findSignal(raw.signal);
  if (!signal) throw new OverlayError(`Unknown signal "${raw.signal}".`);
  if (signal.usesScan) throw new OverlayError("Overlays take built-in signals (screens need the backtester's scan).");
  const params = resolveParams(signal, raw.params);
  const universe = parseUniverse(raw.universe ?? "fno");
  const preset: CostPresetId = raw.costPreset && raw.costPreset in COST_PRESETS ? raw.costPreset : "futures-2026";
  const quantiles = Math.min(10, Math.max(2, Math.round(raw.quantiles ?? 5)));
  const lookback = Math.min(252, Math.max(21, Math.round(raw.lookback ?? 126)));
  const request = { universe, from: raw.from ?? storeStart(istParts().day), to: raw.to ?? null, subFrom: raw.subFrom ?? null, costPreset: preset, quantiles, lookback };

  const { research, industries, data } = await loadSignalData(signal, params, request, null);
  if (!research.symbols.length) throw new OverlayError("No daily bars for this universe and period yet: they are read from the Market Data Hub.");
  const values = await buildSignalValues(signal, params, research, industries);
  const costs = COST_PRESETS[preset];
  const spread = monthlySpread({
    dates: research.dates,
    symbols: research.symbols,
    bars: research.bars,
    values,
    membership: research.isMember ?? undefined,
    costs: costs.model,
    quantiles,
    from: request.from,
    to: request.to,
  });
  const vm = volManaged(spread, { lookback });
  if (vm.plain.length < 12) throw new OverlayError(`Only ${vm.plain.length} months could be formed with a ${lookback}-day volatility forecast: pick a longer period.`);
  const regimeStates = marketStates(research.benchmark);
  const sub = request.subFrom;
  const subOf = <T extends { formation: number }>(rows: T[]) => (sub === null ? null : rows.filter((row) => row.formation >= sub));
  const book = (rows: typeof vm.plain): OverlayBook => {
    const part = subOf(rows);
    return { full: overlayStats(rows, { regimeStates }), sub: part && part.length >= 12 ? overlayStats(part, { regimeStates }) : null };
  };
  const plainSub = subOf(vm.plain);
  const managedSub = subOf(vm.managed);
  const notes = [...research.warnings];
  if (industries) notes.push(industryNote(research, industries));

  const result = {
    signal: { id: signal.id, name: signal.name, params },
    universe,
    costs: costs.label,
    lookback,
    targetMonthlyVol: vm.targetMonthlyVol,
    plain: book(vm.plain),
    managed: book(vm.managed),
    differenceT: { full: differenceT(vm.plain, vm.managed), sub: plainSub && managedSub ? differenceT(plainSub, managedSub) : null },
    dataErrors: spread.dataErrors,
    skippedMonths: spread.skipped,
    notes,
  };
  const stamp = makeStamp({ kind: "lab", code: codeVersion(OVERLAY_ENGINE), data, params: { ...request, signal: signal.id, params, overlay: "vol-managed" }, result, createdAt: Date.now() });

  // One trial per book: the plain monthly book and the managed one.
  const trialOf = (stats: OverlayStats, overlay: 0 | 1): TrialInput => {
    // The overlay's own keys can't collide with the signal's (momentum has a `lookback` too).
    const variantParams = { ...params, overlay, ...(overlay ? { volLookback: lookback } : {}), quantiles };
    return {
      ideaId: OVERLAY_IDEA,
      variantKey: variantKeyOf(`monthly:${signal.id}`, variantParams),
      params: variantParams,
      period: { from: request.from, to: stats.to ?? 0 },
      horizon: 21,
      periodsPerYear: 12,
      sharpe: stats.sharpe ?? NaN,
      T: stats.months,
      skew: stats.skewness ?? NaN,
      kurt: stats.kurtosis ?? NaN,
      spreadMean: stats.mean,
      tStat: stats.t,
      stampHash: stamp.hash,
    };
  };
  const inputs = [trialOf(result.plain.full, 0), trialOf(result.managed.full, 1)];
  let trials: OverlayResult["trials"];
  const invalid = inputs.map(trialInputError).find(Boolean);
  if (invalid) trials = { recorded: 0, error: invalid, variantKeys: [] };
  else {
    try {
      recordTrials(inputs);
      trials = { recorded: inputs.length, error: null, variantKeys: inputs.map((input) => input.variantKey) };
    } catch (error) {
      trials = { recorded: 0, error: error instanceof Error ? error.message : "The trial record couldn't be written.", variantKeys: [] };
    }
  }
  return { ...result, stamp, trials };
}
