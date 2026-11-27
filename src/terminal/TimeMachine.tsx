"use client";

import { useEffect, useState } from "react";
import { api } from "@/client/api";
import { resolvedTimeMachine, setAsOf, useTimeMachine } from "@/client/timeMachine";
import { ARCHIVE_START } from "@/core/backtest/phases";
import { DAY_MS, istParts } from "@/core/market/session";
import { dayLabel, isoDay } from "@/core/reference/timeMachine";
import { adaptToEndOfDay } from "./store";

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
