"use client";

import { useMemo, useState } from "react";
import "./ledger.css";
import type { PlanLedgerResponse, PlanLedgerVerifyResponse } from "@/contracts/api";
import { formatPrice } from "@/core/format";
import { istParts } from "@/core/market/session";
import { exitShort } from "@/core/plan/instructions";
import { compareToSeal, type LedgerRecord, type SealDrift, type SealKind } from "@/core/plan/seal";
import { SEAL_WINDOWS } from "@/core/plan/sealSchedule";
import { shortHash } from "@/core/repro/stamp";
import { SCREEN_MAP } from "@/core/screener/screens";
import { useLedgerFeed } from "@/client/ledgerFeed";
import { useTimeMachine } from "@/client/timeMachine";
import { useTerminal } from "./store";
import { useLiveRanking } from "./usePlan";

// The sealed plan (#33) in the Plan tab: today's plan as the server sealed it
// at 3:15 PM (and on the evening's final bars), how the live plan has moved
// since, and the ledger of past days with each seal's hash and a "Verify"
// button that checks the whole chain on the server. The rules are in
// src/core/plan/seal.ts; this file only shows them.

const time = (at: number) => new Date(at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
const dayLabel = (day: number) => new Date(day).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const windowLabel = (minutes: number) => `${Math.floor(minutes / 60) - 12}:${String(minutes % 60).padStart(2, "0")} PM`;
const screenName = (id: string) => SCREEN_MAP[id]?.name ?? id;
const EMPTY: string[] = [];

export function PlanLedger() {
  const pastDay = useTimeMachine((state) => state.info?.label ?? state.asOf);
  // Its own note (not LiveOnlyNote): the journal column already shows that one in the Time Machine.
  if (pastDay) return <p className="tx-scr-note tx-ledger-past">The sealed-plan ledger is a live record, made by the server each day at {windowLabel(SEAL_WINDOWS.close.from)}, so it isn&apos;t shown as of {pastDay}.</p>;
  return <LedgerSection />;
}

function LedgerSection() {
  const { ledger, error, verification, verifying, verify } = useLedgerFeed();
  const [open, setOpen] = useState(false);
  const ready = ledger?.status === "ready" ? ledger : null;
  const today = ready ? ready.entries.filter((record) => record.day === ready.today) : [];
  const close = today.find((record) => record.kind === "close") ?? null;
  const final = today.find((record) => record.kind === "final") ?? null;
  return (
    <section className="tx-plan-section tx-ledger">
      <div className="tx-plan-title">
        SEALED PLAN <span className="tx-dim">(a tamper-evident record, {windowLabel(SEAL_WINDOWS.close.from)})</span>
        {ready?.head && (
          <span className="tx-plan-slots" title={`Newest seal #${ready.head.seq}: ${ready.head.hash}`}>
            {ready.total} seal{ready.total === 1 ? "" : "s"} · head <code>{shortHash(ready.head.hash)}</code>
          </span>
        )}
      </div>
      {!ledger ? (
        <div className="tx-plan-empty">{error ? `The ledger couldn't be read: ${error}` : "Reading the ledger…"}</div>
      ) : ledger.status !== "ready" ? (
        <div className="tx-plan-empty">{ledger.error}</div>
      ) : (
        <>
          <TodaySeal ledger={ledger} close={close} final={final} />
          <div className="tx-ledger-actions">
            <button type="button" className="tx-scr-clear" onClick={() => setOpen(!open)}>
              {open ? "Hide the ledger" : `Show the ledger (${ledger.entries.length} seal${ledger.entries.length === 1 ? "" : "s"}, 30 days)`}
            </button>
            <button type="button" className="tx-btn-outline tx-btn-sm" onClick={verify} disabled={verifying || !ledger.total} title="Check every seal's hash and link on the server, from the first to the newest">
              {verifying ? "Verifying…" : "Verify the chain"}
            </button>
            <a className="tx-scr-clear" href="/api/plan/ledger?from=2000-01-01" download="tradex-plan-ledger.json" title="Every seal as JSON: `npm run ledger -- verify --file <it>` checks it anywhere">
              Export
            </a>
          </div>
          {verification && <VerifyResult result={verification} />}
          {open && <LedgerTable ledger={ledger} />}
        </>
      )}
    </section>
  );
}

function TodaySeal({ ledger, close, final }: { ledger: Extract<PlanLedgerResponse, { status: "ready" }>; close: LedgerRecord | null; final: LedgerRecord | null }) {
  const { job } = ledger;
  const { minutes } = istParts();
  const attempt = job.recent.find((item) => item.day === ledger.today && item.kind === "close" && item.outcome !== "sealed");
  if (!close) {
    let text: string;
    if (!job.enabled) text = `Not sealing: ${job.reason}`;
    else if (attempt) text = `Not sealed today: ${attempt.reason}`;
    else if (job.nextCloseAt && istParts(job.nextCloseAt).day === ledger.today) text = `Today's plan is sealed at ${time(job.nextCloseAt)}; from then on the live plan below is compared with it.`;
    else if (minutes >= SEAL_WINDOWS.close.to) text = `No seal today${job.nextCloseAt ? `; the next one is ${dayLabel(istParts(job.nextCloseAt).day)} at ${time(job.nextCloseAt)}` : ""}.`;
    else text = `No seal today (not a trading day${job.calendar ? "" : " — weekends only, the hub's calendar wasn't read"})${job.nextCloseAt ? `; next ${dayLabel(istParts(job.nextCloseAt).day)} ${time(job.nextCloseAt)}` : ""}.`;
    return <div className="tx-plan-empty">{text}</div>;
  }
  return (
    <div className="tx-ledger-today">
      <SealLine record={close} />
      <Drift record={final ?? close} />
      {final && <SealLine record={final} />}
    </div>
  );
}

const KIND_LABEL: Record<SealKind, string> = { close: "Sealed", final: "Final" };

function SealLine({ record }: { record: LedgerRecord }) {
  const ideas = record.plan.ideas;
  return (
    <p className="tx-ledger-line" title={`#${record.seq} · ${record.hash}\nPrevious: ${record.prevHash}\nInputs: ${record.stamp.hash}`}>
      <b>{KIND_LABEL[record.kind]}</b> {time(record.sealedAt)}
      {record.kind === "final" ? " on the day's final bars" : record.plan.live ? " on live prices" : ""} · <code>{shortHash(record.hash)}</code> ·{" "}
      {ideas.length ? (
        <>
          {ideas.length} idea{ideas.length === 1 ? "" : "s"}: {ideas.slice(0, 8).map((idea) => idea.symbol).join(", ")}
          {ideas.length > 8 ? ` +${ideas.length - 8}` : ""}
          {record.plan.reference.take.length > 0 && <span className="tx-dim"> · default book {record.plan.reference.take.map((take) => take.symbol).join(", ")}</span>}
        </>
      ) : (
        "no ideas (not trading was the plan)"
      )}
    </p>
  );
}

/** The live plan against the newest seal of today. */
function Drift({ record }: { record: LedgerRecord }) {
  const universe = useTerminal((state) => state.screener.universe);
  const watch = useMemo(() => (record ? record.plan.ideas.map((idea) => idea.symbol) : EMPTY), [record]);
  const live = useLiveRanking(watch);
  const drift: SealDrift | null = useMemo(() => (live ? compareToSeal(record.plan, live) : null), [record, live]);
  if (universe !== "fno") return <p className="tx-scr-note">The seal is of the F&amp;O list; switch Explore to it to compare the live plan with it.</p>;
  if (!drift) return null;
  if (drift.same) return <p className="tx-ledger-drift is-same">Live plan now: the same as sealed.</p>;
  return (
    <p className="tx-ledger-drift">
      Live plan since the seal:
      {drift.stateChanged && <span> market state now {live?.state ?? "unknown"};</span>}
      {drift.added.length > 0 && (
        <span className="is-added" title={drift.added.map((item) => `${item.symbol} (${screenName(item.screenId)})`).join("\n")}>
          {" "}
          +{drift.added.map((item) => item.symbol).join(", ")}
        </span>
      )}
      {drift.dropped.length > 0 && (
        <span className="is-dropped" title={drift.dropped.map((item) => `${item.symbol}: ${item.why}`).join("\n")}>
          {" "}
          −{drift.dropped.map((item) => `${item.symbol} (${item.why})`).join(", ")}
        </span>
      )}
      {drift.changed.length > 0 && <span> · {drift.changed.map((item) => `${item.symbol} ${item.what}`).join("; ")}</span>}
      . The seal is what counts for the record.
    </p>
  );
}

function VerifyResult({ result }: { result: PlanLedgerVerifyResponse }) {
  if (result.status !== "ready") return <div className="tx-ledger-verify is-bad">{result.error}</div>;
  const { verification, anchors, gaps } = result;
  const ok = verification.ok && anchors.ok;
  return (
    <div className={`tx-ledger-verify ${ok ? "is-ok" : "is-bad"}`}>
      {verification.ok ? (
        <b>
          ✓ All {verification.count} seal{verification.count === 1 ? "" : "s"} verify end to end
          {verification.head ? ` (newest #${verification.head.seq} ${shortHash(verification.head.hash)})` : ""}.
        </b>
      ) : (
        <>
          <b>
            ✗ The chain breaks at #{verification.firstBad}: {verification.problems.length} problem{verification.problems.length === 1 ? "" : "s"}.
          </b>
          <ul>
            {verification.problems.slice(0, 8).map((problem) => (
              <li key={`${problem.index}-${problem.kind}`}>{problem.message}</li>
            ))}
          </ul>
        </>
      )}
      {anchors.checked > 0 && <span> {anchors.ok ? `${anchors.checked} published hash${anchors.checked === 1 ? "" : "es"} match.` : anchors.problems.slice(0, 3).join(" ")}</span>}
      {(gaps.close.length > 0 || gaps.final.length > 0) && (
        <span className="tx-dim">
          {" "}
          Trading days with no seal{gaps.calendar ? "" : " (weekends only; no calendar)"}: {gaps.close.length ? `close ${gaps.close.slice(-6).map(dayLabel).join(", ")}${gaps.close.length > 6 ? ` and ${gaps.close.length - 6} more` : ""}` : ""}
          {gaps.close.length && gaps.final.length ? "; " : ""}
          {gaps.final.length ? `final ${gaps.final.slice(-6).map(dayLabel).join(", ")}${gaps.final.length > 6 ? ` and ${gaps.final.length - 6} more` : ""}` : ""}. A missing day is a gap, never a removed seal (that breaks the chain).
        </span>
      )}
    </div>
  );
}

function LedgerTable({ ledger }: { ledger: Extract<PlanLedgerResponse, { status: "ready" }> }) {
  const [openDay, setOpenDay] = useState<number | null>(null);
  const days = useMemo(() => {
    const byDay = new Map<number, Partial<Record<SealKind, LedgerRecord>>>();
    for (const record of ledger.entries) byDay.set(record.day, { ...byDay.get(record.day), [record.kind]: record });
    return [...byDay].sort((a, b) => b[0] - a[0]);
  }, [ledger.entries]);
  if (!days.length) return <p className="tx-scr-note">No seals in the last 30 days yet.</p>;
  return (
    <table className="tx-ledger-table">
      <thead>
        <tr>
          <th>Day</th>
          <th>Sealed {windowLabel(SEAL_WINDOWS.close.from)}</th>
          <th>Final</th>
        </tr>
      </thead>
      <tbody>
        {days.map(([day, seals]) => (
          <DayRows key={day} day={day} seals={seals} open={openDay === day} onToggle={() => setOpenDay(openDay === day ? null : day)} />
        ))}
      </tbody>
    </table>
  );
}

function DayRows({ day, seals, open, onToggle }: { day: number; seals: Partial<Record<SealKind, LedgerRecord>>; open: boolean; onToggle: () => void }) {
  const shown = seals.final ?? seals.close!;
  const cell = (record: LedgerRecord | undefined) =>
    record ? (
      <span title={`#${record.seq} ${record.hash}`}>
        <code>{shortHash(record.hash)}</code> · {record.plan.ideas.length} idea{record.plan.ideas.length === 1 ? "" : "s"}
      </span>
    ) : (
      <span className="tx-dim">—</span>
    );
  return (
    <>
      <tr className="tx-ledger-row" onClick={onToggle}>
        <td>{dayLabel(day)}</td>
        <td>{cell(seals.close)}</td>
        <td>{cell(seals.final)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={3}>
            {shown.plan.ideas.length ? (
              <ol className="tx-ledger-ideas">
                {shown.plan.ideas.map((idea) => (
                  <li key={idea.symbol}>
                    <b>{idea.symbol}</b> <span className="tx-dim">{screenName(idea.screenId)}</span> · {idea.entry.kind === "buy-stop" ? "buy-stop" : "buy"} {formatPrice(idea.entry.price)} · stop {formatPrice(idea.stop)} · {exitShort(idea.exitRule, idea, idea.holdSessions)} ·{" "}
                    {idea.expectedR >= 0 ? "+" : ""}
                    {idea.expectedR.toFixed(2)}R
                  </li>
                ))}
              </ol>
            ) : (
              <span className="tx-dim">No ideas that day.</span>
            )}
            <div className="tx-dim tx-ledger-stamp">
              {shown.kind === "final" ? "Final" : "Close"} seal #{shown.seq}: {shown.hash} · inputs {shortHash(shown.stamp.hash)} (commit {shown.stamp.code.commit.slice(0, 7)}) · market {shown.plan.state ?? "unknown"}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
