"use client";

import { useMemo, useState } from "react";
import "./exposure.css";
import { formatPrice } from "@/core/format";
import type { Plan, PlanIdea } from "@/core/plan/builder";
import { lakhs } from "@/core/plan/explain";
import { dayLabel } from "@/core/reference/timeMachine";
import { portfolioExposure, riskPosition, type Exposure, type RiskPosition } from "@/core/risk/exposure";
import { SCREEN_MAP } from "@/core/screener/screens";
import { useTimeMachine } from "@/client/timeMachine";
import { openIdea } from "./ideaActions";
import { usePrefs } from "./uiPrefs";
import type { PlanRisk } from "./usePlan";

// The exposure view (issue #40): your open trades and the plan's ideas
// together — notional, ₹ at risk at the stops, by sector, beta to NIFTY,
// clusters of stocks that move together and a small correlation map — and a
// what-if: tick an idea in or out and see the totals move. The numbers are
// src/core/risk's (exposure.ts); this file only shows them.

const rupees = (value: number) => `₹${formatPrice(value, 0)}`;
const pct = (value: number, digits = 0) => `${(value * 100).toFixed(digits)}%`;
const MAX_HEATMAP = 12;

interface Row {
  position: RiskPosition;
  idea: PlanIdea | null;
  /** Set aside by correlation-aware sizing (shown at the size it would have had alone). */
  skipped: boolean;
  lots: number | null;
}

function ideaPosition(idea: PlanIdea, industry: string): RiskPosition {
  return riskPosition({ symbol: idea.symbol, kind: "idea", industry, qty: idea.size.qty, price: idea.entry.price, stop: idea.stop });
}

/** ρ → a diverging fill: warm for moving together, cool for opposite, neutral at 0. */
function cellColor(rho: number): string {
  const strength = Math.round(Math.min(1, Math.abs(rho)) * 85);
  return `color-mix(in srgb, var(${rho >= 0 ? "--neg" : "--info"}) ${strength}%, var(--surface-2))`;
}

export function ExposureSection({ plan, risk }: { plan: Plan | null; risk: PlanRisk }) {
  const capital = usePrefs((prefs) => prefs.capital);
  const riskPct = usePrefs((prefs) => prefs.riskPct);
  const threshold = usePrefs((prefs) => prefs.corrThreshold);
  const maxCorrRisk = usePrefs((prefs) => prefs.maxCorrRisk);
  const corrSizing = usePrefs((prefs) => prefs.corrSizing);
  const pastDay = useTimeMachine((state) => state.asOf !== null);
  const [open, setOpen] = useState(true);
  // What-if: ideas left out of the "with plan" totals (sized ideas start in, skipped ones out).
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const perTrade = (capital * riskPct) / 100;

  const rows = useMemo((): Row[] => {
    const industryOf = (idea: PlanIdea) => idea.row.industry || risk.industries[idea.symbol] || "";
    return [
      ...risk.open.map((position) => ({ position, idea: null, skipped: false, lots: null })),
      ...(plan?.ideas ?? []).map((idea) => ({ position: ideaPosition(idea, industryOf(idea)), idea, skipped: false, lots: idea.size.lots })),
      ...(plan?.correlated ?? []).map((idea) => ({ position: ideaPosition(idea, industryOf(idea)), idea, skipped: true, lots: idea.size.lots })),
    ];
  }, [plan, risk]);
  const included = (row: Row) => row.position.kind === "open" || (toggled[row.position.symbol] ?? !row.skipped);
  const before = useMemo(() => portfolioExposure(risk.open, risk.model, { capital, threshold }), [risk, capital, threshold]);
  const after = useMemo(
    () => portfolioExposure(rows.filter((row) => row.position.kind === "open" || (toggled[row.position.symbol] ?? !row.skipped)).map((row) => row.position), risk.model, { capital, threshold }),
    [rows, toggled, risk.model, capital, threshold],
  );
  const all = useMemo(() => portfolioExposure(rows.map((row) => row.position), risk.model, { capital, threshold }), [rows, risk.model, capital, threshold]);

  const returns = risk.returns;
  const model = risk.model;
  const status =
    !rows.length ? null : !returns ? "Loading daily returns…" : returns.status === "syncing" ? `Reading daily bars up to that day (${returns.progress.done}/${returns.progress.total})…` : returns.status === "error" ? `No daily returns: ${returns.error}. Correlations fall back to industries.` : !model ? "Too little history for correlations: they fall back to industries." : null;
  const budget = maxCorrRisk * perTrade;

  return (
    <section className="tx-plan-section tx-exposure">
      <div className="tx-plan-title">
        EXPOSURE <span className="tx-dim">open + planned</span>
        <button type="button" className="tx-scr-clear tx-exposure-toggle" onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {!open ? null : !rows.length ? (
        <div className="tx-plan-empty">{pastDay ? "No ideas in the plan for that day." : "No open trades and no ideas in the plan: nothing at risk."}</div>
      ) : (
        <>
          <Totals before={before} after={after} perTrade={perTrade} hasOpen={risk.open.length > 0} />
          <table className="tx-scr-track tx-exposure-table">
            <thead>
              <tr>
                <th title="Tick an idea to count it in the totals (what-if)" />
                <th className="is-left">Stock</th>
                <th className="is-left">Industry</th>
                <th title="Open trade's quantity, or the plan's lots">Size</th>
                <th>Notional</th>
                <th title="₹ lost if the stop is hit from the last price (open) or the entry (plan)">At stop</th>
                <th title="Beta to NIFTY over the window">β</th>
                <th title="Daily volatility over the window">σ/day</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const meta = all.positions.find((position) => position.symbol === row.position.symbol && position.kind === row.position.kind);
                const checked = included(row);
                return (
                  <tr key={`${row.position.kind}:${row.position.symbol}`} className={!checked ? "is-out" : undefined}>
                    <td>
                      {row.position.kind === "idea" ? (
                        <input type="checkbox" checked={checked} aria-label={`Count ${row.position.symbol} in the totals`} onChange={(event) => setToggled({ ...toggled, [row.position.symbol]: event.target.checked })} />
                      ) : null}
                    </td>
                    <td className="is-left">
                      <button type="button" className="tx-exposure-symbol" onClick={() => openIdea(row.position.symbol, row.idea?.screenId)} title={row.idea ? `${SCREEN_MAP[row.idea.screenId]?.name ?? ""}${row.idea.correlation ? `\n${row.idea.correlation.text}` : ""}` : "Open trade"}>
                        {row.position.symbol}
                      </button>{" "}
                      <span className={`tx-exposure-kind is-${row.skipped ? "skipped" : row.position.kind}`}>{row.skipped ? "skipped" : row.position.kind === "open" ? "open" : "plan"}</span>
                    </td>
                    <td className="is-left" title={row.position.industry}>
                      {row.position.industry || "—"}
                    </td>
                    <td>{row.lots !== null ? `${row.lots} lot${row.lots === 1 ? "" : "s"}` : row.position.qty}</td>
                    <td>{lakhs(row.position.notional)}</td>
                    <td>{rupees(row.position.risk)}</td>
                    <td>{meta?.beta != null ? meta.beta.toFixed(2) : "—"}</td>
                    <td>{meta?.vol != null ? pct(meta.vol, 1) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="tx-exposure-grid">
            <Sectors exposure={after} />
            <Heatmap exposure={all} threshold={threshold} />
          </div>
          {after.clusters.length > 0 && (
            <ul className="tx-exposure-clusters">
              {after.clusters.map((cluster) => (
                <li key={cluster.symbols.join(",")} className={cluster.correlatedRisk > budget * 1.001 ? "is-over" : undefined}>
                  <b>{cluster.symbols.join(" · ")}</b> move together: {rupees(cluster.correlatedRisk)} correlated risk ({(cluster.correlatedRisk / perTrade).toFixed(1)}× a trade&apos;s risk) of {rupees(cluster.grossRisk)} at their stops
                  {cluster.correlatedRisk > budget * 1.001
                    ? corrSizing
                      ? ` — over the ${maxCorrRisk}× budget from open trades alone (sizing only cuts new ideas)`
                      : ` — over a ${maxCorrRisk}× budget: correlation-aware sizing (⚙) would cut the plan's part`
                    : ""}
                </li>
              ))}
            </ul>
          )}
          {status && <p className="tx-scr-note">{status}</p>}
          {model && (
            <p className="tx-scr-note">
              Correlations of daily returns over {model.sessions} sessions{model.to ? ` to ${dayLabel(model.to)}` : ""}, shrunk {Math.round(model.shrinkage * 100)}% toward their average ({model.meanCorrelation.toFixed(2)}) so that chance highs and lows count less.
              {all.uncovered.length > 0 ? ` No history for ${all.uncovered.join(", ")}: assumed ρ 0.6 within an industry, 0.3 across.` : ""} Correlated risk = √(rᵀCr) of the ₹ at the stops: the sum if they all move as one.
              {!corrSizing ? " Correlation-aware sizing is off (plan settings ⚙): ideas are sized on their own." : ` Sizing holds each cluster to ${maxCorrRisk}× the risk per trade (${rupees(budget)}).`}
            </p>
          )}
          {returns?.status === "ready" && returns.notes.length > 0 && <p className="tx-scr-note">{returns.notes.join(" ")}</p>}
        </>
      )}
    </section>
  );
}

function Totals({ before, after, perTrade, hasOpen }: { before: Exposure; after: Exposure; perTrade: number; hasOpen: boolean }) {
  const r = (value: number) => `${(value / perTrade).toFixed(1)}R`;
  const items: Array<{ label: string; title: string; value: (e: Exposure) => string }> = [
    { label: "Notional", title: "Σ quantity × price", value: (e) => lakhs(e.notional) },
    { label: "At stops", title: "₹ lost if every stop is hit (in units of your risk per trade)", value: (e) => `${rupees(e.grossRisk)} · ${r(e.grossRisk)}` },
    { label: "Correlated", title: "√(rᵀCr): the stop risks combined through their correlations. Equal to the sum when everything moves as one.", value: (e) => `${rupees(e.correlatedRisk)} · ${r(e.correlatedRisk)}` },
    { label: "Bets", title: "Effective independent bets: (Σ risk)² ÷ correlated risk². Five bank longs at ρ 0.8 are ≈ 1.2 bets.", value: (e) => (e.grossRisk > 0 ? e.effectiveBets.toFixed(1) : "—") },
    { label: "Beta", title: "Σ notional × beta to NIFTY, as a multiple of capital; the ₹ shows what a 1% NIFTY move makes or loses", value: (e) => (e.netBeta === null || e.betaNotional === null ? "—" : `${e.netBeta.toFixed(2)}× · ${rupees(e.betaNotional / 100)}/1%`) },
    { label: "1-day σ", title: "One standard deviation of a day's P&L on notional (shrunk covariance)", value: (e) => (e.dailyVol === null ? "—" : rupees(e.dailyVol)) },
    { label: "Worst 5% day", title: "Mean loss on the worst 5% of the window's days, had you held these positions (historical; stops ignored)", value: (e) => (e.tailLoss === null ? "—" : rupees(e.tailLoss)) },
  ];
  return (
    <div className="tx-exposure-totals">
      {items.map((item) => (
        <span key={item.label} title={item.title}>
          <span className="tx-dim">{item.label}</span>
          {hasOpen && <span className="tx-exposure-before">{item.value(before)} →</span>}
          <b>{item.value(after)}</b>
        </span>
      ))}
    </div>
  );
}

function Sectors({ exposure }: { exposure: Exposure }) {
  if (!exposure.sectors.length) return null;
  return (
    <div className="tx-exposure-sectors" aria-label="Risk at the stops by sector">
      {exposure.sectors.map((sector) => (
        <div key={sector.industry} className="tx-exposure-sector" title={`${sector.count} position${sector.count === 1 ? "" : "s"} · ${lakhs(sector.notional)} notional · ${rupees(sector.risk)} at the stops`}>
          <span className="tx-exposure-sector-name">{sector.industry}</span>
          <span className="tx-exposure-bar">
            <i style={{ width: `${Math.max(2, sector.share * 100)}%` }} />
          </span>
          <span className="tx-exposure-share">{pct(sector.share)}</span>
        </div>
      ))}
    </div>
  );
}

function Heatmap({ exposure, threshold }: { exposure: Exposure; threshold: number }) {
  const { symbols, rho, assumed } = exposure.matrix;
  if (symbols.length < 2) return null;
  const shown = symbols.slice(0, MAX_HEATMAP);
  return (
    <div className="tx-exposure-heat" role="table" aria-label="Correlations of daily returns" style={{ gridTemplateColumns: `auto repeat(${shown.length}, 18px)` }}>
      <span />
      {shown.map((symbol) => (
        <span key={symbol} className="tx-exposure-heat-col" title={symbol}>
          {symbol.slice(0, 3)}
        </span>
      ))}
      {shown.map((a, i) => (
        <HeatRow key={a} symbol={a} cells={shown.map((b, j) => ({ b, rho: rho[i][j], assumed: assumed[i][j] }))} threshold={threshold} />
      ))}
      {symbols.length > shown.length && <span className="tx-dim tx-exposure-heat-more">+{symbols.length - shown.length} more not shown</span>}
    </div>
  );
}

function HeatRow({ symbol, cells, threshold }: { symbol: string; cells: Array<{ b: string; rho: number; assumed: boolean }>; threshold: number }) {
  return (
    <>
      <span className="tx-exposure-heat-row">{symbol}</span>
      {cells.map((cell) => (
        <span
          key={cell.b}
          className={`tx-exposure-cell ${cell.b !== symbol && cell.rho >= threshold ? "is-linked" : ""} ${cell.assumed ? "is-assumed" : ""}`}
          style={{ background: cell.b === symbol ? "var(--surface-3)" : cellColor(cell.rho) }}
          title={cell.b === symbol ? symbol : `${symbol} · ${cell.b}: ρ ${cell.rho.toFixed(2)}${cell.assumed ? " (assumed: no price history)" : ""}`}
        />
      ))}
    </>
  );
}

/** Ideas correlation-aware sizing set aside (their cluster was already at the budget): listed, not hidden. */
export function CorrelatedList({ plan }: { plan: Plan }) {
  return (
    <div className="tx-plan-unsized">
      <span className="tx-dim" title="Correlation-aware sizing (plan settings): these move with your open trades or the ideas above them, and their cluster already carries its correlated-risk budget. They don't take a slot.">
        Skipped, correlated:
      </span>
      {plan.correlated.map((idea) => (
        <button type="button" key={idea.symbol} className="tx-plan-chip" onClick={() => openIdea(idea.symbol, idea.screenId)} title={`${SCREEN_MAP[idea.screenId]?.name} · ${idea.entry.text}\n${idea.correlation?.text ?? ""}`}>
          {idea.symbol} <span className="tx-dim">ρ {idea.correlation?.peers[0]?.rho.toFixed(2)} {idea.correlation?.peers[0]?.symbol}</span>
        </button>
      ))}
    </div>
  );
}
