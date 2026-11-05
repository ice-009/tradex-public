"use client";

import type { BacktestInfoResponse, BacktestRequest } from "@/contracts/api";
import { COST_PRESETS, type CostPresetId } from "@/core/backtest/costs";
import { HOLD_BARS } from "@/core/screener/backtest";
import { SCREENS, SCREEN_GROUPS } from "@/core/screener/screens";
import { formatDate, fromInputDate, toInputDate } from "./BacktestFormat";

export const UNIVERSES = [
  { id: "nifty50", label: "Nifty 50" },
  { id: "nifty200", label: "Nifty 200" },
  { id: "fno", label: "F&O stocks" },
  { id: "nifty500", label: "Nifty 500" },
];

export type PeriodPreset = "all" | "9m" | "6m" | "3m" | "custom";

export interface BacktestForm {
  screenIds: string[];
  universe: string;
  period: PeriodPreset;
  /** Custom period (day keys). */
  from: number | null;
  to: number | null;
  /** "" = each strategy's default holding period. */
  hold: string;
  capital: number;
  riskPct: number;
  maxPositions: number;
  maxLeverage: number;
  entry: BacktestRequest["entry"];
  costPreset: CostPresetId;
  /** "" = the preset's slippage. */
  slippagePct: string;
  sizing: BacktestRequest["sizing"];
  oosFraction: number;
}

export const DEFAULT_FORM: BacktestForm = {
  screenIds: ["swing-ema-pullback", "pos-52w-high"],
  universe: "fno",
  period: "all",
  from: null,
  to: null,
  hold: "",
  capital: 10_00_000,
  riskPct: 1,
  maxPositions: 5,
  maxLeverage: 4,
  entry: "next-open",
  costPreset: "futures-2026",
  slippagePct: "",
  sizing: "lots",
  oosFraction: 0.3,
};

const PERIODS: Array<{ id: PeriodPreset; label: string; days?: number }> = [
  { id: "all", label: "All stored" },
  { id: "9m", label: "9M", days: 274 },
  { id: "6m", label: "6M", days: 183 },
  { id: "3m", label: "3M", days: 92 },
  { id: "custom", label: "Custom" },
];

/** The period a form asks for, resolved against the stored sessions. */
export function resolvePeriod(form: BacktestForm, info: BacktestInfoResponse | null): { from: number | null; to: number | null; sessions: number | null } {
  const dates = info?.history?.dates ?? [];
  if (!dates.length) return { from: null, to: null, sessions: null };
  if (form.period === "all") return { from: null, to: null, sessions: dates.length };
  if (form.period === "custom") {
    const from = form.from ?? dates[0];
    const to = form.to ?? dates.at(-1)!;
    return { from, to, sessions: dates.filter((d) => d >= from && d <= to).length };
  }
  const days = PERIODS.find((p) => p.id === form.period)?.days ?? 0;
  const to = dates.at(-1)!;
  const from = dates.find((d) => d >= to - days * 86_400_000) ?? dates[0];
  return { from, to, sessions: dates.filter((d) => d >= from).length };
}

export function requestFrom(form: BacktestForm, info: BacktestInfoResponse | null): BacktestRequest {
  const period = resolvePeriod(form, info);
  const slip = Number(form.slippagePct);
  return {
    universe: form.universe,
    screenIds: form.screenIds,
    from: period.from,
    to: period.to,
    holdBars: form.hold && Number(form.hold) > 0 ? Number(form.hold) : null,
    capital: form.capital,
    riskPct: form.riskPct,
    maxPositions: form.maxPositions,
    maxLeverage: form.maxLeverage,
    entry: form.entry,
    costPreset: form.costPreset,
    slippage: form.slippagePct !== "" && Number.isFinite(slip) ? { mode: "pct", value: slip } : undefined,
    sizing: form.sizing,
    oosFraction: form.oosFraction,
  };
}

const pct = (fraction: number, digits = 4) => `${(fraction * 100).toFixed(digits).replace(/\.?0+$/, "")}%`;

export function BacktestFormView({
  form,
  onChange,
  info,
  running,
  onRun,
}: {
  form: BacktestForm;
  onChange: (patch: Partial<BacktestForm>) => void;
  info: BacktestInfoResponse | null;
  running: boolean;
  onRun: () => void;
}) {
  const selected = new Set(form.screenIds);
  const toggle = (id: string) => onChange({ screenIds: selected.has(id) ? form.screenIds.filter((s) => s !== id) : [...form.screenIds, id] });
  const period = resolvePeriod(form, info);
  const dates = info?.history?.dates ?? [];
  const preset = COST_PRESETS[form.costPreset];
  const model = preset.model;

  return (
    <form
      className="tx-bt-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!running && form.screenIds.length) onRun();
      }}
    >
      <fieldset className="tx-bt-fieldset">
        <legend>Strategies</legend>
        {SCREEN_GROUPS.map((group) => {
          const screens = SCREENS.filter((screen) => screen.group === group.id);
          const all = screens.every((screen) => selected.has(screen.id));
          return (
            <div key={group.id} className={`tx-bt-group tx-hz-${group.id}`}>
              <div className="tx-bt-group-head">
                <span className="tx-hz-dot" />
                <span className="tx-bt-group-name">{group.label}</span>
                <span className="tx-dim">{screens.every((screen) => screen.exit === "next-open") ? "sell at next open" : `hold ${HOLD_BARS[group.id]}d`}</span>
                <button
                  type="button"
                  className="tx-bt-link"
                  onClick={() =>
                    onChange({
                      screenIds: all ? form.screenIds.filter((id) => !screens.some((s) => s.id === id)) : [...new Set([...form.screenIds, ...screens.map((s) => s.id)])],
                    })
                  }
                >
                  {all ? "None" : "All"}
                </button>
              </div>
              {screens.map((screen) => (
                <label key={screen.id} className="tx-bt-check" title={screen.summary}>
                  <input type="checkbox" checked={selected.has(screen.id)} onChange={() => toggle(screen.id)} />
                  <span>{screen.name}</span>
                </label>
              ))}
            </div>
          );
        })}
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
          <div className="tx-bt-seg" role="group" aria-label="Period">
            {PERIODS.map((p) => (
              <button key={p.id} type="button" className={form.period === p.id ? "is-active" : ""} onClick={() => onChange({ period: p.id })}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {form.period === "custom" && dates.length > 0 && (
          <div className="tx-bt-dates">
            <input
              type="date"
              className="tx-input"
              aria-label="From"
              min={toInputDate(dates[0])}
              max={toInputDate(dates.at(-1)!)}
              value={toInputDate(form.from ?? dates[0])}
              onChange={(event) => {
                const t = fromInputDate(event.target.value);
                if (Number.isFinite(t)) onChange({ from: t });
              }}
            />
            <span className="tx-dim">to</span>
            <input
              type="date"
              className="tx-input"
              aria-label="To"
              min={toInputDate(dates[0])}
              max={toInputDate(dates.at(-1)!)}
              value={toInputDate(form.to ?? dates.at(-1)!)}
              onChange={(event) => {
                const t = fromInputDate(event.target.value);
                if (Number.isFinite(t)) onChange({ to: t });
              }}
            />
          </div>
        )}
        <p className="tx-bt-hint">
          {info?.history ? (
            <>
              Stored: <b>{info.history.sessions}</b> sessions ({formatDate(info.history.from)} – {formatDate(info.history.to)}), {info.covered}/{info.symbols} stocks.
              {period.sessions !== null && form.period !== "all" && (
                <>
                  {" "}
                  Selected: <b>{period.sessions}</b> sessions.
                </>
              )}{" "}
              Signals need ≥60 sessions of warm-up (200+ for screens using the 200-day average or 52-week high), so the first months only warm up.
            </>
          ) : info ? (
            "No stored history for this universe yet."
          ) : (
            "Reading stored history…"
          )}
        </p>
      </fieldset>

      <fieldset className="tx-bt-fieldset">
        <legend>Account</legend>
        <div className="tx-bt-grid2">
          <label className="tx-bt-field">
            <span>Capital ₹</span>
            <input className="tx-input" type="number" min={10000} step={10000} value={form.capital} onChange={(event) => onChange({ capital: Number(event.target.value) })} />
          </label>
          <label className="tx-bt-field">
            <span>Risk % / trade</span>
            <input className="tx-input" type="number" min={0.05} max={10} step={0.05} value={form.riskPct} onChange={(event) => onChange({ riskPct: Number(event.target.value) })} />
          </label>
          <label className="tx-bt-field">
            <span>Max positions</span>
            <input className="tx-input" type="number" min={1} max={50} step={1} value={form.maxPositions} onChange={(event) => onChange({ maxPositions: Number(event.target.value) })} />
          </label>
          <label className="tx-bt-field" title="Total open position value may not exceed equity × this. Stock-futures margin is roughly 20–25% of the contract value, so 4× is about fully margined.">
            <span>Max leverage ×</span>
            <input className="tx-input" type="number" min={0.5} max={10} step={0.5} value={form.maxLeverage} onChange={(event) => onChange({ maxLeverage: Number(event.target.value) })} />
          </label>
          <label className="tx-bt-field" title="Sessions to hold before exiting at the close. Blank = each strategy's default (BTST 1, swing 10, 15–30 days 25, results 10).">
            <span>Hold (sessions)</span>
            <input className="tx-input" type="number" min={1} max={60} step={1} placeholder="Default" value={form.hold} onChange={(event) => onChange({ hold: event.target.value })} />
          </label>
          <label className="tx-bt-field">
            <span>Size in</span>
            <select className="tx-input" value={form.sizing} onChange={(event) => onChange({ sizing: event.target.value as BacktestForm["sizing"] })}>
              <option value="lots">Futures lots</option>
              <option value="shares">Shares</option>
            </select>
          </label>
          <label className="tx-bt-field">
            <span>Entry</span>
            <select className="tx-input" value={form.entry} onChange={(event) => onChange({ entry: event.target.value as BacktestForm["entry"] })}>
              <option value="next-open">Next open</option>
              <option value="signal-close">Signal close</option>
            </select>
          </label>
          <label className="tx-bt-field" title="The last part of the period is held out to check whether results hold up.">
            <span>Out-of-sample</span>
            <select className="tx-input" value={form.oosFraction} onChange={(event) => onChange({ oosFraction: Number(event.target.value) })}>
              <option value={0.2}>Last 20%</option>
              <option value={0.3}>Last 30%</option>
              <option value={0.4}>Last 40%</option>
            </select>
          </label>
        </div>
      </fieldset>

      <fieldset className="tx-bt-fieldset">
        <legend>Costs</legend>
        <label className="tx-bt-field">
          <span>Cost model</span>
          <select className="tx-input" value={form.costPreset} onChange={(event) => onChange({ costPreset: event.target.value as CostPresetId })}>
            {Object.entries(COST_PRESETS).map(([id, p]) => (
              <option key={id} value={id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="tx-bt-field">
          <span>Slippage % / leg</span>
          <input
            className="tx-input"
            type="number"
            min={0}
            max={2}
            step={0.01}
            placeholder={String(model.slippage.value)}
            value={form.slippagePct}
            onChange={(event) => onChange({ slippagePct: event.target.value })}
          />
        </label>
        <details className="tx-bt-details">
          <summary>Show cost breakdown</summary>
          <p className="tx-bt-hint">{preset.note}</p>
          <table className="tx-bt-mini">
            <tbody>
              <tr>
                <th>Brokerage</th>
                <td>
                  ₹{model.brokeragePerOrder}/order{model.brokeragePct ? ` or ${pct(model.brokeragePct)} if lower` : ""}
                </td>
              </tr>
              <tr>
                <th>STT (sell)</th>
                <td>{pct(model.sttSell)}</td>
              </tr>
              <tr>
                <th>NSE txn + IPFT</th>
                <td>{pct(model.exchange, 5)} each leg</td>
              </tr>
              <tr>
                <th>SEBI fee</th>
                <td>{pct(model.sebi, 5)} each leg</td>
              </tr>
              <tr>
                <th>Stamp duty (buy)</th>
                <td>{pct(model.stampBuy)}</td>
              </tr>
              <tr>
                <th>GST</th>
                <td>{pct(model.gst, 0)} on brokerage + txn + SEBI</td>
              </tr>
              <tr>
                <th>Slippage</th>
                <td>{form.slippagePct !== "" ? form.slippagePct : model.slippage.value}% each leg, against you</td>
              </tr>
            </tbody>
          </table>
        </details>
      </fieldset>

      <div className="tx-bt-run">
        <button type="submit" className="tx-btn tx-btn-primary" disabled={running || !form.screenIds.length}>
          {running ? <span className="tx-spinner tx-spinner-sm" /> : null}
          {running ? "Running…" : `Run backtest (${form.screenIds.length})`}
        </button>
      </div>
    </form>
  );
}
