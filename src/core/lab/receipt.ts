import { HOLD_BARS } from "@/core/screener/backtest";
import type { LiveScreenRecord } from "@/core/screener/liveRecord";
import { SCORE_FACTORS, type FactorKey } from "@/core/screener/score";
import { SCREEN_MAP } from "@/core/screener/screens";
import { VERDICT_LABEL, bucketFor, eligibleIn, type MarketState, type ScreenEvidence } from "@/core/plan/evidence";
import type { LabReport } from "./engine";
import { primaryHorizon, type SignalVerdict, type VerdictLabel } from "./verdict";

// Receipts (#29): every score factor, screen and plan idea shows its proof in
// one line — the period it was tested on, the market it works in, its net
// expectancy, the sample behind it, the live record — and links to its report
// card (#23). Pure: the server summarises the stored cards (CardSummary, from
// src/server/services/receipts.ts); the browser adds the plan's evidence and
// the live record it already has.
//
//   A FACTOR's receipt is its Lab card (src/core/lab/scoreSignals.ts maps each
//   factor to a signal): the default variant's latest run, its verdict at the
//   primary horizon, and whether it survives the multiple-testing record
//   (isPromotable). It PASSES when the verdict is "works" (or "works in
//   uptrends / downtrends only") AND it is promotable; a regime-only factor
//   passes only in that regime. Only passing factors count in a gated score
//   (src/core/screener/score.ts, ScoreOptions.gate).
//
//   A SCREEN's receipt is the plan's evidence (src/core/plan/evidence.ts): its
//   mean net R per trade in today's market state over the stored 5 years, the
//   trades behind it, and the BTST live record; it passes by the plan's own
//   PASS rule (eligibleIn), which this doesn't change. Its Lab card
//   (screen:<id>, matched vs the rest), when one has been run, is shown next to it.

/** The Lab signal behind each score factor (score-rs: ./momentumSignals.ts; the rest: ./scoreSignals.ts). */
export const FACTOR_SIGNALS: Record<FactorKey, string> = {
  trend: "score-trend",
  rs: "score-rs",
  accumulation: "score-accumulation",
  pattern: "score-pattern",
  rr: "score-rr",
  stop: "score-stop",
  extension: "score-extension",
  track: "score-track",
};

/** Where a verdict holds: any market, NIFTY above its 200-day average (up) or below it (down). */
export type WorksIn = "any" | "up" | "down";

/** What a receipt needs from a stored report card (one variant's latest run). */
export interface CardSummary {
  signalId: string;
  variantKey: string;
  runAt: number;
  /** First and last formation day. */
  period: { from: number | null; to: number | null };
  label: VerdictLabel;
  headline: string;
  /** The primary horizon (sessions). */
  horizon: number | null;
  /** Net long–short spread per hold at that horizon (fraction): the whole period's, or the regime's for a regime-only verdict. */
  net: number | null;
  t: number | null;
  /** Formation days behind `net`. */
  days: number;
  deflation: SignalVerdict["deflation"];
  /** The trial record lets this variant feed the score (src/server/services/labTrials.ts isPromotable). */
  promotable: boolean;
}

export const worksIn = (label: VerdictLabel | null | undefined): WorksIn | null =>
  label === "works" ? "any" : label === "works in uptrends only" ? "up" : label === "works in downtrends only" ? "down" : null;

/** A stored report and its verdict at the primary horizon, as a receipt reads it. */
export function summarizeCard(input: { variantKey: string; runAt: number; report: LabReport; verdict: SignalVerdict; promotable: boolean }): CardSummary {
  const { report, verdict } = input;
  const h = report.byHorizon.find((entry) => entry.horizon === verdict.horizon) ?? primaryHorizon(report);
  const where = worksIn(verdict.label);
  const stats = !h ? null : where === "up" ? h.regimes.up.net : where === "down" ? h.regimes.down.net : h.spread.net;
  return {
    signalId: report.signal.id,
    variantKey: input.variantKey,
    runAt: input.runAt,
    period: { from: report.period.from, to: report.period.to },
    label: verdict.label,
    headline: verdict.headline,
    horizon: h?.horizon ?? null,
    net: stats?.mean ?? null,
    t: stats?.t ?? null,
    days: stats?.n ?? 0,
    deflation: verdict.deflation,
    promotable: input.promotable,
  };
}

/** A card passes: its verdict says it works (somewhere) and it survives the multiple-testing record. */
export const cardPasses = (card: CardSummary | null | undefined): boolean => Boolean(card && worksIn(card.label) && card.promotable);

/** /lab/<signal>[?variant=<variant key>]: signal ids hold ":" (screen:<id>), so both are encoded. */
export const cardHref = (signalId: string, variantKey?: string) => `/lab/${encodeURIComponent(signalId)}${variantKey ? `?variant=${encodeURIComponent(variantKey)}` : ""}`;

export interface Receipt {
  subject: "factor" | "screen";
  /** Factor key or screen id. */
  id: string;
  name: string;
  /** The Lab signal whose card this links to. */
  signalId: string;
  cardHref: string;
  /** A Lab card has been run for it. */
  hasCard: boolean;
  /** Tested from … to (day keys); null when untested. */
  period: { from: number; to: number } | null;
  /** Where the evidence says it works; null: nowhere (or untested). */
  worksIn: WorksIn | null;
  /** Net expectancy: R per trade (screens) or % per hold of the long–short spread (factors), over `horizon` sessions. */
  expectancy: { value: number; unit: "R" | "%"; horizon: number | null } | null;
  /** Trades (screens) or formation days (factors) behind the expectancy. */
  sample: { n: number; unit: "trades" | "days" } | null;
  /** The BTST live record: settled trades with a positive net return, of all settled. */
  live: { wins: number; trades: number; avgNetPct: number | null } | null;
  /** The verdict in words. */
  verdict: string;
  /** The Lab card's verdict, for a screen that has one (its own verdict is the plan's evidence). */
  lab: VerdictLabel | null;
  /** It passes its rule in today's market: a factor counts in the score, a screen may enter the plan. */
  promotable: boolean;
}

const finite = (value: number | null | undefined): value is number => value !== null && value !== undefined && Number.isFinite(value);

const periodOf = (period: { from: number | null; to: number | null } | null | undefined) => (period && finite(period.from) && finite(period.to) ? { from: period.from, to: period.to } : null);

/** Does a passing verdict apply in this market state? Unknown state: only "any". */
const appliesIn = (where: WorksIn | null, state: MarketState | null) => where === "any" || (where !== null && where === state);

/** A score factor's receipt: its Lab card (null: never run). `state`: today's market, for a regime-only verdict. */
export function factorReceipt(key: FactorKey, card: CardSummary | null | undefined, state: MarketState | null): Receipt {
  const factor = SCORE_FACTORS.find((entry) => entry.key === key)!;
  const signalId = FACTOR_SIGNALS[key];
  const where = card ? worksIn(card.label) : null;
  return {
    subject: "factor",
    id: key,
    name: factor.label,
    signalId,
    cardHref: cardHref(signalId, card?.variantKey),
    hasCard: Boolean(card),
    period: periodOf(card?.period),
    worksIn: where,
    expectancy: card && finite(card.net) ? { value: card.net, unit: "%", horizon: card.horizon } : null,
    sample: card ? { n: card.days, unit: "days" } : null,
    live: null,
    verdict: card ? (card.label !== "no edge" && card.label !== "too little data" && !card.promotable ? `${card.label}, not yet past the luck check` : card.label) : "not tested yet",
    lab: card?.label ?? null,
    promotable: cardPasses(card) && appliesIn(where, state),
  };
}

const SCREEN_WORKS: Record<ScreenEvidence["verdict"], WorksIn | null> = { any: "any", uptrend: "up", downtrend: "down", none: null, few: null };

/**
 * A screen's receipt: the plan's evidence for it in today's market state (the
 * whole table's period), its Lab card (screen:<id>) when run, its BTST live record.
 */
export function screenReceipt(
  screenId: string,
  input: { evidence?: ScreenEvidence | null; table?: { from: number; to: number } | null; state: MarketState | null; card?: CardSummary | null; live?: LiveScreenRecord | null },
): Receipt {
  const screen = SCREEN_MAP[screenId];
  const signalId = `screen:${screenId}`;
  const { evidence, card, live, state } = input;
  const bucket = evidence ? bucketFor(evidence, state) : null;
  return {
    subject: "screen",
    id: screenId,
    name: screen?.name ?? screenId,
    signalId,
    cardHref: cardHref(signalId, card?.variantKey),
    hasCard: Boolean(card),
    period: evidence ? periodOf(input.table) : periodOf(card?.period),
    worksIn: evidence ? SCREEN_WORKS[evidence.verdict] : card ? worksIn(card.label) : null,
    expectancy: bucket && finite(bucket.mean) ? { value: bucket.mean, unit: "R", horizon: screen ? HOLD_BARS[screen.group] : null } : null,
    sample: bucket ? { n: bucket.n, unit: "trades" } : null,
    live: live && live.trades > 0 && live.winShare !== null ? { wins: Math.round(live.winShare * live.trades), trades: live.trades, avgNetPct: live.avgNetPct } : null,
    verdict: evidence ? VERDICT_LABEL[evidence.verdict] : "not tested yet",
    lab: card?.label ?? null,
    promotable: eligibleIn(evidence ?? undefined, state),
  };
}

/** The factors that count in a gated score today: passing cards that apply in this market state. */
export function provenFactors(receipts: Partial<Record<FactorKey, Receipt>>): FactorKey[] {
  return SCORE_FACTORS.map((factor) => factor.key).filter((key) => receipts[key]?.promotable);
}

/** Factors whose card passes, and where (the server's half of the gate: it alone can read the trial record). */
export function passingFactors(cards: Partial<Record<FactorKey, CardSummary | null>>): Array<{ key: FactorKey; worksIn: WorksIn }> {
  return SCORE_FACTORS.flatMap((factor) => {
    const card = cards[factor.key];
    const where = worksIn(card?.label);
    return card && where && cardPasses(card) ? [{ key: factor.key, worksIn: where }] : [];
  });
}

/** The gate for today's market from the server's passing list. */
export const gateFor = (passing: ReadonlyArray<{ key: FactorKey; worksIn: WorksIn }>, state: MarketState | null): FactorKey[] =>
  passing.filter((entry) => appliesIn(entry.worksIn, state)).map((entry) => entry.key);

// ------------------------------------------------------------------ text

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthYear = (day: number) => {
  const date = new Date(day);
  return `${MONTH[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

const WHERE: Record<WorksIn, string> = { any: "any market", up: "uptrends only", down: "downtrends only" };

/** "+0.07R/trade (1d)" or "+0.120% per 10d" */
export function expectancyText(expectancy: Receipt["expectancy"]): string {
  if (!expectancy) return "—";
  const { value, unit, horizon } = expectancy;
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return unit === "R"
    ? `${sign}${Math.abs(value).toFixed(2)}R/trade${horizon ? ` (${horizon}d)` : ""}`
    : `${sign}${Math.abs(value * 100).toFixed(3)}% per ${horizon ?? "?"}d net`;
}

/**
 * The one-line receipt: tested period · where it works · net expectancy · sample · live record · verdict.
 * "Feb 2022–Nov 2026 · uptrends only · +0.07R/trade (1d) · 2,815 trades · live 4/6 · Uptrends only"
 */
export function receiptLine(receipt: Receipt): string {
  if (!receipt.period && !receipt.expectancy) return `Not tested yet — run its report card`;
  const parts = [
    receipt.period ? `${monthYear(receipt.period.from)}–${monthYear(receipt.period.to)}` : null,
    receipt.worksIn ? WHERE[receipt.worksIn] : "no market",
    expectancyText(receipt.expectancy),
    receipt.sample ? `${receipt.sample.n.toLocaleString("en-IN")} ${receipt.sample.unit}` : null,
    receipt.live ? `live ${receipt.live.wins}/${receipt.live.trades}` : null,
    receipt.verdict,
    receipt.subject === "screen" && receipt.lab ? `Lab: ${receipt.lab}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}
