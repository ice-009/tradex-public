import { variantParams, type LabReport } from "./engine";
import { SESSIONS_PER_YEAR, trialInputError, type TrialInput } from "./trials";

// From a Lab report to the multiple-testing record (#24): one trial per
// horizon, per the contract at the top of trials.ts. Pure.
//
// The Sharpe ratio handed over is the NET long–short spread's, measured on every
// h-th formation day (the report's `dsr` inputs): non-overlapping h-session
// returns, so T is the number of independent observations (≈ sessions ÷ h) and
// a year holds 252 ÷ h of them. The daily, overlapping series would overstate T
// h-fold — the deflation assumes independent observations.

/** The idea a signal's variants belong to: the signal itself (its parameters make the variants). */
export const ideaIdOf = (report: Pick<LabReport, "signal">) => report.signal.id;

export interface LabTrials {
  trials: TrialInput[];
  /** Horizons left out, and why (too few observations, no variance). */
  skipped: Array<{ horizon: number; reason: string }>;
}

export function labTrialInputs(report: LabReport, run: { stampHash: string; from: number | null }): LabTrials {
  const trials: TrialInput[] = [];
  const skipped: LabTrials["skipped"] = [];
  for (const h of report.byHorizon) {
    const { sharpe, n, skewness, kurtosis } = h.dsr;
    const input: TrialInput = {
      ideaId: ideaIdOf(report),
      variantKey: report.signal.variantKey,
      // The variant as run: reverse / close-open forward are part of it.
      params: variantParams(report.signal.params, report.signal),
      period: { from: run.from, to: report.period.to ?? 0 },
      horizon: h.horizon,
      periodsPerYear: SESSIONS_PER_YEAR / h.horizon,
      sharpe: sharpe ?? NaN,
      T: n,
      skew: skewness ?? NaN,
      kurt: kurtosis ?? NaN,
      spreadMean: h.spread.net.mean,
      tStat: h.spread.net.t,
      stampHash: run.stampHash,
    };
    const error = trialInputError(input);
    if (error) skipped.push({ horizon: h.horizon, reason: error });
    else trials.push(input);
  }
  return { trials, skipped };
}
