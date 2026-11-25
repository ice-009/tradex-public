"use client";

import "./labTrials.css";
import { useEffect, useState } from "react";
import { api } from "@/client/api";
import type { LabTrialsResponse } from "@/contracts/api";
import type { TrialRow } from "@/core/lab/trials";
import { formatDate, formatRatio } from "./BacktestFormat";

// The "Trials" section of a Signal Lab report (#24): how many variants of the
// idea were tried, the Sharpe ratio luck alone would give the best of them, and
// each variant's deflated Sharpe ratio — the bar a signal has to clear before
// it can feed the score. For the Lab panel (#22) and report cards (#23) to
// embed: pass `summary` when the caller already has it, otherwise `ideaId`
// (it loads /api/lab/trials; change `reloadKey` after a run to refresh).

/** An answer for one request (idea + reload key); anything else on screen is still loading. */
type State = { key: string } & ({ status: "error"; error: string } | { status: "ready"; summary: LabTrialsResponse });

export function LabTrials({ ideaId, summary, reloadKey = 0 }: { ideaId?: string; summary?: LabTrialsResponse; reloadKey?: string | number }) {
  const [state, setState] = useState<State | null>(null);
  const key = `${ideaId ?? ""}\n${reloadKey}`;

  useEffect(() => {
    if (summary || !ideaId) return;
    const controller = new AbortController();
    api
      .labTrials(ideaId, controller.signal)
      .then((answer) => setState({ key, status: "ready", summary: answer }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ key, status: "error", error: error instanceof Error ? error.message : "Couldn't load the trials." });
      });
    return () => controller.abort();
  }, [ideaId, summary, key]);

  if (summary) return <TrialsView summary={summary} />;
  if (!ideaId) return null;
  if (!state || state.key !== key) return <div className="tx-trials tx-dim">Loading trials…</div>;
  if (state.status === "error") return <div className="tx-trials tx-trials-verdict is-error">Trials: {state.error}</div>;
  return <TrialsView summary={state.summary} />;
}

const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const pct = (value: number | null | undefined) => (finite(value) ? `${(value * 100).toFixed(1)}%` : "—");
const signed = (value: number | null | undefined) => (finite(value) ? `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}` : "—");

/** "momentum {"lookback":12}" → ["momentum", "lookback 12"]. */
function describeVariant(variantKey: string, params: Record<string, unknown>): [string, string] {
  const space = variantKey.indexOf(" ");
  const signal = space > 0 ? variantKey.slice(0, space) : variantKey;
  const text = Object.entries(params)
    .map(([key, value]) => `${key} ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join(", ");
  return [signal, text || "default parameters"];
}

export function TrialsView({ summary }: { summary: LabTrialsResponse }) {
  const { n, nEff, runs, sr0Annual, best, threshold, variants } = summary;
  if (!n) return <div className="tx-trials tx-dim">No Lab runs recorded for this idea yet.</div>;
  const verdict = best?.verdict;
  return (
    <div className="tx-trials">
      <div className="tx-trials-head">
        <span className="tx-trials-title">Trials</span>
        <span className="tx-trials-stat" title="Distinct variants × horizons tried for this idea; re-runs of the same variant don't add a trial">
          <b>{n}</b> tried{nEff < n ? <> ({formatRatio(nEff, 1)} effective)</> : null}
          {runs > n ? <span className="tx-dim"> · {runs} runs</span> : null}
        </span>
        <span className="tx-trials-stat" title="Best variant's Sharpe ratio, annualised">
          best Sharpe <b>{formatRatio(best?.annualSharpe)}</b>
        </span>
        <span className="tx-trials-stat" title="The Sharpe ratio (annualised) the best of this many trials would reach by luck alone (Bailey & López de Prado 2014)">
          luck bar <b>{formatRatio(sr0Annual)}</b>
        </span>
        <span className="tx-trials-stat" title={`Deflated Sharpe ratio: probability the best variant's true Sharpe ratio beats the luck bar. Promotion needs ${threshold}.`}>
          DSR <b>{formatRatio(verdict?.dsr, 3)}</b>
        </span>
      </div>
      {verdict && (
        <div className={`tx-trials-verdict ${finite(verdict.dsr) ? (verdict.passes ? "is-pass" : "is-fail") : "is-error"}`}>
          <span className="tx-trials-badge">{verdict.passes ? "Promotable" : "Not promotable"}</span>
          {verdict.reason}
        </div>
      )}
      <div className="tx-trials-wrap">
        <table className="tx-trials-table">
          <thead>
            <tr>
              <th className="is-left">Variant</th>
              <th title="Forward-return horizon, sessions">Horizon</th>
              <th title="Sharpe ratio, annualised">Sharpe/yr</th>
              <th title="Observations">T</th>
              <th title="Skewness of the spread returns">Skew</th>
              <th title="Kurtosis (normal = 3)">Kurt</th>
              <th title="t-stat of the long–short spread">t</th>
              <th title="Probability the true Sharpe ratio is above zero">PSR</th>
              <th title="Probability the true Sharpe ratio beats the luck bar">DSR</th>
              <th className="is-left">Last run</th>
            </tr>
          </thead>
          <tbody>
            {variants.map((row) => (
              <VariantRow key={`${row.variantKey}@${row.horizon}`} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VariantRow({ row }: { row: TrialRow }) {
  const [signal, params] = describeVariant(row.variantKey, row.params);
  const period = `${row.period.from === null ? "all history" : formatDate(row.period.from)} – ${formatDate(row.period.to)}`;
  return (
    <tr>
      <td className="is-left" title={`${row.variantKey}\nTested ${period}\nStamp ${row.stampHash}`}>
        {signal} <code>{params}</code>
      </td>
      <td>{row.horizon}d</td>
      <td className={finite(row.annualSharpe) && row.annualSharpe < 0 ? "is-neg" : undefined}>{signed(row.annualSharpe)}</td>
      <td>{row.T}</td>
      <td>{formatRatio(row.skew)}</td>
      <td>{formatRatio(row.kurt, 1)}</td>
      <td>{signed(row.tStat)}</td>
      <td>{pct(row.psr)}</td>
      <td className={row.passes ? "is-pos" : undefined}>{pct(row.dsr)}</td>
      <td className="is-left tx-dim">
        {new Date(row.runAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
        {row.runs > 1 ? ` (${row.runs} runs)` : ""}
      </td>
    </tr>
  );
}
