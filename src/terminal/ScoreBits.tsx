"use client";

import { MONTHS } from "@/core/format";
import { oiTag, oiTooltip, type OiFact } from "@/core/market/openInterest";
import { grade, type SetupScore } from "@/core/screener/score";

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

/** "A 78" chip; the tooltip lists the points. */
export function ScoreChip({ score, size = "sm" }: { score: SetupScore | null; size?: "sm" | "lg" }) {
  if (!score) return <span className="tx-dim">—</span>;
  const { letter, tone } = grade(score.total);
  const tip = [
    ...score.parts.map((part) => `${part.label}: ${part.points}/${part.max} — ${part.detail}`),
    ...score.penalties.map((penalty) => `${penalty.label}: ${penalty.points}`),
  ].join("\n");
  return (
    <span className={`tx-score tx-score-${size} tx-tone-${tone}`} title={tip}>
      <b>{letter}</b>
      {score.total}
    </span>
  );
}

/** Points per factor as bars, plus penalties. */
export function ScoreBreakdown({ score }: { score: SetupScore }) {
  return (
    <div className="tx-breakdown">
      {score.parts.map((part) => (
        <div key={part.key} className="tx-breakdown-row" title={part.detail}>
          <span className="tx-breakdown-label">{part.label}</span>
          <span className="tx-breakdown-bar" aria-hidden>
            <i style={{ width: `${(part.points / part.max) * 100}%` }} className={part.points / part.max >= 0.66 ? "is-good" : part.points / part.max >= 0.33 ? "is-mid" : "is-low"} />
          </span>
          <span className="tx-breakdown-pts">
            {part.points}
            <small>/{part.max}</small>
          </span>
          <span className="tx-breakdown-detail">{part.detail}</span>
        </div>
      ))}
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
