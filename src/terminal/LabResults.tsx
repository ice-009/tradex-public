"use client";

import type { LabResponse } from "@/contracts/api";
import type { HorizonReport, LabReport, SpreadPair } from "@/core/lab/engine";
import { isoDay, num, pct, share, turnoverRows, verdictOf } from "@/core/lab/format";
import { api } from "@/client/api";
import { LabTrials } from "./LabTrials";
import { RunStampBar, type Replay } from "./RunStampBar";

// A Signal Lab report (src/core/lab/engine.ts), as tables — the same numbers
// the CLI prints (src/core/lab/format.ts). Charts are kept to one: the decay
// of the spread by horizon. The report card with more charts is #23.

type Ready = Extract<LabResponse, { status: "ready" }>;

const replay =
  (data: Ready) =>
  async (signal: AbortSignal): Promise<Replay> => {
    const answer = await api.replayLab({ stamp: data.stamp }, signal);
    return answer.status === "error" ? { error: answer.error } : { stamp: answer.stamp, result: answer.report };
  };

const tone = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) || value === 0 ? "" : value > 0 ? "is-pos" : "is-neg");
/** A t-stat beyond ±2 is shown bold. */
const tCell = (t: number | null) => <td className={Math.abs(t ?? 0) >= 2 ? "tx-lab-strong" : ""}>{num(t)}</td>;

const VERDICT: Record<ReturnType<typeof verdictOf>, { label: string; title: string }> = {
  PASS: { label: "Edge", title: "Net spread > 0 in the first 60% and the last 40% of the period, Newey–West t > 2, at least 30 days" },
  weak: { label: "Weak", title: "Net spread above zero, but not in both parts or not with t > 2" },
  none: { label: "None", title: "Net spread at or below zero" },
};

export function LabResults({ data }: { data: Ready }) {
  const { report, stamp, trials } = data;
  const { period, universe, signal } = report;
  const params = Object.entries(signal.params)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
  return (
    <div className="tx-bt-results tx-lab-results">
      <p className="tx-bt-basis">
        <b>{signal.name}</b>
        {params ? ` (${params})` : ""} · {isoDay(period.from)} – {isoDay(period.to)} · <b>{period.days}</b> ranked sessions · {universe.symbols} stocks, {universe.perDay.mean.toFixed(0)} a
        day · Q{report.quantiles} = highest values · costs {pct(report.costPerTrade, 3)} a round trip ({data.costs.label}) · {report.observations.toLocaleString("en-IN")} observations
        {data.runtime.cached ? " · cached" : ""}
      </p>

      <RunStampBar key={`${stamp.hash}:${stamp.resultHash}`} stamp={stamp} result={report} replay={replay(data)} slow="Reading and computing again from scratch (no cache)." />

      {report.notes.length > 0 && (
        <ul className="tx-bt-warnings">
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      <section className="tx-bt-card">
        <h3>
          Long–short spread (Q{report.quantiles} − Q1) <span className="tx-dim">per formation day; t-stats Newey–West, lag h − 1, for the overlapping returns</span>
        </h3>
        <div className="tx-lab-wrap">
          <table className="tx-bt-table tx-lab-table">
            <thead>
              <tr>
                <th className="is-left">Horizon</th>
                <th>Gross</th>
                <th>Net</th>
                <th>t (net)</th>
                <th>Days</th>
                <th title="Net spread, non-overlapping, annualised">Sharpe / yr</th>
                <th title="Share of days the net spread was positive">Hit</th>
                <th title="Rank correlation of signal and forward return per day (information coefficient)">IC</th>
                <th>IC t</th>
                <th title="If each leg is held between rebalances every h sessions and only replaced stocks pay costs">Net @ turnover</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {report.byHorizon.map((h) => {
                const verdict = VERDICT[verdictOf(h)];
                return (
                  <tr key={h.horizon} className="is-static">
                    <th className="is-left">{h.horizon}d</th>
                    <td className={tone(h.spread.gross.mean)}>{pct(h.spread.gross.mean, 3)}</td>
                    <td className={tone(h.spread.net.mean)}>{pct(h.spread.net.mean, 3)}</td>
                    {tCell(h.spread.net.t)}
                    <td>{h.spread.net.n}</td>
                    <td>{num(h.sharpeAnnual)}</td>
                    <td>{share(h.spread.net.hitRate)}</td>
                    <td>{num(h.ic.mean, 3)}</td>
                    {tCell(h.ic.t)}
                    <td className={tone(h.netAtTurnover)}>{pct(h.netAtTurnover, 3)}</td>
                    <td title={verdict.title} className={verdictOf(h) === "PASS" ? "is-pos" : ""}>
                      {verdict.label}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="tx-bt-two">
        <section className="tx-bt-card">
          <h3>
            Bucket returns <span className="tx-dim">gross, mean per day (t)</span>
          </h3>
          <QuantileTable report={report} />
        </section>
        <section className="tx-bt-card">
          <h3>
            Decay <span className="tx-dim">spread by horizon, gross; bars: that session alone</span>
          </h3>
          <DecayChart report={report} />
        </section>
      </div>

      <section className="tx-bt-card">
        <h3>
          Net spread by market regime and over time{" "}
          <span className="tx-dim">NIFTY above / below its 200-day average on the formation day; first 60% / last 40% of days (split {isoDay(report.byHorizon[0]?.split.splitDate)})</span>
        </h3>
        <div className="tx-lab-wrap">
          <table className="tx-bt-table tx-lab-table">
            <thead>
              <tr>
                <th className="is-left">Horizon</th>
                <th colSpan={3}>NIFTY up</th>
                <th colSpan={3}>NIFTY down</th>
                <th colSpan={3}>First 60%</th>
                <th colSpan={3}>Last 40%</th>
              </tr>
            </thead>
            <tbody>
              {report.byHorizon.map((h) => (
                <tr key={h.horizon} className="is-static">
                  <th className="is-left">{h.horizon}d</th>
                  <SplitCells pair={h.regimes.up} />
                  <SplitCells pair={h.regimes.down} />
                  <SplitCells pair={h.split.first} />
                  <SplitCells pair={h.split.last} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="tx-bt-two">
        <section className="tx-bt-card">
          <h3>
            Turnover <span className="tx-dim">share of a leg replaced since the last rebalance</span>
          </h3>
          <table className="tx-bt-table tx-lab-table">
            <thead>
              <tr>
                <th className="is-left">Rebalance</th>
                <th>Long</th>
                <th>Short</th>
                {Array.from({ length: report.quantiles }, (_, b) => (
                  <th key={b}>Q{b + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {turnoverRows(report).map(({ label, turnover }) => (
                <tr key={label} className="is-static">
                  <th className="is-left">{label}</th>
                  <td>{share(turnover.long)}</td>
                  <td>{share(turnover.short)}</td>
                  {turnover.buckets.map((value, b) => (
                    <td key={b}>{share(value)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="tx-bt-card">
          <h3>
            Multiple testing <span className="tx-dim">every run is a trial; the deflated Sharpe ratio counts them all</span>
          </h3>
          {trials.error ? (
            <div className="tx-trials-verdict is-error">This run&apos;s trials were NOT recorded: {trials.error}</div>
          ) : (
            <LabTrials ideaId={trials.ideaId} reloadKey={stamp.hash} />
          )}
          {trials.skipped.length > 0 && (
            <p className="tx-bt-small tx-dim">Not recorded: {trials.skipped.map((entry) => `${entry.horizon}d (${entry.reason})`).join("; ")}.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function SplitCells({ pair }: { pair: SpreadPair }) {
  return (
    <>
      <td className={tone(pair.net.mean)}>{pct(pair.net.mean, 3)}</td>
      {tCell(pair.net.t)}
      <td className="tx-dim">{pair.net.n}</td>
    </>
  );
}

function QuantileTable({ report }: { report: LabReport }) {
  const first = report.byHorizon[0];
  return (
    <div className="tx-lab-wrap">
      <table className="tx-bt-table tx-lab-table">
        <thead>
          <tr>
            <th className="is-left">Bucket</th>
            <th>Stocks</th>
            {report.byHorizon.map((h) => (
              <th key={h.horizon}>{h.horizon}d</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: report.quantiles }, (_, b) => (
            <tr key={b} className="is-static">
              <th className="is-left">Q{b + 1}</th>
              <td>{first ? first.quantiles[b].stocks.toFixed(1) : "—"}</td>
              {report.byHorizon.map((h: HorizonReport) => (
                <td key={h.horizon} className={tone(h.quantiles[b].gross)}>
                  {pct(h.quantiles[b].gross, 3)} <span className="tx-dim">({num(h.quantiles[b].t, 1)})</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Cumulative gross spread by horizon (line) and each session's own spread (bars), as an SVG. */
function DecayChart({ report }: { report: LabReport }) {
  const points = report.decay;
  if (!points.length) return null;
  const width = 420;
  const height = 150;
  const pad = { left: 44, right: 8, top: 8, bottom: 20 };
  const values = points.flatMap((p) => [p.gross ?? 0, p.marginal ?? 0, 0]);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (i: number) => pad.left + ((i + 0.5) / points.length) * (width - pad.left - pad.right);
  const y = (v: number) => pad.top + ((hi - v) / span) * (height - pad.top - pad.bottom);
  const barWidth = Math.max(2, ((width - pad.left - pad.right) / points.length) * 0.6);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.gross ?? 0).toFixed(1)}`).join("");
  return (
    <div className="tx-bt-chart tx-lab-decay">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="Spread by horizon">
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} className="tx-lab-axis" />
        <text x={pad.left - 6} y={y(hi) + 4} className="tx-lab-tick" textAnchor="end">
          {pct(hi, 2)}
        </text>
        <text x={pad.left - 6} y={y(lo) + 4} className="tx-lab-tick" textAnchor="end">
          {pct(lo, 2)}
        </text>
        {points.map((p, i) => (
          <rect
            key={p.horizon}
            x={x(i) - barWidth / 2}
            width={barWidth}
            y={Math.min(y(0), y(p.marginal ?? 0))}
            height={Math.abs(y(p.marginal ?? 0) - y(0))}
            className={(p.marginal ?? 0) >= 0 ? "tx-lab-bar is-pos" : "tx-lab-bar is-neg"}
          >
            <title>{`Session ${p.horizon} alone: ${pct(p.marginal, 3)} (t ${num(p.marginalT)}); cumulative ${pct(p.gross, 3)} (t ${num(p.t)}), net ${pct(p.net, 3)}`}</title>
          </rect>
        ))}
        <path d={line} className="tx-lab-line" />
        {points.map((p, i) =>
          p.horizon === 1 || p.horizon % 5 === 0 || p.horizon === points.length ? (
            <text key={p.horizon} x={x(i)} y={height - 6} className="tx-lab-tick" textAnchor="middle">
              {p.horizon}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}
