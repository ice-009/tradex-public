"use client";

import { MONTHS } from "@/core/format";
import { oiTag, oiTooltip, type OiFact } from "@/core/market/openInterest";
import { ivText, type OptionFact } from "@/core/options/summary";
import { receiptLine, type Receipt } from "@/core/lab/receipt";
import { grade, type FactorKey, type SetupScore } from "@/core/screener/score";
import { ReceiptLine } from "./Receipt";

/**
 * Futures OI buildup from the NSE F&O bhavcopy, e.g. "Long buildup · OI +6%".
 * Deliberately neutral (no green/red): it's information, not a signal — it
 * showed no tested edge on its own and isn't part of the score.
 */
export function OiChip({ fact }: { fact: OiFact }) {
  const date = new Date(fact.day);
  const label = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  return (
    <span className="tx-tag tx-tag-oi" title={oiTooltip(fact, label)}>
      {oiTag(fact)}
    </span>
  );
}

/**
 * Options on the hub's newest option day (#36), e.g. "IV 32% · p84": the
 * 30-day IV and its percentile against the stock's own prior year. Neutral,
 * like the OI tag: no option signal has passed the Signal Lab, so it isn't scored.
 */
export function IvChip({ fact }: { fact: OptionFact }) {
  const date = new Date(fact.day);
  const label = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  const tip = [
    `Options on ${label}: 30-day ATM IV ${ivText(fact.iv30)}`,
    fact.ivPercentile !== null ? `Higher than on ${fact.ivPercentile.toFixed(0)}% of the days in the year up to then` : "Too few days in the year before to rank it (needs 60)",
    fact.movePct !== null ? `Near straddle prices a move of ±${fact.movePct.toFixed(1)}% over ${fact.moveDays} days` : null,
    fact.pcrOi !== null ? `Put–call ratio (OI) ${fact.pcrOi.toFixed(2)}` : null,
    "Information only, not scored: no option signal has passed the Signal Lab yet.",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span className="tx-tag tx-tag-iv" title={tip}>
      IV {(fact.iv30 * 100).toFixed(0)}%{fact.ivPercentile !== null ? ` · p${fact.ivPercentile.toFixed(0)}` : ""}
    </span>
  );
}

const GATING_NOTE: Record<SetupScore["gating"], string | null> = {
  off: null,
  on: "Only factors with a passing report card count; their points are scaled to 100.",
  unproven: "Unproven: no factor has a passing report card yet, so this score is a checklist for comparing setups, not evidence. All factors still count, so the order doesn't change.",
};

/** "A 78" chip; the tooltip lists the points. Dashed when no factor is proven (#29). */
export function ScoreChip({ score, size = "sm", receipts }: { score: SetupScore | null; size?: "sm" | "lg"; receipts?: Partial<Record<FactorKey, Receipt>> | null }) {
  if (!score) return <span className="tx-dim">—</span>;
  const { letter, tone } = grade(score.total);
  const tip = [
    ...(GATING_NOTE[score.gating] ? [GATING_NOTE[score.gating]!, ""] : []),
    ...score.parts.map((part) => {
      const receipt = receipts?.[part.key];
      return `${part.proven === false ? "○ " : part.proven ? "✓ " : ""}${part.label}: ${part.points}/${part.max} — ${part.detail}${receipt ? `\n    ${receiptLine(receipt)}` : ""}`;
    }),
    ...score.penalties.map((penalty) => `${penalty.label}: ${penalty.points}`),
  ].join("\n");
  return (
    <span className={`tx-score tx-score-${size} tx-tone-${tone} ${score.gating === "unproven" ? "is-unproven" : ""}`} title={tip} data-gating={score.gating}>
      <b>{letter}</b>
      {score.total}
    </span>
  );
}

/** Points per factor as bars, each with its receipt (#29) when given, plus penalties. Unproven factors are greyed out. */
export function ScoreBreakdown({ score, receipts }: { score: SetupScore; receipts?: Partial<Record<FactorKey, Receipt>> | null }) {
  return (
    <div className="tx-breakdown">
      {GATING_NOTE[score.gating] && <p className="tx-breakdown-note">{GATING_NOTE[score.gating]}</p>}
      {score.parts.map((part) => {
        const receipt = receipts?.[part.key];
        return (
          <div key={part.key} className={`tx-breakdown-row ${part.proven === false ? "is-unproven" : ""}`} title={part.detail}>
            <span className="tx-breakdown-label">{part.label}</span>
            <span className="tx-breakdown-bar" aria-hidden>
              <i style={{ width: `${(part.points / part.max) * 100}%` }} className={part.points / part.max >= 0.66 ? "is-good" : part.points / part.max >= 0.33 ? "is-mid" : "is-low"} />
            </span>
            <span className="tx-breakdown-pts">
              {part.points}
              <small>/{part.max}</small>
            </span>
            <span className="tx-breakdown-detail">{part.detail}</span>
            {receipt && <ReceiptLine receipt={receipt} />}
          </div>
        );
      })}
      {score.penalties.map((penalty) => (
        <div key={penalty.label} className="tx-breakdown-row is-penalty">
          <span className="tx-breakdown-label">Penalty</span>
          <span className="tx-breakdown-detail">{penalty.label}</span>
          <span className="tx-breakdown-pts">{penalty.points}</span>
        </div>
      ))}
    </div>
  );
}
