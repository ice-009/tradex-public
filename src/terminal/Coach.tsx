"use client";

import { useEffect, useState } from "react";
import "./coach.css";
import type { CoachResponse, TradesResponse } from "@/contracts/api";
import { MIN_SAMPLE, type Bounds, type CoachReport, type TradeReview } from "@/core/plan/coach";
import { signedR } from "@/core/plan/evidence";
import { SCREEN_MAP } from "@/core/screener/screens";
import { api } from "@/client/api";

// The trade coach (#42) in the Plan tab's journal column: findings with their
// samples, the plan's rules and how often you broke them, and per closed trade
// MAE / MFE, the share of the best price you kept, the hold against the plan
// and your exit against the plan's own. The rules are in
// src/core/plan/coach.ts; this file only shows them. Live only: the journal
// column shows a note instead in the Time Machine.

const day = (time: number) => new Date(time).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const plain = (value: number) => `${value.toFixed(2)}R`;
// MAE and MFE are magnitudes (≥ 0): shown without a sign.
/** One figure when the bounds agree to 0.05R, else "low–high". */
const bounds = (value: Bounds) => (value.high - value.low < 0.05 ? plain(value.low) : `${value.low.toFixed(2)}–${plain(value.high)}`);
const share = (value: Bounds | null) => {
  if (!value) return "—";
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return value.high - value.low < 0.05 ? pct(value.low) : `${pct(value.low)}–${pct(value.high)}`;
};

export function Coach({ trades }: { trades: TradesResponse | null }) {
  const [answer, setAnswer] = useState<CoachResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Re-read whenever the journal reloads (a trade taken, edited or closed); the server keeps the report 10 minutes otherwise.
  useEffect(() => {
    if (!trades) return;
    let stopped = false;
    api
      .coach()
      .then((next) => {
        if (stopped) return;
        setAnswer(next);
        setError(null);
      })
      .catch((err: Error) => {
        if (!stopped) setError(err.message);
      });
    return () => {
      stopped = true;
    };
  }, [trades]);

  const report = answer?.status === "ready" ? answer.report : null;
  return (
    <section className="tx-plan-section tx-coach">
      <div className="tx-plan-title">
        COACH <span className="tx-dim">{report ? `your journal · ${report.closed} closed${report.open ? ` · ${report.open} open` : ""}` : "your journal"}</span>
      </div>
      {!answer ? (
        <div className="tx-plan-empty">{error ? `The coach couldn't read your journal: ${error}` : "Reviewing your journal…"}</div>
      ) : answer.status !== "ready" ? (
        <div className="tx-plan-empty">{answer.error}</div>
      ) : report && report.closed === 0 ? (
        <div className="tx-plan-empty tx-coach-empty">
          No closed trades yet. Once you close some, the coach shows how far each went against and for you (MAE / MFE), your exit against the plan&apos;s own exit, and which of the
          plan&apos;s rules you broke: buying outside 3:15–3:25 PM, moving the stop, taking more lots than it sized, holding past its exit. Findings need at least {MIN_SAMPLE} closed trades.
        </div>
      ) : report ? (
        <CoachBody report={report} />
      ) : null}
    </section>
  );
}

function CoachBody({ report }: { report: CoachReport }) {
  const [open, setOpen] = useState(false);
  const closed = report.reviews.filter((review) => review.status === "closed");
  const { intraday, daily, none } = report.resolution;
  return (
    <>
      <ul className="tx-coach-findings">
        {report.findings.map((finding) => (
          <li key={finding.id} className={finding.mean === null ? "is-few" : finding.clear ? "is-clear" : "is-unclear"} data-finding={finding.id}>
            <b>{finding.label}</b> <span>{finding.text}</span>
          </li>
        ))}
      </ul>
      <div className="tx-plan-table-wrap">
        <table className="tx-scr-track tx-coach-rules">
          <thead>
            <tr>
              <th className="is-left">The plan&apos;s rules</th>
              <th title="Trades that broke it, of those it could be checked on">Broken</th>
              <th title="Trades it couldn't be checked on (hover for why)">Unchecked</th>
            </tr>
          </thead>
          <tbody>
            {report.rules.map((rule) => (
              <tr key={rule.rule} data-rule={rule.rule}>
                <td className="is-left">{rule.label}</td>
                <td className={rule.broken ? "is-down" : ""}>
                  {rule.checked ? `${rule.broken} of ${rule.checked}` : "—"}
                </td>
                <td title={rule.why.map((item) => `${item.trades}: ${item.reason}`).join("\n") || undefined}>{rule.unchecked || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="tx-scr-note">
        R is on the planned risk (planned entry − the stop when you took the trade), before charges. Intervals are 95% t intervals over your trades, which aren&apos;t independent draws
        (they share days and markets), so read them as rough. MAE / MFE: {intraday} on 15-minute candles, {daily} on daily-bar bounds{none ? `, ${none} not measured` : ""}.
        {report.planPending ? ` ${report.planPending} trade${report.planPending === 1 ? "" : "s"} left out of “vs the plan”: its exit hasn't come yet in the stored bars.` : ""}{" "}
        <button type="button" className="tx-scr-clear" onClick={() => setOpen(!open)}>
          {open ? "Hide trades" : "Show trades"}
        </button>
      </p>
      {open && <ReviewTable reviews={closed} />}
    </>
  );
}

function ReviewTable({ reviews }: { reviews: TradeReview[] }) {
  return (
    <div className="tx-plan-table-wrap">
      <table className="tx-scr-track tx-coach-trades">
        <thead>
          <tr>
            <th className="is-left">Closed</th>
            <th className="is-left">Stock</th>
            <th title="Your result, before charges">R</th>
            <th title="How far it went against you, R. Two figures: daily-bar bounds (the second counts the whole entry and exit days)">MAE</th>
            <th title="How far it went for you, R">MFE</th>
            <th title="Your exit's move ÷ the MFE (100% = sold at the best price), shown when the MFE was at least 0.5R">Kept</th>
            <th title="Sessions held after the entry session / the plan's exit session">Held</th>
            <th title="Your R − the R of the plan's own exit (negative = the plan would have done better)">vs plan</th>
            <th className="is-left">Rules broken</th>
          </tr>
        </thead>
        <tbody>
          {reviews.map((review) => (
            <tr key={review.id} data-trade={review.id}>
              <td className="is-left">{review.exitDay ? day(review.exitDay) : "—"}</td>
              <td className="is-left" title={SCREEN_MAP[review.screenId]?.name ?? review.screenId}>
                {review.symbol}
              </td>
              <td className={(review.r ?? 0) >= 0 ? "is-up" : "is-down"}>{signedR(review.r)}</td>
              <td title={review.excursion?.note ?? review.excursionWhy ?? undefined}>
                {review.excursion ? (
                  <>
                    {bounds(review.excursion.mae)} <span className="tx-dim">{review.excursion.resolution === "intraday" ? "15m" : "D"}</span>
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td title={review.excursion?.note ?? review.excursionWhy ?? undefined}>{review.excursion ? bounds(review.excursion.mfe) : "—"}</td>
              <td>{share(review.excursion?.efficiency ?? null)}</td>
              <td title={review.planExit ? `The plan's ${review.planExit.reason} exit: session ${review.planExit.session} (${day(review.planExit.day)}) at ${review.planExit.price.toFixed(2)}` : (review.planExitWhy ?? undefined)}>
                {review.held ?? "—"} / {review.planExit?.session ?? "—"}
              </td>
              <td className={(review.vsPlanR ?? 0) < 0 ? "is-down" : ""}>{signedR(review.vsPlanR)}</td>
              <td className="is-left tx-coach-breaks">{review.breaks.length ? review.breaks.map((entry) => entry.text).join(" · ") : review.unchecked.length ? <span className="tx-dim">none found ({review.unchecked.length} not checked)</span> : "none"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
