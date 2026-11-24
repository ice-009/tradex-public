import { annualisedSharpe, effectiveTrials, expectedMaxSharpe, probabilisticSharpe, sampleVariance } from "./deflatedSharpe";

// The multiple-testing guard (#24): every variant the Signal Lab runs for an
// idea is a trial. Try 50 variants and one will look good by luck, so a signal's
// Sharpe ratio is judged against the best Sharpe ratio the trials would have
// produced by chance — the deflated Sharpe ratio (./deflatedSharpe.ts) — and
// only a variant whose DSR clears PROMOTION_THRESHOLD may feed the score (#29).
//
// ─── Contract for the Signal Lab (#22) ────────────────────────────────────────
// After a Lab run, record one trial per horizon (server side):
//
//   import { recordTrials } from "@/server/services/labTrials";
//   recordTrials(report.horizons.map((h) => ({
//     ideaId,                         // the idea being tested: one signal family, e.g. "momentum-12-1"
//     variantKey: variantKeyOf(signalId, params),   // signal id + canonical params JSON (below)
//     params,                         // the variant's parameters, as run
//     period: { from, to },           // day keys of the tested window (from may be null = all history)
//     horizon: h.sessions,            // forward-return horizon in sessions (1, 5, 10, 21)
//     periodsPerYear,                 // observations per year of the series behind `sharpe` (optional, see below)
//     sharpe, T, skew, kurt,          // of the long–short spread return series (units below)
//     spreadMean, tStat,              // the report's mean spread and its (Newey–West) t-stat, for display
//     stampHash,                      // the run stamp's inputs hash (src/core/repro/stamp.ts)
//   })));
//
// Units: `sharpe` is PER OBSERVATION of the spread series, not annualised (mean /
// standard deviation), `T` the number of observations, `skew` its skewness and
// `kurt` its NON-excess kurtosis (normal = 3). `periodsPerYear` says how many of
// those observations make a year, so trials at different horizons can be put on
// one scale; it defaults to 252 / horizon (one non-overlapping h-session return
// per observation). If the Lab computes the Sharpe on a daily series of
// overlapping h-session returns, pass periodsPerYear = 252 and T = sessions / h
// (overlapping observations aren't independent; the deflation assumes they are).
//
// What counts: each distinct (variantKey, horizon) is one trial — picking the
// best horizon is a selection too. Re-running the same variant (e.g. on newer
// data) replaces its result rather than adding a trial; every run is still kept
// in the record. An identical run (same stamp hash) is stored once.

/** A variant must reach this deflated Sharpe ratio (probability its true Sharpe ratio beats luck) to be promoted. */
export const PROMOTION_THRESHOLD = 0.95;

/** Trading sessions per year, for the default periods-per-year of a horizon. */
export const SESSIONS_PER_YEAR = 252;

export interface TrialPeriod {
  /** First day key tested (null = from the start of the history). */
  from: number | null;
  /** Last day key tested. */
  to: number;
}

/** What the Lab hands over for one variant at one horizon. */
export interface TrialInput {
  ideaId: string;
  /** Signal id + canonical params JSON: `variantKeyOf(signalId, params)`. */
  variantKey: string;
  params: Record<string, unknown>;
  period: TrialPeriod;
  /** Forward-return horizon in sessions. */
  horizon: number;
  /** Observations per year of the series behind `sharpe` (default 252 / horizon). */
  periodsPerYear?: number;
  /** Per-observation Sharpe ratio of the long–short spread (not annualised). */
  sharpe: number;
  /** Number of observations. */
  T: number;
  /** Skewness of the spread returns. */
  skew: number;
  /** Kurtosis of the spread returns, non-excess (normal = 3). */
  kurt: number;
  /** Mean spread per observation (display only). */
  spreadMean: number | null;
  /** The report's t-stat of the spread (display only). */
  tStat: number | null;
  /** Inputs hash of the run's stamp. */
  stampHash: string;
  /** When it ran (epoch ms); the recorder fills in now. */
  runAt?: number;
}

/** A recorded trial. */
export interface Trial extends TrialInput {
  runAt: number;
}

/** Whether one variant may be promoted, and why. */
export interface TrialVerdict {
  passes: boolean;
  /** Deflated Sharpe ratio: P(true SR > the luck benchmark SR₀). NaN when it can't be computed. */
  dsr: number;
  /** Probabilistic Sharpe ratio against zero. */
  psr: number;
  /** Distinct trials (variant × horizon) for the idea, this one included. */
  n: number;
  /** Effective number of independent trials (= n unless an average correlation is given). */
  nEff: number;
  /** The luck benchmark SR₀, annualised (so it can be read next to annualised Sharpe ratios). */
  sr0Annual: number;
  reason: string;
}

export interface TrialOptions {
  /** Average pairwise correlation of the variants' return series, for the effective number of trials. */
  avgCorrelation?: number | null;
  /** Promotion bar (default PROMOTION_THRESHOLD). */
  threshold?: number;
}

/** JSON with object keys sorted at every level, so the same parameters always give the same text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** The variant key: signal id + canonical params JSON. */
export const variantKeyOf = (signalId: string, params: Record<string, unknown>) => `${signalId} ${canonicalJson(params)}`;

/** One trial = one variant at one horizon. */
export const trialKey = (trial: Pick<TrialInput, "variantKey" | "horizon">) => `${trial.variantKey}@${trial.horizon}`;

/** Observations per year behind a trial's Sharpe ratio. */
export const periodsPerYearOf = (trial: Pick<TrialInput, "horizon" | "periodsPerYear">) =>
  trial.periodsPerYear && trial.periodsPerYear > 0 ? trial.periodsPerYear : SESSIONS_PER_YEAR / Math.max(1, trial.horizon);

/** A trial's Sharpe ratio, annualised. */
export const annualSharpeOf = (trial: Pick<TrialInput, "sharpe" | "horizon" | "periodsPerYear">) => annualisedSharpe(trial.sharpe, periodsPerYearOf(trial));

const IDEA_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/** True when `value` can be an idea id (also what the route accepts). */
export const isIdeaId = (value: unknown): value is string => typeof value === "string" && IDEA_ID.test(value);

/** Why a trial input can't be recorded, or null when it can. */
export function trialInputError(input: TrialInput): string | null {
  if (!isIdeaId(input.ideaId)) return "ideaId must be 1–80 letters, digits or . _ : -";
  if (typeof input.variantKey !== "string" || !input.variantKey || input.variantKey.length > 4_000) return "variantKey must be a non-empty string (≤ 4000 characters)";
  if (!input.params || typeof input.params !== "object" || Array.isArray(input.params)) return "params must be an object";
  if (!Number.isInteger(input.horizon) || input.horizon < 1) return "horizon must be a whole number of sessions ≥ 1";
  if (input.periodsPerYear !== undefined && !(Number.isFinite(input.periodsPerYear) && input.periodsPerYear > 0)) return "periodsPerYear must be positive";
  if (!Number.isInteger(input.T) || input.T < 2) return "T must be a whole number ≥ 2";
  if (![input.sharpe, input.skew, input.kurt].every(Number.isFinite)) return "sharpe, skew and kurt must be finite numbers";
  if (input.kurt < 1) return "kurt is the non-excess kurtosis (normal = 3) and can't be below 1";
  if (!input.period || !Number.isFinite(input.period.to) || (input.period.from !== null && !Number.isFinite(input.period.from))) return "period must be { from: day | null, to: day }";
  if (typeof input.stampHash !== "string") return "stampHash must be a string";
  return null;
}

/** Trials per idea. */
export function groupByIdea<T extends Pick<Trial, "ideaId">>(trials: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const trial of trials) {
    const group = groups.get(trial.ideaId);
    if (group) group.push(trial);
    else groups.set(trial.ideaId, [trial]);
  }
  return groups;
}

/** The latest run of each distinct trial (variant × horizon), in first-seen order. */
export function latestPerTrial<T extends Pick<Trial, "variantKey" | "horizon" | "runAt">>(trials: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const trial of trials) {
    const key = trialKey(trial);
    const seen = latest.get(key);
    if (!seen || trial.runAt >= seen.runAt) latest.set(key, trial);
  }
  return [...latest.values()];
}

/** What the trials of one idea say about luck: how many, how spread out, and the bar they set. */
export interface TrialStats {
  /** Distinct trials (variant × horizon). */
  n: number;
  /** Effective independent trials. */
  nEff: number;
  /** Variance of the annualised Sharpe ratios across the trials. */
  varianceAnnual: number;
  /** Expected maximum annualised Sharpe ratio by luck alone (SR₀). */
  sr0Annual: number;
}

/** Trial count, spread and the luck benchmark for a set of (already de-duplicated) trials. */
export function trialStats(trials: readonly Pick<TrialInput, "sharpe" | "horizon" | "periodsPerYear">[], avgCorrelation?: number | null): TrialStats {
  const n = trials.length;
  const nEff = effectiveTrials(n, avgCorrelation);
  // Sharpe ratios at different horizons are per different periods: compare them annualised.
  const varianceAnnual = sampleVariance(trials.map(annualSharpeOf));
  return { n, nEff, varianceAnnual, sr0Annual: expectedMaxSharpe(nEff, varianceAnnual) };
}

const fmt = (value: number, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : "—");

/** The verdict for one trial against the luck benchmark of the trials it was selected from. */
export function verdictAgainst(candidate: TrialInput, stats: TrialStats, threshold = PROMOTION_THRESHOLD): TrialVerdict {
  const { n, nEff, sr0Annual } = stats;
  const sample = { sharpe: candidate.sharpe, T: candidate.T, skew: candidate.skew, kurt: candidate.kurt };
  // Back to the candidate's own units: SR₀ per its observation period.
  const sr0 = sr0Annual / Math.sqrt(periodsPerYearOf(candidate));
  const dsr = probabilisticSharpe(sample, sr0);
  const psr = probabilisticSharpe(sample, 0);
  const trials = `${n} trial${n === 1 ? "" : "s"}${nEff < n ? ` (${fmt(nEff, 1)} effective)` : ""}`;
  if (!Number.isFinite(dsr)) {
    return { passes: false, dsr, psr, n, nEff, sr0Annual, reason: "Can't compute the deflated Sharpe ratio: needs at least 2 observations and consistent skew / kurtosis." };
  }
  const passes = dsr >= threshold;
  const annual = annualSharpeOf(candidate);
  const reason = passes
    ? `Passes: deflated Sharpe ${fmt(dsr, 3)} ≥ ${threshold} after ${trials} — Sharpe ${fmt(annual)} a year beats the ${fmt(sr0Annual)} luck alone would give the best of them.`
    : n <= 1
      ? `Fails: only a ${fmt(dsr * 100, 1)}% chance the true Sharpe ratio is above zero (needs ${threshold * 100}%).`
      : `Fails: deflated Sharpe ${fmt(dsr, 3)} < ${threshold} after ${trials} — the best of them would reach a Sharpe of ${fmt(sr0Annual)} a year by luck alone; this one has ${fmt(annual)}.`;
  return { passes, dsr, psr, n, nEff, sr0Annual, reason };
}

/**
 * May `candidate` be promoted to the score, given every trial run for its idea?
 * The candidate counts as a trial itself (added if it isn't in `trials`, or
 * replacing the older run of the same variant × horizon).
 */
export function promotionVerdict(trials: readonly Trial[], candidate: TrialInput, options: TrialOptions = {}): TrialVerdict {
  const others = latestPerTrial(trials.filter((trial) => trial.ideaId === candidate.ideaId && trialKey(trial) !== trialKey(candidate)));
  return verdictAgainst(candidate, trialStats([...others, candidate], options.avgCorrelation), options.threshold);
}

/** One row of the trials table: the latest run of a variant at a horizon, with its verdict. */
export interface TrialRow {
  variantKey: string;
  horizon: number;
  params: Record<string, unknown>;
  period: TrialPeriod;
  runAt: number;
  /** Runs recorded for this variant × horizon. */
  runs: number;
  sharpe: number;
  annualSharpe: number;
  T: number;
  skew: number;
  kurt: number;
  spreadMean: number | null;
  tStat: number | null;
  stampHash: string;
  dsr: number;
  psr: number;
  passes: boolean;
}

/** An idea's trials and where they stand: what GET /api/lab/trials returns and LabTrials.tsx shows. */
export interface IdeaTrialSummary {
  ideaId: string;
  threshold: number;
  /** Every recorded run (re-runs included). */
  runs: number;
  n: number;
  nEff: number;
  avgCorrelation: number | null;
  /** Variance of the annualised Sharpe ratios across the trials. */
  varianceAnnual: number;
  /** Expected best annualised Sharpe ratio by luck alone. */
  sr0Annual: number;
  /** The variant with the highest deflated Sharpe ratio, and its verdict. */
  best: { variantKey: string; horizon: number; annualSharpe: number; verdict: TrialVerdict } | null;
  /** Latest run per variant × horizon, highest deflated Sharpe first. */
  variants: TrialRow[];
}

/** Summarise an idea's recorded trials (only those with this idea id are used). */
export function summarizeIdea(ideaId: string, allTrials: readonly Trial[], options: TrialOptions = {}): IdeaTrialSummary {
  const threshold = options.threshold ?? PROMOTION_THRESHOLD;
  const trials = allTrials.filter((trial) => trial.ideaId === ideaId);
  const latest = latestPerTrial(trials);
  const stats = trialStats(latest, options.avgCorrelation);
  const runsPerKey = new Map<string, number>();
  for (const trial of trials) runsPerKey.set(trialKey(trial), (runsPerKey.get(trialKey(trial)) ?? 0) + 1);
  const scored = latest.map((trial) => ({ trial, verdict: verdictAgainst(trial, stats, threshold) }));
  const rank = (dsr: number) => (Number.isFinite(dsr) ? dsr : -1);
  scored.sort((a, b) => rank(b.verdict.dsr) - rank(a.verdict.dsr) || annualSharpeOf(b.trial) - annualSharpeOf(a.trial));
  const top = scored[0];
  return {
    ideaId,
    threshold,
    runs: trials.length,
    n: stats.n,
    nEff: stats.nEff,
    avgCorrelation: options.avgCorrelation ?? null,
    varianceAnnual: stats.varianceAnnual,
    sr0Annual: stats.sr0Annual,
    best: top ? { variantKey: top.trial.variantKey, horizon: top.trial.horizon, annualSharpe: annualSharpeOf(top.trial), verdict: top.verdict } : null,
    variants: scored.map(({ trial, verdict }) => ({
      variantKey: trial.variantKey,
      horizon: trial.horizon,
      params: trial.params,
      period: trial.period,
      runAt: trial.runAt,
      runs: runsPerKey.get(trialKey(trial)) ?? 1,
      sharpe: trial.sharpe,
      annualSharpe: annualSharpeOf(trial),
      T: trial.T,
      skew: trial.skew,
      kurt: trial.kurt,
      spreadMean: trial.spreadMean,
      tStat: trial.tStat,
      stampHash: trial.stampHash,
      dsr: verdict.dsr,
      psr: verdict.psr,
      passes: verdict.passes,
    })),
  };
}
