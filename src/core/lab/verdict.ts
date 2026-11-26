import { MIN_T, MIN_TRADES } from "@/core/plan/evidence";
import { probabilisticSharpe } from "./deflatedSharpe";
import type { HorizonReport, LabReport, SpreadPair } from "./engine";
import { isoDay, num, pct, share } from "./format";
import { PROMOTION_THRESHOLD, SESSIONS_PER_YEAR, type TrialVerdict } from "./trials";

// The report card's plain-language verdict (#23): one of "works", "works in
// uptrends only", "works in downtrends only", "no edge", "too little data",
// with the reasons. Pure: from a Lab report (src/core/lab/engine.ts) and the
// multiple-testing verdict of its variant (src/core/lab/trials.ts).
//
// THE RULES, at one horizon h (the primary one, below). "The spread" is the net
// long–short spread (top bucket − bottom bucket, after a round trip on each leg),
// one value per formation day; its t-stat is Newey–West with lag h − 1.
//
//  1. Too little data: fewer than MIN_DAYS (30) days with a spread, or fewer than
//     MIN_INDEPENDENT (20) non-overlapping h-session spreads (every h-th day).
//  2. An edge in a set of days = mean net spread > 0, t > 2 and at least 30 days.
//     The whole period has an edge when it also stays above zero in BOTH the
//     first 60% and the last 40% of the days (the report's `passes`: the plan's
//     evidence rule).
//  3. Market regime (NIFTY above / below its 200-day average on the formation
//     day). With an edge over the whole period:
//       – one regime has an edge, the other ≤ 0 (30+ days) → works in uptrends (downtrends) only
//       – otherwise                                        → works
//     Without one, a regime that has an edge on its own while the other is ≤ 0
//     (or has under 30 days) → works in uptrends (downtrends) only; else no edge.
//  4. Luck (#24). Every variant × horizon tried for the signal is a trial; the
//     deflated Sharpe ratio (DSR) is the probability the variant's true Sharpe
//     ratio beats the best one luck would give that many trials. "works" needs
//     the variant's DSR at h ≥ 0.95 (PROMOTION_THRESHOLD). A regime-only verdict
//     needs the same of the regime's own days: their Sharpe ratio, on about
//     n ÷ h independent observations, against the same luck bar (an
//     approximation: the regime's days aren't a contiguous series). Failing it
//     turns the verdict into "no edge", saying so: "looks good, but likely luck
//     after N trials". With no trial record the verdict stands, marked unchecked.
//
// The primary horizon is the one asked for, else the horizon whose spread has
// the highest net t-stat among those with enough data. Picking the best horizon
// is a selection too, which is why every horizon is a trial in rule 4.
//
// Reasons also say when costs ate a gross edge, when the spread is reliably
// negative (the opposite ranking may work), and how many observations were
// dropped as data errors. They never change the label.

export type VerdictLabel = "works" | "works in uptrends only" | "works in downtrends only" | "no edge" | "too little data";

/** Fewest formation days with a spread. */
export const MIN_DAYS = MIN_TRADES;
/** Fewest non-overlapping h-session spreads (the deflated Sharpe ratio's sample). */
export const MIN_INDEPENDENT = 20;

/** What the multiple-testing record says about the variant at this horizon (a TrialVerdict). */
export type LuckCheck = Pick<TrialVerdict, "dsr" | "passes" | "n" | "nEff" | "sr0Annual"> & { threshold?: number };

export interface SignalVerdict {
  label: VerdictLabel;
  /** The horizon judged (sessions); null when the report has none. */
  horizon: number | null;
  /** The verdict the numbers give before the multiple-testing correction. */
  preDeflation: VerdictLabel;
  /** passes / fails the deflated Sharpe ratio, or unchecked (no trial record, or nothing to check). */
  deflation: "passes" | "fails" | "unchecked";
  /** Deflated Sharpe ratio behind `deflation` (the variant's, or the regime's for a regime-only verdict). */
  dsr: number | null;
  /** Trials (variant × horizon) recorded for the signal, when the record was read. */
  trials: number | null;
  /** One sentence. */
  headline: string;
  reasons: string[];
}

export interface VerdictOptions {
  /** Judge this horizon (default: primaryHorizon). */
  horizon?: number;
  /** The variant's multiple-testing verdict at that horizon (null / missing: unchecked). */
  luck?: LuckCheck | null;
}

const hasDays = (stats: SpreadPair["net"]) => stats.n >= MIN_DAYS;
const edge = (stats: SpreadPair["net"]) => hasDays(stats) && (stats.mean ?? 0) > 0 && stats.t !== null && stats.t > MIN_T;
const enoughData = (h: HorizonReport) => h.spread.net.n >= MIN_DAYS && h.dsr.n >= MIN_INDEPENDENT;

/** The horizon a card leads with: `wanted` when the report has it, else the highest net t among those with enough data (else the first). */
export function primaryHorizon(report: Pick<LabReport, "byHorizon">, wanted?: number | null): HorizonReport | null {
  const asked = wanted ? report.byHorizon.find((h) => h.horizon === wanted) : undefined;
  if (asked) return asked;
  const candidates = report.byHorizon.filter(enoughData);
  if (!candidates.length) return report.byHorizon[0] ?? null;
  return candidates.reduce((best, h) => ((h.spread.net.t ?? -Infinity) > (best.spread.net.t ?? -Infinity) ? h : best));
}

const spreadText = (stats: SpreadPair["net"]) => `${pct(stats.mean, 3)} (t ${num(stats.t)}, ${stats.n} days)`;

/** Deflated Sharpe ratio of a regime's days: their h-session Sharpe ratio on ~n ÷ h independent observations against the trials' luck bar. */
export function regimeDsr(stats: SpreadPair["net"], horizon: number, luck: LuckCheck): number | null {
  const T = Math.floor(stats.n / horizon);
  if (stats.sharpe === null || stats.skewness === null || stats.kurtosis === null || T < 2) return null;
  const sr0 = luck.sr0Annual / Math.sqrt(SESSIONS_PER_YEAR / horizon);
  const value = probabilisticSharpe({ sharpe: stats.sharpe, T, skew: stats.skewness, kurt: stats.kurtosis }, sr0);
  return Number.isFinite(value) ? value : null;
}

/** The plain-language verdict of a Lab report (rules at the top of this file). */
export function signalVerdict(report: LabReport, options: VerdictOptions = {}): SignalVerdict {
  const h = primaryHorizon(report, options.horizon);
  const top = report.signal.kind === "binary" ? "matched stocks" : `Q${report.quantiles}`;
  const bottom = report.signal.kind === "binary" ? "the rest" : "Q1";
  if (!h) {
    return {
      label: "too little data",
      horizon: null,
      preDeflation: "too little data",
      deflation: "unchecked",
      dsr: null,
      trials: options.luck?.n ?? null,
      headline: "Too little data: the report has no horizon.",
      reasons: [],
    };
  }
  const k = h.horizon;
  const net = h.spread.net;
  const gross = h.spread.gross;
  const { up, down } = h.regimes;
  const reasons: string[] = [];
  const per = `per ${k}-session hold`;

  // ---- reasons that never change the label
  const extras: string[] = [];
  if ((gross.mean ?? 0) > 0 && (net.mean ?? 0) <= 0) {
    extras.push(`Costs eat it: ${pct(gross.mean, 3)} before costs, ${pct(net.mean, 3)} after a round trip on each leg (about ${share((h.cost.long ?? 0) + (h.cost.short ?? 0), 3)}).`);
  }
  if (hasDays(net) && (net.mean ?? 0) < 0 && net.t !== null && net.t < -MIN_T) {
    const inverted = gross.mean !== null && net.mean !== null ? -gross.mean - (gross.mean - net.mean) : null;
    extras.push(
      `The spread is reliably negative (t ${num(net.t)}): ${bottom} beat ${top}. The opposite ranking (long ${bottom}, short ${top}) would make about ${pct(inverted, 3)} ${per} after costs; test it as its own signal (it is a new trial).`,
    );
  }
  const dropped = report.dataErrors.observations;
  if (dropped && report.observations && dropped / report.observations >= 0.001) {
    extras.push(`${dropped.toLocaleString("en-IN")} observations (${((dropped / report.observations) * 100).toFixed(1)}%) were left out as data errors (a session beyond ±${Math.round(report.dataErrors.maxDailyMove * 100)}%).`);
  }

  // ---- 1. too little data
  if (!enoughData(h)) {
    const headline = `Too little data: ${net.n} days with a ${k}-session spread (${h.dsr.n} non-overlapping); a verdict needs ${MIN_DAYS} days and ${MIN_INDEPENDENT} non-overlapping.`;
    return { label: "too little data", horizon: k, preDeflation: "too little data", deflation: "unchecked", dsr: null, trials: options.luck?.n ?? null, headline, reasons: [...reasons, ...extras] };
  }

  // ---- 2. the whole period
  const first = h.split.first.net;
  const last = h.split.last.net;
  const stable = (first.mean ?? 0) > 0 && (last.mean ?? 0) > 0;
  const whole = h.passes;
  reasons.push(
    `Net spread ${top} − ${bottom}: ${spreadText(net)} ${per}, ${isoDay(report.period.from)} – ${isoDay(report.period.to)}${(net.mean ?? 0) > 0 && !(net.t !== null && net.t > MIN_T) ? `; t needs to be above ${MIN_T}` : ""}.`,
  );
  const halves = `${pct(first.mean, 3)} in the first 60% of the days, ${pct(last.mean, 3)} in the last 40% (split ${isoDay(h.split.splitDate)})`;
  reasons.push(
    stable
      ? `Positive in both parts of the period: ${halves}.`
      : (first.mean ?? 0) <= 0 && (last.mean ?? 0) <= 0
        ? `At or below zero in both parts of the period: ${halves}.`
        : `Not stable over time: ${halves}; both need to be above zero.`,
  );

  // ---- 3. regimes
  const regimesKnown = up.net.n + down.net.n > 0;
  const upWorks = edge(up.net);
  const downWorks = edge(down.net);
  const upFails = hasDays(up.net) && (up.net.mean ?? 0) <= 0;
  const downFails = hasDays(down.net) && (down.net.mean ?? 0) <= 0;
  if (regimesKnown) {
    reasons.push(`By market regime: ${spreadText(up.net)} when NIFTY was above its 200-day average, ${spreadText(down.net)} when below.`);
    if (!hasDays(up.net) || !hasDays(down.net)) reasons.push(`Fewer than ${MIN_DAYS} days in ${!hasDays(up.net) ? "uptrends" : "downtrends"}: that regime can't be judged on this period.`);
  } else {
    reasons.push("No market regime for these days (NIFTY's 200-day average unavailable): the regime split is skipped.");
  }
  let pre: VerdictLabel;
  if (whole) {
    pre = regimesKnown && upWorks && downFails ? "works in uptrends only" : regimesKnown && downWorks && upFails ? "works in downtrends only" : "works";
  } else if (regimesKnown && upWorks && (downFails || !hasDays(down.net))) {
    pre = "works in uptrends only";
  } else if (regimesKnown && downWorks && (upFails || !hasDays(up.net))) {
    pre = "works in downtrends only";
  } else {
    pre = "no edge";
  }

  // ---- 4. luck
  const luck = options.luck ?? null;
  const threshold = luck?.threshold ?? PROMOTION_THRESHOLD;
  const trials = luck ? `${luck.n} trial${luck.n === 1 ? "" : "s"}${luck.nEff < luck.n ? ` (${luck.nEff.toFixed(1)} effective)` : ""}` : "";
  let deflation: SignalVerdict["deflation"] = "unchecked";
  let dsr: number | null = null;
  if (pre !== "no edge" && luck) {
    const regime = pre === "works in uptrends only" ? up.net : pre === "works in downtrends only" ? down.net : null;
    dsr = regime ? regimeDsr(regime, k, luck) : Number.isFinite(luck.dsr) ? luck.dsr : null;
    deflation = dsr === null ? "unchecked" : dsr >= threshold ? "passes" : "fails";
    const whose = regime ? `The ${pre === "works in uptrends only" ? "uptrend" : "downtrend"} days' deflated Sharpe ratio` : "Deflated Sharpe ratio";
    if (deflation === "passes") {
      reasons.push(`${whose} ${dsr!.toFixed(3)} ≥ ${threshold} after ${trials}: unlikely to be luck (the best of them would reach a Sharpe of ${num(luck.sr0Annual)} a year by chance).`);
    } else if (deflation === "fails") {
      reasons.push(
        `Looks good, but likely luck after ${trials}: ${whose.charAt(0).toLowerCase()}${whose.slice(1)} ${dsr!.toFixed(3)} < ${threshold} — the best of that many tries would reach a Sharpe of ${num(luck.sr0Annual)} a year by chance alone.`,
      );
    } else {
      reasons.push("The deflated Sharpe ratio couldn't be computed for these days, so luck isn't ruled out.");
    }
  } else if (pre !== "no edge") {
    reasons.push("Not checked for luck: this run isn't in the multiple-testing record, so the deflated Sharpe ratio is unknown.");
  } else if (luck && Number.isFinite(luck.dsr)) {
    dsr = luck.dsr;
    deflation = luck.passes ? "passes" : "fails";
  }
  const label: VerdictLabel = deflation === "fails" && pre !== "no edge" ? "no edge" : pre;

  const headline =
    label === "works"
      ? `Works: ${top} beat ${bottom} by ${pct(net.mean, 3)} net ${per} (t ${num(net.t)}), in both parts of the period${(up.net.mean ?? 0) > 0 && (down.net.mean ?? 0) > 0 ? " and in both market regimes" : ""}${deflation === "passes" ? `, and it survives ${trials}` : ""}.`
      : label === "works in uptrends only"
        ? `Works in uptrends only: ${pct(up.net.mean, 3)} net ${per} (t ${num(up.net.t)}) when NIFTY is above its 200-day average, ${pct(down.net.mean, 3)} when below.`
        : label === "works in downtrends only"
          ? `Works in downtrends only: ${pct(down.net.mean, 3)} net ${per} (t ${num(down.net.t)}) when NIFTY is below its 200-day average, ${pct(up.net.mean, 3)} when above.`
          : pre !== "no edge"
            ? `No edge: it looks good (${pre}, ${pct(pre === "works" ? net.mean : pre === "works in uptrends only" ? up.net.mean : down.net.mean, 3)} net ${per}), but it is likely luck after ${trials}.`
            : `No edge: ${top} − ${bottom} made ${pct(net.mean, 3)} net ${per} (t ${num(net.t)})${(net.mean ?? 0) > 0 && !stable ? ", not in both parts of the period" : ""}.`;
  return { label, horizon: k, preDeflation: pre, deflation, dsr, trials: luck?.n ?? null, headline, reasons: [...reasons, ...extras] };
}
