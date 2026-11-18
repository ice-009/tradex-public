"use client";

import "./runstamp.css";
import { useEffect, useRef, useState } from "react";
import { compareRuns, shortHash, type RunComparison, type RunStamp } from "@/core/repro/stamp";
import { formatDate } from "./BacktestFormat";

// A run's stamp (what it was computed from, and the hash of its result) with a
// "Re-run this" button: the server runs the stamp again from scratch and the
// two runs are compared here — same inputs and same result hash means the run
// reproduces; otherwise it says which input changed and where the results differ.

export type Replay = { stamp: RunStamp; result: unknown } | { error: string };

const commitLabel = (commit: string) => (commit === "dev" ? "dev build" : commit.replace(/^([0-9a-f]{7})[0-9a-f]*/, "$1"));

export function RunStampBar({ stamp, result, replay, slow }: { stamp: RunStamp; result: unknown; replay: (signal: AbortSignal) => Promise<Replay>; slow?: string }) {
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<{ comparison: RunComparison; replay: RunStamp } | { error: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Callers key this by the stamp, so a new run starts with no comparison.
  useEffect(() => () => abortRef.current?.abort(), []);

  const rerun = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setOutcome(null);
    replay(controller.signal)
      .then((answer) => {
        if (controller.signal.aborted) return;
        setOutcome("error" in answer ? { error: answer.error } : { comparison: compareRuns({ stamp, result }, answer), replay: answer.stamp });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setOutcome({ error: error instanceof Error ? error.message : "The re-run failed." });
      })
      .finally(() => {
        if (abortRef.current === controller) setRunning(false);
      });
  };

  const { data, code } = stamp;
  const parts = Object.entries(data.parts)
    .map(([name, hash]) => `${name} ${shortHash(hash)}`)
    .join(" · ");
  const hub = data.hub ? `Hub ${data.hub.version ?? "?"}, cash bhavcopy ${data.hub.cashBhav ?? "?"}, F&O bhavcopy ${data.hub.foBhav ?? "?"}` : "Hub status not read yet";

  return (
    <div className="tx-stamp">
      <div className="tx-stamp-line">
        <span className="tx-stamp-label">Stamp</span>
        <code title={`Inputs hash (data + code + parameters): ${stamp.hash}`}>{shortHash(stamp.hash)}</code>
        <span className="tx-dim" title={`Data hash ${data.hash}\n${parts}\n${hub}`}>
          data <code>{shortHash(data.hash)}</code> ({data.symbols.length} stocks{data.from !== null && data.to !== null ? `, ${formatDate(data.from)} – ${formatDate(data.to)}` : ""})
        </span>
        <span className="tx-dim" title={`Commit ${code.commit}, engine ${code.engine}`}>
          code <code>{commitLabel(code.commit)}</code> {code.engine}
        </span>
        <span className="tx-dim" title={`Result hash ${stamp.resultHash}`}>
          result <code>{shortHash(stamp.resultHash)}</code>
        </span>
        <button type="button" className="tx-btn tx-btn-outline tx-stamp-btn" disabled={running} onClick={rerun} title="Run this again from scratch with the same parameters, on the data up to the same last session, and compare">
          {running ? "Re-running…" : "Re-run this"}
        </button>
      </div>
      {running && slow && <div className="tx-stamp-note tx-dim">{slow}</div>}
      {outcome && "error" in outcome && <div className="tx-stamp-note is-error">Re-run failed: {outcome.error}</div>}
      {outcome && "comparison" in outcome && <ComparisonView comparison={outcome.comparison} replay={outcome.replay} />}
    </div>
  );
}

function ComparisonView({ comparison, replay }: { comparison: RunComparison; replay: RunStamp }) {
  const { identical, sameInputs, sameResult, changes, differences, totalDifferences } = comparison;
  const headline = identical
    ? `Reproduced: same inputs, identical result hash ${shortHash(replay.resultHash)}.`
    : sameInputs
      ? `Not reproduced: the same inputs gave a different result (${totalDifferences} field${totalDifferences === 1 ? "" : "s"} differ). That is a bug — please report it with this stamp.`
      : sameResult
        ? `Inputs changed, result identical (${shortHash(replay.resultHash)}).`
        : `Inputs changed, so the result differs in ${totalDifferences} field${totalDifferences === 1 ? "" : "s"}.`;
  return (
    <div className={`tx-stamp-result ${identical ? "is-ok" : sameInputs ? "is-bad" : "is-changed"}`}>
      <div className="tx-stamp-headline">{headline}</div>
      {changes.length > 0 && (
        <ul className="tx-stamp-list">
          {changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      )}
      {differences.length > 0 && (
        <table className="tx-stamp-diff">
          <thead>
            <tr>
              <th>Field</th>
              <th>Before</th>
              <th>Re-run</th>
            </tr>
          </thead>
          <tbody>
            {differences.map((difference) => (
              <tr key={difference.path}>
                <td>{difference.path}</td>
                <td>{difference.before}</td>
                <td>{difference.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {totalDifferences > differences.length && <div className="tx-dim tx-stamp-note">…and {totalDifferences - differences.length} more.</div>}
      {!sameInputs && <div className="tx-dim tx-stamp-note">Re-run stamp {shortHash(replay.hash)}.</div>}
    </div>
  );
}
