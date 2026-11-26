import "server-only";

import type { LabCardResponse, LabCardsResponse, LabCardVariant, LabSignalInfo } from "@/contracts/api";
import type { LabReport } from "@/core/lab/engine";
import { LAB_SIGNALS, findSignal, type LabSignal } from "@/core/lab/signals";
import { ideaIdOf } from "@/core/lab/trialInputs";
import type { TrialVerdict } from "@/core/lab/trials";
import { primaryHorizon, signalVerdict, type SignalVerdict } from "@/core/lab/verdict";
import type { RunStamp } from "@/core/repro/stamp";
import { log } from "@/server/log";
import { readLatestReports, readSignalReports, writeReport, type StoredLabReport } from "@/server/providers/labReports";
import { verdictsByHorizon } from "./labTrials";

// Report cards (#23): one page per Lab signal. The Lab service saves each
// variant's latest report here after a run (./lab.ts), so a card opens without
// running the Lab again; the verdict (src/core/lab/verdict.ts) is worked out
// when the card is read, against the trial record as it stands then — the
// deflated Sharpe ratio drops as more variants of the idea are tried.

const info = (signal: LabSignal): LabSignalInfo => ({ id: signal.id, name: signal.name, group: signal.group, kind: signal.kind, summary: signal.summary });

/** Save a Lab run as its variant's latest report. Never throws: a card that isn't saved is only a re-run away. */
export function saveLabCard(report: LabReport, stamp: RunStamp, costs: { preset: string; label: string }, runAt = Date.now()): boolean {
  try {
    writeReport({ variantKey: report.signal.variantKey, signalId: report.signal.id, runAt, report, stamp, costs });
    return true;
  } catch (error) {
    log.warn("Lab report card not saved", { signal: report.signal.id, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

const variantOf = (entry: StoredLabReport): LabCardVariant => ({
  variantKey: entry.variantKey,
  params: entry.report.signal.params,
  runAt: entry.runAt,
  period: entry.report.period,
  universe: typeof entry.stamp.params?.universe === "string" ? entry.stamp.params.universe : "",
});

/** The verdict at every horizon of a stored report, and the horizon it leads with. */
function verdicts(entry: StoredLabReport): { primary: number | null; verdicts: SignalVerdict[] } {
  let luck = new Map<number, TrialVerdict>();
  try {
    luck = verdictsByHorizon(ideaIdOf(entry.report), entry.variantKey);
  } catch (error) {
    // No trial record: the verdicts say "not checked for luck".
    log.warn("Lab trials unreadable for a report card", { signal: entry.signalId, error: error instanceof Error ? error.message : String(error) });
  }
  const primary = primaryHorizon(entry.report)?.horizon ?? null;
  return { primary, verdicts: entry.report.byHorizon.map((h) => signalVerdict(entry.report, { horizon: h.horizon, luck: luck.get(h.horizon) ?? null })) };
}

const leading = (entry: StoredLabReport) => {
  const { primary, verdicts: all } = verdicts(entry);
  return all.find((verdict) => verdict.horizon === primary) ?? signalVerdict(entry.report);
};

/** One variant's stored report and its verdict at its primary horizon (null: that variant was never run), for the receipts (#29). */
export function variantCard(signalId: string, variantKey: string): { entry: StoredLabReport; verdict: SignalVerdict } | null {
  const entry = readSignalReports(signalId).find((item) => item.variantKey === variantKey);
  return entry ? { entry, verdict: leading(entry) } : null;
}

/** Every signal, with its newest stored report's verdict at its primary horizon. */
export function labCardIndex(): LabCardsResponse {
  const latest = new Map(readLatestReports().map((entry) => [entry.signalId, entry]));
  return {
    cards: LAB_SIGNALS.map((signal) => {
      const entry = latest.get(signal.id);
      return { signal: info(signal), latest: entry ? { ...variantOf(entry), verdict: leading(entry), variants: entry.variants } : null };
    }),
  };
}

/** One signal's card: its stored variants and the latest report of `variantKey` (default: the newest run). Null for an unknown signal. */
export function labCard(signalId: string, variantKey?: string | null): LabCardResponse | null {
  const signal = findSignal(signalId);
  if (!signal) return null;
  const stored = readSignalReports(signal.id);
  const entry = (variantKey ? stored.find((item) => item.variantKey === variantKey) : undefined) ?? stored[0];
  return {
    signal: info(signal),
    variants: stored.map(variantOf),
    card: entry ? { variant: variantOf(entry), report: entry.report, stamp: entry.stamp, costs: entry.costs, ...verdicts(entry) } : null,
  };
}
