"use client";

import { useEffect, useRef, useState } from "react";
import "./replay.css";
import { api } from "@/client/api";
import { resolvedTimeMachine, setAsOf, useTimeMachine } from "@/client/timeMachine";
import { ARCHIVE_START } from "@/core/backtest/phases";
import { DAY_MS, istParts } from "@/core/market/session";
import { dayLabel, isoDay } from "@/core/reference/timeMachine";
import { adaptToEndOfDay, updateScreener } from "./store";
import { jumpTo, pause, setSpeed, stepBar, stepDay, togglePlay, useReplay } from "@/client/replay";
import { usePaperFeed, usePaperPolling } from "@/client/paperFeed";
import { REPLAY_SPEEDS } from "@/core/reference/replay";
import { signedR } from "@/core/plan/evidence";

/** The hub keeps a year of intraday candles: a day older than that has daily charts only. */
const INTRADAY_DAYS = 365;

// The Time Machine (issue #31) in the terminal: the top bar's date picker,
// the banner that says which day is shown, and the stand-in for panels that
// only make sense live. The data itself is cut off on the server; this only
// asks for a day and says what is shown.

/** The last day the picker offers: yesterday (today is the live terminal). */
const latestPastDay = () => isoDay(istParts().day - DAY_MS);

/** Top bar: pick a day to open the terminal as it was at its close, or go back to live. */
export function TimeMachinePicker() {
  const asOf = useTimeMachine((state) => state.asOf);
  // Keyed by the day, so the field starts from it again when it changes elsewhere (back/forward, the banner).
  return <Picker key={asOf ?? "live"} asOf={asOf} />;
}

function Picker({ asOf }: { asOf: string | null }) {
  const [draft, setDraft] = useState(asOf ?? "");
  return (
    <form
      className={`tx-tm-picker ${asOf ? "is-on" : ""}`}
      title="Time Machine: open the terminal as it was at a past day's close (charts, quotes, screens and the plan, with nothing from after it)"
      onSubmit={(event) => {
        event.preventDefault();
        setAsOf(draft || null);
      }}
    >
      <label className="tx-tm-label" htmlFor="tx-tm-date">
        As of
      </label>
      <input
        id="tx-tm-date"
        type="date"
        className="tx-input tx-tm-date"
        aria-label="Time Machine date"
        min={isoDay(ARCHIVE_START)}
        max={latestPastDay()}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      {draft && draft !== asOf && (
        <button type="submit" className="tx-tb-btn" title="Open the terminal as of this day">
          Go
        </button>
      )}
      {asOf && (
        <button type="button" className="tx-tb-btn tx-tm-live" onClick={() => setAsOf(null)} title="Back to the live terminal">
          Live
        </button>
      )}
    </form>
  );
}

/** "Time Machine: 23 Mar 2020 — data after this day is hidden", with what was and wasn't known that day. */
export function TimeMachineBanner() {
  const asOf = useTimeMachine((state) => state.asOf);
  const info = useTimeMachine((state) => state.info);
  const error = useTimeMachine((state) => state.error);
  const [details, setDetails] = useState(false);

  // Before the hub's year of intraday candles, charts on an intraday interval switch to daily.
  useEffect(() => {
    if (asOf && Date.now() - Date.parse(`${asOf}T00:00:00Z`) > INTRADAY_DAYS * DAY_MS) adaptToEndOfDay();
  }, [asOf]);

  useEffect(() => {
    if (!asOf) return;
    let cancelled = false;
    api
      .timeMachine(asOf)
      .then((answer) => !cancelled && resolvedTimeMachine(asOf, answer))
      .catch((failure: Error) => !cancelled && resolvedTimeMachine(asOf, { status: "error", error: failure.message }));
    return () => {
      cancelled = true;
    };
  }, [asOf]);

  if (!asOf) return null;
  const label = info?.label ?? dayLabel(Date.parse(`${asOf}T00:00:00Z`));
  return (
    <div className="tx-hub-banner tx-tm-banner" role="status" data-testid="time-machine-banner">
      <strong>Time Machine: {label}</strong>
      <span>
        {error ? error : "— data after this day is hidden. Charts end at its close, quotes are its closes, and the screens and plan use what was known then."}
        {info?.note ? ` ${info.note}` : ""}
      </span>
      {info && (
        <button type="button" className="tx-btn-outline" onClick={() => setDetails((open) => !open)} aria-expanded={details}>
          {details ? "Hide" : "What was known"}
        </button>
      )}
      <button type="button" className="tx-btn-outline" onClick={() => setAsOf(null)}>
        Back to live
      </button>
      {details && info && (
        <ul className="tx-tm-facts">
          {info.facts.map((fact) => (
            <li key={fact.name} className={fact.known ? "" : "is-unknown"}>
              <b>{fact.name}:</b> {fact.known ? fact.text : `not known — ${fact.text}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ replay controls (#32)

const SPEED_LABEL: Record<number, string> = { 0.5: "½ session/s", 1: "1 session/s", 2: "2 sessions/s", 4: "4 sessions/s" };
const isTyping = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)));
};

/**
 * Under the banner in the Time Machine: step a session back or forward, play
 * forward at a chosen speed, reveal the next bar of an intraday chart, jump to
 * a date, and the paper session's running score. Keyboard: Alt+] / Alt+[ next
 * / previous session, Alt+Shift+] / Alt+Shift+[ next / previous bar, Alt+P play
 * or pause, Alt+J jump to a date.
 */
export function ReplayBar() {
  const asOf = useTimeMachine((state) => state.asOf);
  const info = useTimeMachine((state) => state.info);
  const playing = useReplay((state) => state.playing);
  const speed = useReplay((state) => state.speed);
  const cursor = useReplay((state) => state.cursor);
  const stopped = useReplay((state) => state.stopped);
  const summary = usePaperFeed((feed) => feed.data?.summary ?? null);
  const jumpRef = useRef<HTMLInputElement>(null);
  const [jump, setJump] = useState("");
  usePaperPolling();

  useEffect(() => {
    if (!asOf) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey || isTyping(event.target) || document.querySelector(".tx-modal")) return;
      const step = event.code === "BracketRight" ? 1 : event.code === "BracketLeft" ? -1 : 0;
      if (step) {
        event.preventDefault();
        if (event.shiftKey) stepBar(step);
        else stepDay(step);
      } else if (event.code === "KeyP") {
        event.preventDefault();
        togglePlay();
      } else if (event.code === "KeyJ") {
        event.preventDefault();
        jumpRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asOf]);
  // Leaving the Time Machine stops a replay.
  useEffect(() => () => pause(), []);

  if (!asOf) return null;
  const hasPrev = Boolean(info?.sessions.before.length);
  const hasNext = Boolean(info?.sessions.after.length);
  const label = info?.label ?? dayLabel(Date.parse(`${asOf}T00:00:00Z`));
  return (
    <div className="tx-tm-replay" role="toolbar" aria-label="Replay" data-testid="replay-bar">
      <span className="tx-tm-replay-day" data-testid="replay-day">
        {label}
        {cursor !== null && <em> · next session to {new Date(cursor - 1 + 5.5 * 3_600_000).toISOString().slice(11, 16)}</em>}
      </span>
      <button type="button" className="tx-tb-btn" onClick={() => stepDay(-1)} disabled={!hasPrev || playing} title="Previous session (Alt+[)" aria-label="Previous session">
        ◀ Session
      </button>
      <button type="button" className={`tx-tb-btn ${playing ? "is-on" : ""}`} onClick={togglePlay} disabled={!hasNext && !playing} title="Play the days forward (Alt+P)" aria-label={playing ? "Pause" : "Play"}>
        {playing ? "❚❚ Pause" : "▶ Play"}
      </button>
      <button type="button" className="tx-tb-btn" onClick={() => stepDay(1)} disabled={!hasNext || playing} title="Next session (Alt+])" aria-label="Next session">
        Session ▶
      </button>
      <button type="button" className="tx-tb-btn" onClick={() => stepBar(1)} disabled={!hasNext || playing} title="Next bar: on an intraday chart, reveal the next session one bar at a time; on a daily chart, the next session (Alt+Shift+])" aria-label="Next bar">
        Bar ▶
      </button>
      <select className="tx-input tx-tm-speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} aria-label="Replay speed" title="Play speed">
        {REPLAY_SPEEDS.map((value) => (
          <option key={value} value={value}>
            {SPEED_LABEL[value] ?? `${value}/s`}
          </option>
        ))}
      </select>
      <form
        className="tx-tm-jump"
        onSubmit={(event) => {
          event.preventDefault();
          if (jump) jumpTo(jump);
        }}
      >
        <input ref={jumpRef} type="date" className="tx-input tx-tm-date" aria-label="Jump to date" title="Jump to a date (Alt+J)" min={isoDay(ARCHIVE_START)} max={latestPastDay()} value={jump} onChange={(event) => setJump(event.target.value)} />
        <button type="submit" className="tx-tb-btn" disabled={!jump}>
          Jump
        </button>
      </form>
      {stopped && <span className="tx-tm-replay-note">{stopped}</span>}
      <button
        type="button"
        className="tx-tm-paper-chip"
        onClick={() => updateScreener({ open: true, view: "paper" })}
        title="Your paper trades in this replay, graded as of the day shown"
        data-testid="paper-chip"
      >
        Paper{" "}
        {summary && summary.taken > 0 ? (
          <>
            {summary.open + summary.pending > 0 && <span>{summary.open + summary.pending} open · </span>}
            <b className={summary.netR >= 0 ? "is-up" : "is-down"}>{signedR(summary.netR)}</b> · {summary.closed} closed
          </>
        ) : (
          <span className="tx-dim">no trades yet</span>
        )}
      </button>
    </div>
  );
}

/** A panel that shows only live or today's data, in the Time Machine. */
export function LiveOnly({ what }: { what: string }) {
  const label = useTimeMachine((state) => state.info?.label ?? state.asOf);
  return (
    <section className="tx-scr tx-tm-off">
      <p>
        {what} isn&apos;t available in the Time Machine{label ? ` (${label})` : ""}: it would show data from after that day.
      </p>
      <button type="button" className="tx-btn-outline" onClick={() => setAsOf(null)}>
        Back to live
      </button>
    </section>
  );
}

/** A short line for things switched off in the Time Machine (order ticket, journal…). */
export function LiveOnlyNote({ children }: { children: React.ReactNode }) {
  return <div className="tx-tm-note">{children}</div>;
}
