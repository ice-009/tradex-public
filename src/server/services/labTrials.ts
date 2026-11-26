import "server-only";

import {
  promotionVerdict,
  summarizeIdea,
  trialInputError,
  type IdeaTrialSummary,
  type Trial,
  type TrialInput,
  type TrialOptions,
  type TrialVerdict,
} from "@/core/lab/trials";
import { readTrials, writeTrials } from "@/server/providers/labTrials";

// The Signal Lab's trial record and promotion gate (#24). The Lab (#22) calls
// `recordTrials` after every run, once per horizon (contract at the top of
// src/core/lab/trials.ts); report cards (#23) read `listTrials` / the summary;
// the score (#29) asks `isPromotable` before using a signal.

/** Record one Lab run of a variant at one horizon. Throws on invalid input (a Lab bug, not user input). */
export function recordTrial(input: TrialInput, now = Date.now()): Trial {
  return recordTrials([input], now)[0];
}

/** Record a Lab run's trials (one per horizon) in one transaction. */
export function recordTrials(inputs: readonly TrialInput[], now = Date.now()): Trial[] {
  const trials = inputs.map((input): Trial => {
    const error = trialInputError(input);
    if (error) throw new Error(`Lab trial for ${String(input.ideaId)}: ${error}`);
    const runAt = input.runAt ?? now;
    // An unstamped run can't be recognised as a repeat: give it its own key.
    return { ...input, runAt, stampHash: input.stampHash || `unstamped:${runAt}` };
  });
  writeTrials(trials);
  return trials;
}

/** Every recorded run for an idea, oldest first (re-runs included). */
export function listTrials(ideaId: string): Trial[] {
  return readTrials(ideaId);
}

/** An idea's trials with the luck benchmark, each variant's deflated Sharpe ratio and the best one's verdict. */
export function trialSummary(ideaId: string, options?: TrialOptions): IdeaTrialSummary {
  return summarizeIdea(ideaId, readTrials(ideaId), options);
}

/**
 * The promotion verdict for one variant of an idea (its latest run at `horizon`,
 * or at its best horizon when none is given). Null when that variant was never recorded.
 */
export function verdict(ideaId: string, variantKey: string, options?: TrialOptions & { horizon?: number }): TrialVerdict | null {
  const trials = readTrials(ideaId);
  const summary = summarizeIdea(ideaId, trials, options);
  // The summary's rows are the latest run per variant × horizon, best deflated Sharpe first.
  const row = summary.variants.find((variant) => variant.variantKey === variantKey && (options?.horizon === undefined || variant.horizon === options.horizon));
  if (!row) return null;
  const candidate = trials.find((trial) => trial.variantKey === row.variantKey && trial.horizon === row.horizon && trial.runAt === row.runAt);
  return candidate ? promotionVerdict(trials, candidate, options) : null;
}

/** The promotion verdict of a variant at each horizon it was recorded at (its latest run there), from one read of the record. */
export function verdictsByHorizon(ideaId: string, variantKey: string, options?: TrialOptions): Map<number, TrialVerdict> {
  const trials = readTrials(ideaId);
  const latest = new Map<number, Trial>();
  for (const trial of trials) {
    if (trial.variantKey !== variantKey) continue;
    const seen = latest.get(trial.horizon);
    if (!seen || trial.runAt >= seen.runAt) latest.set(trial.horizon, trial);
  }
  return new Map([...latest].map(([horizon, candidate]) => [horizon, promotionVerdict(trials, candidate, options)]));
}

/**
 * The gate for the score (#29): may this idea feed it? True only when its best
 * variant's deflated Sharpe ratio, after every trial recorded for the idea,
 * clears the promotion threshold. Pass `variantKey` to ask about the variant the
 * score actually uses.
 */
export function isPromotable(ideaId: string, variantKey?: string, options?: TrialOptions): boolean {
  if (variantKey !== undefined) return verdict(ideaId, variantKey, options)?.passes ?? false;
  return trialSummary(ideaId, options).best?.verdict.passes ?? false;
}
