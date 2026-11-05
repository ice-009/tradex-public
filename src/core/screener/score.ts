import type { Features, PatternSummary } from "@/core/screener/features";
import type { TradePlan } from "@/core/screener/screens";

// Setup score: 100 points across eight factors, minus penalties, so five or
// ten candidates can be compared on one scale ("which one do I take?").
// Each factor is a published idea, weighted equally-ish on purpose — this is
// a checklist with points, not a fitted model.
//
//   Trend            15  close > 50 SMA > 200 SMA, rising 200 SMA, > 20 EMA (Minervini trend template)
//   Relative strength 15 RS rank in the universe (IBD-style; George & Hwang)
//   Accumulation     10  up-day vs down-day volume, delivery % vs its average (Varsity / NSE delivery data)
//   Pattern          15  quality and stage of the best chart pattern (breakout > forming)
//   Reward : risk    15  target vs stop, using the nearer of target and resistance
//   Stop distance    10  2–6% is ideal for a 2–4 week trade; > 8% breaks O'Neil's rule
//   Not extended     10  distance above the 20 EMA in ATRs (chasing reduces R:R)
//   Track record     10  how this setup's rules did in the replay (avg R)
//   Penalties            results inside the holding period, recent heavy gap-down, bearish pattern

/** Everything the score needs about a stock, computed on the server from its features. */
export interface StockFacts {
  close: number;
  changePct: number;
  /** Where today closed in its range: 0 = at the low, 1 = at the high (absent from older servers). */
  clv?: number;
  aboveSma50: boolean;
  sma50AboveSma200: boolean;
  sma200Rising: boolean;
  aboveEma20: boolean;
  rsRank: number;
  volRatio20: number;
  /** Delivery % ÷ its 20-day average (null when unavailable). */
  deliveryRatio: number | null;
  upDownVol20: number;
  pattern: PatternSummary | null;
  bearishPattern: string | null;
  ext20Atr: number;
  atr14: number;
  resistance: number | null;
  support: number | null;
  chandelier: number;
  turnoverCr: number;
}

const finiteOrNull = (value: number) => (Number.isFinite(value) ? value : null);

export function factsFrom(f: Features): StockFacts {
  return {
    close: f.close,
    changePct: f.changePct,
    clv: f.clv,
    aboveSma50: f.close > f.sma50,
    sma50AboveSma200: f.sma50 > f.sma200,
    sma200Rising: f.sma200 > f.sma200Prev22,
    aboveEma20: f.close > f.ema20,
    rsRank: f.rsRank,
    volRatio20: f.volRatio20,
    deliveryRatio: Number.isFinite(f.deliveryPct) && f.deliveryAvg20 > 0 ? f.deliveryPct / f.deliveryAvg20 : null,
    upDownVol20: f.upDownVol20,
    pattern: f.pattern,
    bearishPattern: f.bearishPattern,
    ext20Atr: f.ext20Atr,
    atr14: f.atr14,
    resistance: finiteOrNull(f.resistance),
    support: finiteOrNull(f.support),
    chandelier: f.chandelier,
    turnoverCr: f.turnoverCr20,
  };
}

export interface ScorePart {
  key: string;
  label: string;
  points: number;
  max: number;
  detail: string;
}

export interface SetupScore {
  total: number;
  parts: ScorePart[];
  penalties: Array<{ label: string; points: number }>;
  /** Reward:risk to the nearer of the target and the next resistance. */
  effectiveRR: number | null;
  /** Resistance sitting between entry and target, if any. */
  resistanceInWay: number | null;
}

export interface ScoreOptions {
  /** Replay record of the setup this plan comes from (null: no setup / not loaded). */
  track?: { avgR: number | null; signals: number } | null;
  /** Days until results (negative = already out), null when unknown. */
  resultsInDays?: number | null;
  /** Sessions the plan is meant to be held. */
  holdDays: number;
  warnings?: string[];
  /** The setup buys weakness on purpose (mean reversion): a red day isn't penalised. */
  buysWeakness?: boolean;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

export function scoreSetup(facts: StockFacts, plan: TradePlan, options: ScoreOptions): SetupScore {
  const parts: ScorePart[] = [];
  const risk = plan.entry - plan.stop;

  // Trend (15)
  const trendBits = [
    [facts.aboveSma50, 4, "> 50 SMA"],
    [facts.sma50AboveSma200, 4, "50 > 200 SMA"],
    [facts.sma200Rising, 3, "200 SMA rising"],
    [facts.aboveEma20, 4, "> 20 EMA"],
  ] as const;
  parts.push({
    key: "trend",
    label: "Trend",
    max: 15,
    points: trendBits.reduce((sum, [ok, pts]) => sum + (ok ? pts : 0), 0),
    detail: trendBits.map(([ok, , label]) => `${ok ? "✓" : "✗"} ${label}`).join(" · "),
  });

  // Relative strength (15)
  const rs = Number.isFinite(facts.rsRank) ? facts.rsRank : 50;
  parts.push({ key: "rs", label: "Relative strength", max: 15, points: round1((clamp(rs, 1, 99) / 99) * 15), detail: `RS rank ${Math.round(rs)} of 99 in the universe` });

  // Accumulation (10): up/down volume (6) + delivery vs its average (4)
  const ud = Number.isFinite(facts.upDownVol20) ? facts.upDownVol20 : 1;
  const udPts = clamp((ud - 0.8) / (1.8 - 0.8), 0, 1) * 6;
  const del = facts.deliveryRatio;
  const delPts = del === null ? 2 : clamp((del - 0.8) / (1.5 - 0.8), 0, 1) * 4;
  parts.push({
    key: "accumulation",
    label: "Accumulation",
    max: 10,
    points: round1(udPts + delPts),
    detail: `Up/down volume ${ud.toFixed(2)}×${del === null ? " · delivery n/a" : ` · delivery ${del.toFixed(2)}× its average`}`,
  });

  // Pattern (15)
  const pattern = facts.pattern;
  const patternPts = !pattern
    ? 0
    : (pattern.quality / 100) * (pattern.status === "breakout" ? 15 : pattern.status === "forming" ? 12 : 4);
  parts.push({
    key: "pattern",
    label: "Chart pattern",
    max: 15,
    points: round1(patternPts),
    detail: pattern ? `${pattern.name} · ${pattern.status}${pattern.status === "breakout" && pattern.breakoutAgo !== null ? ` ${pattern.breakoutAgo}d ago` : ""} · quality ${pattern.quality}` : "No clear pattern",
  });

  // Reward:risk (15), to the nearer of target and resistance in the way
  const resistanceInWay =
    plan.target !== null && facts.resistance !== null && facts.resistance > plan.entry + 0.25 * risk && facts.resistance < plan.target ? facts.resistance : null;
  const effTarget = plan.target === null ? null : resistanceInWay ?? plan.target;
  const effectiveRR = effTarget !== null && risk > 0 ? (effTarget - plan.entry) / risk : null;
  const rrPts = effectiveRR === null ? 7 : clamp(((effectiveRR - 1) / (3 - 1)) * 15, 0, 15);
  parts.push({
    key: "rr",
    label: "Reward : risk",
    max: 15,
    points: round1(rrPts),
    detail:
      effectiveRR === null
        ? "Trailing exit — no fixed target"
        : `${effectiveRR.toFixed(1)}R${resistanceInWay !== null ? ` to resistance at ${resistanceInWay.toFixed(2)} (before the target)` : " to target"}`,
  });

  // Stop distance (10)
  const stopPct = risk > 0 ? (risk / plan.entry) * 100 : NaN;
  const stopPts = !Number.isFinite(stopPct) ? 0 : stopPct < 1 ? 3 : stopPct < 2 ? 7 : stopPct <= 6 ? 10 : stopPct <= 8 ? 6 : 2;
  parts.push({
    key: "stop",
    label: "Stop distance",
    max: 10,
    points: stopPts,
    detail: Number.isFinite(stopPct) ? `${stopPct.toFixed(1)}% below entry${stopPct < 1 ? " — inside normal noise" : stopPct > 8 ? " — wider than the 8% rule" : ""}` : "—",
  });

  // Not extended (10)
  const ext = Number.isFinite(facts.ext20Atr) ? facts.ext20Atr : 0;
  const extPts = ext <= 1.5 ? 10 : ext <= 2.5 ? 6 : ext <= 3.5 ? 3 : 0;
  parts.push({ key: "extension", label: "Not extended", max: 10, points: extPts, detail: `${ext.toFixed(1)} ATR ${ext >= 0 ? "above" : "below"} the 20 EMA` });

  // Track record (10)
  const track = options.track;
  const trackPts =
    !track || track.avgR === null || track.signals < 20 ? 5 : track.avgR >= 0.3 ? 10 : track.avgR >= 0.1 ? 7.5 : track.avgR > -0.1 ? 4 : 0;
  parts.push({
    key: "track",
    label: "Track record",
    max: 10,
    points: trackPts,
    detail: !track || track.avgR === null ? "No replay for this plan (neutral 5)" : track.signals < 20 ? `Only ${track.signals} past signals (neutral 5)` : `Avg ${track.avgR >= 0 ? "+" : ""}${track.avgR.toFixed(2)}R over ${track.signals} past signals`,
  });

  // Penalties
  const penalties: SetupScore["penalties"] = [];
  const days = options.resultsInDays;
  if (days !== null && days !== undefined && days >= 0 && days <= options.holdDays) {
    penalties.push({ label: days <= 1 ? "Results within a day" : `Results in ${days} days — inside the holding period`, points: days <= 1 ? -15 : -10 });
  }
  if (options.warnings?.length) penalties.push({ label: "Recent heavy gap-down", points: -8 });
  // Buying "now" into a falling day: the plan enters at the current price while the
  // stock is down and closing near its low (worse on heavy volume — distribution).
  // A buy-stop entry only fills on strength, and mean-reversion setups buy dips on purpose.
  const marketEntry = plan.entry <= facts.close * 1.0005;
  if (!options.buysWeakness && marketEntry && facts.changePct <= -1 && facts.clv !== undefined && facts.clv < 0.4) {
    const heavy = facts.volRatio20 >= 1.3;
    penalties.push(
      heavy
        ? { label: `Down ${facts.changePct.toFixed(1)}% on ${facts.volRatio20.toFixed(1)}× volume today (distribution) — wait`, points: -12 }
        : { label: `Falling today (${facts.changePct.toFixed(1)}%), closing near the low — wait for it to turn`, points: -8 },
    );
  }
  if (facts.bearishPattern) penalties.push({ label: `${facts.bearishPattern} forming`, points: -5 });
  if (facts.turnoverCr < 5) penalties.push({ label: "Thin turnover (< ₹5 cr/day)", points: -5 });

  const total = clamp(Math.round(parts.reduce((sum, part) => sum + part.points, 0) + penalties.reduce((sum, p) => sum + p.points, 0)), 0, 100);
  return { total, parts, penalties, effectiveRR, resistanceInWay };
}

/** Grade for a total score. */
export function grade(total: number): { letter: string; tone: "good" | "flat" | "bad" } {
  if (total >= 75) return { letter: "A", tone: "good" };
  if (total >= 60) return { letter: "B", tone: "good" };
  if (total >= 45) return { letter: "C", tone: "flat" };
  return { letter: "D", tone: "bad" };
}
