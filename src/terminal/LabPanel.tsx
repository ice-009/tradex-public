"use client";

import "./backtest.css";
import "./lab.css";
import { useEffect, useRef, useState } from "react";
import type { LabRequest, LabResponse } from "@/contracts/api";
import { api } from "@/client/api";
import { COST_PRESETS, type CostPresetId } from "@/core/backtest/costs";
import { ARCHIVE_START, MARKET_PHASES, phaseById } from "@/core/backtest/phases";
import { LAB_SIGNALS, findSignal, type SignalGroup } from "@/core/lab/signals";
import { updateScreener, useTerminal } from "./store";
import { UNIVERSES } from "./BacktestForm";
import { fromInputDate, toInputDate } from "./BacktestFormat";
import { LabResults } from "./LabResults";
import { Icons } from "./icons";

// The Signal Lab (issue #22): pick a signal — a built-in one or any screen —
// a period and horizons, run it on the server (POST /api/lab/run), read the
// report. The CLI (`npm run lab`) prints the same report. The form and the last
// result live at module level so switching dock tabs doesn't lose them.

const FORM_KEY = "tradex.lab.form";

type Period = "stored" | "2010" | "1994" | "custom" | "phase";

interface LabForm {
  signal: string;
  /** Parameters per signal id (so switching signals keeps each one's settings). */
  params: Record<string, Record<string, number>>;
  universe: string;
  period: Period;
  phase: string;
  from: number | null;
  to: number | null;
  horizons: number[];
  quantiles: number;
  costPreset: CostPresetId;
}

const DEFAULT_FORM: LabForm = {
  signal: "momentum-12-1",
  params: {},
  universe: "fno",
  period: "stored",
  phase: MARKET_PHASES[0].id,
  from: null,
  to: null,
  horizons: [1, 5, 10, 21],
  quantiles: 5,
  costPreset: "futures-2026",
};

const PERIODS: Array<{ id: Period; label: string; title: string }> = [
  { id: "stored", label: "5 years", title: "The stored 5 years of daily bars" },
  { id: "2010", label: "Since 2010", title: "From 1 Jan 2010, read from the hub's archive (slower)" },
  { id: "1994", label: "Since 1994", title: "From NSE's first session, read from the hub's archive (slowest)" },
  { id: "phase", label: "Phase", title: "A market phase" },
  { id: "custom", label: "Custom", title: "Any dates back to 1994" },
];

const HORIZONS = [1, 2, 3, 5, 10, 15, 21, 42, 63];

const GROUPS: Array<{ id: SignalGroup; label: string }> = [
  { id: "built-in", label: "Built-in signals" },
  { id: "screen", label: "Screens: matched vs the rest" },
  { id: "screen-score", label: "Screens: score among matches" },
];

const saved: { form: LabForm | null; result: LabResponse | null } = { form: null, result: null };

function loadForm(): LabForm {
  if (saved.form) return saved.form;
  try {
    const raw = window.localStorage.getItem(FORM_KEY);
    if (raw) {
      const form = { ...DEFAULT_FORM, ...(JSON.parse(raw) as Partial<LabForm>) };
      return findSignal(form.signal) ? form : { ...form, signal: DEFAULT_FORM.signal };
    }
  } catch {
    // Storage blocked or corrupt: defaults.
  }
  return DEFAULT_FORM;
}

const DAY_2010 = Date.UTC(2010, 0, 1);

function requestFrom(form: LabForm): LabRequest {
  const phase = form.period === "phase" ? phaseById(form.phase) : null;
  const [from, to] =
    form.period === "2010"
      ? [DAY_2010, null]
      : form.period === "1994"
        ? [ARCHIVE_START, null]
        : phase
          ? [phase.from, phase.to]
          : form.period === "custom"
            ? [form.from, form.to]
            : [null, null];
  return {
    universe: form.universe,
    signal: form.signal,
    params: form.params[form.signal] ?? {},
    from,
    to,
    horizons: form.horizons,
    quantiles: form.quantiles,
    costPreset: form.costPreset,
  };
}

export function LabPanel() {
  const height = useTerminal((state) => state.screener.height);
  const maximized = useTerminal((state) => state.screener.maximized);
  const [form, setForm] = useState<LabForm>(DEFAULT_FORM);
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState<LabResponse | null>(saved.result);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [formOpen, setFormOpen] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from browser storage
    setForm(loadForm());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    saved.form = form;
    try {
      window.localStorage.setItem(FORM_KEY, JSON.stringify(form));
    } catch {
      // Not saved; the form still works.
    }
  }, [form, ready]);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setElapsed(0);
    setError(null);
    api
      .lab(requestFrom(form), controller.signal)
      .then((response) => {
        if (response.status === "error") {
          setError(response.error);
          return;
        }
        saved.result = response;
        setResult(response);
        requestAnimationFrame(() => mainRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "The Lab run failed.");
      })
      .finally(() => {
        if (abortRef.current === controller) setRunning(false);
      });
  };

  const onChange = (patch: Partial<LabForm>) => setForm((current) => ({ ...current, ...patch }));
  const ok = result?.status === "ready" ? result : null;
  const signal = findSignal(form.signal);
  const params = form.params[form.signal] ?? {};
  const long = form.period !== "stored";

  return (
    <section className="tx-scr tx-bt tx-lab" style={{ height: maximized ? undefined : `min(${height}px, 42vh)` }}>
      <header className="tx-scr-head">
        <span className="tx-bt-title">Signal Lab</span>
        <span className="tx-scr-status">
          {running
            ? `Running… ${elapsed}s${elapsed >= 2 && (signal?.usesScan || long) ? " (screens scan every stock's history, long periods read the hub's archive: up to a minute or more)" : ""}`
            : ok
              ? `${ok.report.signal.name} · ${ok.report.period.days} sessions · ${ok.report.universe.symbols} stocks`
              : "Test any signal: quintiles, long–short spread, regimes, decay, turnover"}
        </span>
        <span className="tx-tb-spacer" />
        <button type="button" className={`tx-icon-btn tx-bt-formtoggle ${formOpen ? "is-on" : ""}`} title={formOpen ? "Hide settings" : "Show settings"} onClick={() => setFormOpen(!formOpen)}>
          <Icons.gear size={15} />
        </button>
        {!maximized && (
          <button type="button" className="tx-icon-btn" title="Maximize panel (the report needs room)" onClick={() => updateScreener({ maximized: true })}>
            <Icons.maximize size={15} />
          </button>
        )}
      </header>
      {running && (
        <div className="tx-scr-progress tx-bt-progress">
          <div />
        </div>
      )}
      <div className={`tx-bt-body ${formOpen ? "" : "is-form-hidden"}`}>
        {formOpen && (
          <form
            className="tx-bt-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!running && form.horizons.length) run();
            }}
          >
            <fieldset className="tx-bt-fieldset">
              <legend>Signal</legend>
              <label className="tx-bt-field">
                <span>Signal or screen</span>
                <select className="tx-input" value={form.signal} onChange={(event) => onChange({ signal: event.target.value })} aria-label="Signal">
                  {GROUPS.map((group) => (
                    <optgroup key={group.id} label={group.label}>
                      {LAB_SIGNALS.filter((entry) => entry.group === group.id).map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.group === "screen-score" ? entry.name.replace(/ \(score\)$/, "") : entry.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              {signal && <p className="tx-bt-hint">{signal.summary}</p>}
              {signal && signal.params.length > 0 && (
                <div className="tx-bt-grid2 tx-lab-params">
                  {signal.params.map((spec) => (
                    <label key={spec.key} className="tx-bt-field">
                      <span>{spec.label}</span>
                      <input
                        className="tx-input"
                        type="number"
                        min={spec.min}
                        max={spec.max}
                        step={spec.integer ? 1 : "any"}
                        value={params[spec.key] ?? spec.default}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (!Number.isFinite(value)) return;
                          onChange({ params: { ...form.params, [form.signal]: { ...params, [spec.key]: value } } });
                        }}
                      />
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            <fieldset className="tx-bt-fieldset">
              <legend>Data</legend>
              <label className="tx-bt-field">
                <span>Universe</span>
                <select className="tx-input" value={form.universe} onChange={(event) => onChange({ universe: event.target.value })}>
                  {UNIVERSES.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="tx-bt-field">
                <span>Period</span>
                <div className="tx-bt-seg tx-lab-seg" role="group" aria-label="Period">
                  {PERIODS.map((p) => (
                    <button key={p.id} type="button" title={p.title} className={form.period === p.id ? "is-active" : ""} onClick={() => onChange({ period: p.id })}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              {form.period === "phase" && (
                <label className="tx-bt-field">
                  <span>Market phase</span>
                  <select className="tx-input" value={form.phase} onChange={(event) => onChange({ phase: event.target.value })}>
                    {MARKET_PHASES.map((phase) => (
                      <option key={phase.id} value={phase.id}>
                        {phase.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {form.period === "custom" && (
                <div className="tx-bt-dates">
                  <input
                    className="tx-input"
                    type="date"
                    aria-label="From"
                    min={toInputDate(ARCHIVE_START)}
                    value={form.from === null ? "" : toInputDate(form.from)}
                    onChange={(event) => onChange({ from: Number.isFinite(fromInputDate(event.target.value)) ? fromInputDate(event.target.value) : null })}
                  />
                  <span className="tx-dim">–</span>
                  <input
                    className="tx-input"
                    type="date"
                    aria-label="To"
                    value={form.to === null ? "" : toInputDate(form.to)}
                    onChange={(event) => onChange({ to: Number.isFinite(fromInputDate(event.target.value)) ? fromInputDate(event.target.value) : null })}
                  />
                </div>
              )}
              <p className="tx-bt-hint">
                Daily bars from the hub&apos;s archive: one series per company across ticker renames, and each day&apos;s own F&amp;O list, merged and delisted members
                included.{" "}
                {long
                  ? "Longer periods take longer (a screen over 15 years: a minute or more). Before 2012 NIFTY's regime comes from its equal-weight stand-in; price adjustments are least certain in the oldest years."
                  : "Warm-up comes from the year before, so the first day is ranked too."}
              </p>
            </fieldset>

            <fieldset className="tx-bt-fieldset">
              <legend>Measure</legend>
              <div className="tx-bt-field">
                <span>Horizons (sessions)</span>
                <div className="tx-lab-horizons">
                  {HORIZONS.map((h) => (
                    <label key={h} className="tx-bt-check">
                      <input
                        type="checkbox"
                        checked={form.horizons.includes(h)}
                        onChange={() => onChange({ horizons: form.horizons.includes(h) ? form.horizons.filter((x) => x !== h) : [...form.horizons, h].sort((a, b) => a - b) })}
                      />
                      <span>{h}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="tx-bt-field">
                <span>Buckets</span>
                <div className="tx-bt-seg" role="group" aria-label="Buckets">
                  {[3, 5, 10].map((q) => (
                    <button key={q} type="button" className={form.quantiles === q ? "is-active" : ""} onClick={() => onChange({ quantiles: q })}>
                      {q === 3 ? "Terciles" : q === 5 ? "Quintiles" : "Deciles"}
                    </button>
                  ))}
                </div>
              </div>
              <label className="tx-bt-field">
                <span>Costs</span>
                <select className="tx-input" value={form.costPreset} onChange={(event) => onChange({ costPreset: event.target.value as CostPresetId })}>
                  {(Object.keys(COST_PRESETS) as CostPresetId[]).map((id) => (
                    <option key={id} value={id}>
                      {COST_PRESETS[id].label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="tx-bt-hint">{COST_PRESETS[form.costPreset].note} Each position pays a full round trip per horizon; the spread pays two (long and short).</p>
            </fieldset>

            <div className="tx-bt-run">
              <button type="submit" className="tx-btn" disabled={running || !form.horizons.length}>
                {running ? "Running…" : "Run signal test"}
              </button>
            </div>
          </form>
        )}
        <div className="tx-bt-main" ref={mainRef}>
          {error && <div className="tx-scr-state is-error">{error}</div>}
          {ok ? (
            <LabResults data={ok} />
          ) : (
            !error && (
              <div className="tx-bt-empty">
                <p>
                  <b>Pick a signal and press Run.</b> Each session, the stocks in that day&apos;s F&amp;O list are ranked into buckets by the signal (Q1 lowest, Q5 highest), and
                  each bucket&apos;s forward return over the horizons is measured net of futures costs.
                </p>
                <p>
                  The long–short spread (Q5 − Q1) gets a Newey–West t-stat corrected for overlapping returns, split by market regime and into the first 60% / last 40% of the
                  period; decay shows how fast the edge fades and turnover what it costs to hold. Every run is a trial: the deflated Sharpe ratio counts them all.
                </p>
              </div>
            )
          )}
        </div>
      </div>
    </section>
  );
}
