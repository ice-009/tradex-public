"use client";

import "./backtest.css";
import { useEffect, useRef, useState } from "react";
import type { BacktestInfoResponse, BacktestResponse } from "@/contracts/api";
import { api } from "@/client/api";
import { updateScreener, useTerminal } from "./store";
import { BacktestFormView, DEFAULT_FORM, requestFrom, type BacktestForm } from "./BacktestForm";
import { BacktestResults } from "./BacktestResults";
import { Icons } from "./icons";

// Strategy backtester: pick screens and account settings, run on the server
// (POST /api/backtest), read the results. The form and the last result live at
// module level so switching dock tabs doesn't lose them.

const FORM_KEY = "tradex.backtest.form";

const saved: { form: BacktestForm | null; result: BacktestResponse | null } = { form: null, result: null };

function loadForm(): BacktestForm {
  if (saved.form) return saved.form;
  try {
    const raw = window.localStorage.getItem(FORM_KEY);
    if (raw) return { ...DEFAULT_FORM, ...(JSON.parse(raw) as Partial<BacktestForm>) };
  } catch {
    // Storage blocked or corrupt: defaults.
  }
  return DEFAULT_FORM;
}

export function BacktestPanel() {
  const height = useTerminal((state) => state.screener.height);
  const maximized = useTerminal((state) => state.screener.maximized);
  const [form, setForm] = useState<BacktestForm>(DEFAULT_FORM);
  const [ready, setReady] = useState(false);
  const [info, setInfo] = useState<BacktestInfoResponse | null>(null);
  const [result, setResult] = useState<BacktestResponse | null>(saved.result);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [formOpen, setFormOpen] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  // Restore the last form after mount (localStorage isn't available during server rendering).
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
    if (!ready) return;
    const controller = new AbortController();
    api
      .backtestInfo(form.universe, controller.signal)
      .then(setInfo)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Couldn't read the stored history.");
      });
    return () => controller.abort();
  }, [form.universe, ready]);

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
      .backtest(requestFrom(form, info), controller.signal)
      .then((response) => {
        if (response.status === "error") {
          setError(response.error);
          return;
        }
        saved.result = response;
        setResult(response);
        // When the settings sit above the results (narrow panel), bring the results into view.
        requestAnimationFrame(() => mainRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "The backtest failed.");
      })
      .finally(() => {
        if (abortRef.current === controller) setRunning(false);
      });
  };

  const onChange = (patch: Partial<BacktestForm>) => setForm((current) => ({ ...current, ...patch }));
  const ok = result?.status === "ready" ? result : null;

  return (
    <section className="tx-scr tx-bt" style={{ height: maximized ? undefined : `min(${height}px, 42vh)` }}>
      <header className="tx-scr-head">
        <span className="tx-bt-title">Backtest</span>
        <span className="tx-scr-status">
          {running
            ? `Running… ${elapsed}s${elapsed >= 2 && !ok ? " (the first run scans every stock's history: up to ~15 s)" : ""}`
            : ok
              ? `${ok.result.trade.trades} trades · ${ok.result.period.sessions} sessions · ${ok.symbols} stocks`
              : "Replay the screens as one account, with costs"}
        </span>
        <span className="tx-tb-spacer" />
        <button type="button" className={`tx-icon-btn tx-bt-formtoggle ${formOpen ? "is-on" : ""}`} title={formOpen ? "Hide settings" : "Show settings"} onClick={() => setFormOpen(!formOpen)}>
          <Icons.gear size={15} />
        </button>
        {!maximized && (
          <button type="button" className="tx-icon-btn" title="Maximize panel (results need room)" onClick={() => updateScreener({ maximized: true })}>
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
        {formOpen && <BacktestFormView form={form} onChange={onChange} info={info} running={running} onRun={run} />}
        <div className="tx-bt-main" ref={mainRef}>
          {error && <div className="tx-scr-state is-error">{error}</div>}
          {ok ? (
            <BacktestResults data={ok} />
          ) : (
            !error && (
              <div className="tx-bt-empty">
                <p>
                  <b>Pick strategies and press Run.</b> Each screen is replayed over the stored daily history; its signals are traded as one account with your risk per trade, a limit
                  on open positions (best score first), one position per stock, and NSE futures costs.
                </p>
                <p>
                  Results are only as good as the history behind them: about a year is stored now, and most screens need months of it to warm up. More history (via the data
                  engine, about 5 broker calls per stock on Fyers Standard) would make results more reliable.
                </p>
              </div>
            )
          )}
        </div>
      </div>
    </section>
  );
}
