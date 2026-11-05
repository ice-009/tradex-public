"use client";

import { useMemo, useState } from "react";
import type { BacktestResponse } from "@/contracts/api";
import type { BacktestTrade, SampleStats } from "@/core/backtest/portfolio";
import type { MonthReturn } from "@/core/backtest/metrics";
import { SCREEN_MAP } from "@/core/screener/screens";
import { formatPrice } from "@/core/format";
import { GROUP_LABEL } from "@/client/screenerFeed";
import { openIdea } from "./ideaActions";
import { EquityChart } from "./BacktestChart";
import { formatDate, formatPct, formatR, formatRatio, formatRupees } from "./BacktestFormat";

type Ready = Extract<BacktestResponse, { status: "ready" }>;

const tone = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) || value === 0 ? "" : value > 0 ? "is-up" : "is-down");

export function BacktestResults({ data }: { data: Ready }) {
  const { result, runtime } = data;
  const { trade, equity, period, split } = result;
  const months = Math.round((period.sessions / 21) * 10) / 10;

  return (
    <div className="tx-bt-results">
      <p className="tx-bt-basis">
        Based on <b>{period.sessions}</b> sessions ({formatDate(period.from)} – {formatDate(period.to)}, ≈{months} months), <b>{result.signals.toLocaleString("en-IN")}</b> signals and{" "}
        <b>{trade.trades}</b> trades across {data.symbols} stocks. Sized in {result.config.sizing === "lots" ? "whole futures lots" : "whole shares"}, entry at{" "}
        {result.config.entry === "next-open" ? "the next session's open" : "the signal close"}.{" "}
        <span className="tx-dim">
          {runtime.cached ? "Cached result" : `Ran in ${runtime.scanCached ? "" : `${(runtime.scanMs / 1000).toFixed(1)} s scan + `}${runtime.simMs} ms`}.
        </span>
      </p>

      {result.warnings.length > 0 && (
        <ul className="tx-bt-warnings">
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <div className="tx-bt-kpis">
        <Kpi label="Total return" value={formatPct(equity.totalReturn)} tone={tone(equity.totalReturn)} sub={formatRupees(equity.endEquity - equity.startEquity)} />
        <Kpi label="CAGR" value={formatPct(equity.cagr, 1)} tone={tone(equity.cagr)} sub={equity.years < 0.95 ? `from ${months} mo` : `${equity.years.toFixed(1)} yrs`} />
        <Kpi label="Max drawdown" value={formatPct(equity.maxDrawdown)} tone={equity.maxDrawdown < 0 ? "is-down" : ""} sub={`${equity.maxDrawdownSessions} sessions below peak`} />
        <Kpi label="Win rate" value={trade.winRate === null ? "—" : `${(trade.winRate * 100).toFixed(0)}%`} sub={`${trade.wins}W / ${trade.losses}L`} />
        <Kpi label="Profit factor" value={trade.profitFactor === null ? (trade.trades ? "∞" : "—") : formatRatio(trade.profitFactor)} tone={trade.profitFactor === null ? "" : trade.profitFactor >= 1 ? "is-up" : "is-down"} />
        <Kpi label="Expectancy" value={formatR(trade.avgR)} tone={tone(trade.avgR)} sub={`${formatRupees(trade.expectancy)} / trade`} />
        <Kpi label="Sharpe" value={formatRatio(equity.sharpe)} sub={`Sortino ${formatRatio(equity.sortino)}`} />
        <Kpi label="Trades" value={String(trade.trades)} sub={`avg hold ${formatRatio(trade.avgHoldDays, 1)} sessions`} />
      </div>

      <section className="tx-bt-card">
        <EquityChart curve={result.curve} capital={result.config.capital} splitDate={split.date} />
      </section>

      <div className="tx-bt-two">
        <section className="tx-bt-card">
          <h3>In-sample vs out-of-sample</h3>
          <div className="tx-bt-scroll">
            <SplitTable inSample={split.inSample} outOfSample={split.outOfSample} fraction={split.fraction} />
          </div>
          <p className="tx-bt-hint">
            The last {Math.round(split.fraction * 100)}% of the period is treated as unseen. The screens weren&apos;t fitted to the first part, so this checks whether results are stable over
            time: similar numbers in both columns are reassuring; a much worse out-of-sample column means the overall result leans on one stretch of the market.
          </p>
        </section>
        <section className="tx-bt-card">
          <h3>More statistics</h3>
          <table className="tx-bt-mini">
            <tbody>
              <tr>
                <th>Net P&amp;L</th>
                <td className={tone(trade.netPnl)}>{formatRupees(trade.netPnl)}</td>
              </tr>
              <tr>
                <th>Avg win / avg loss</th>
                <td>
                  <span className="is-up">{formatRupees(trade.avgWin)}</span> / <span className="is-down">{formatRupees(trade.avgLoss)}</span>
                </td>
              </tr>
              <tr>
                <th>Best trade</th>
                <td>{result.best ? <TradeRef trade={result.best} /> : "—"}</td>
              </tr>
              <tr>
                <th>Worst trade</th>
                <td>{result.worst ? <TradeRef trade={result.worst} /> : "—"}</td>
              </tr>
              <tr>
                <th>Longest losing streak</th>
                <td>{trade.longestLosingStreak} trades</td>
              </tr>
              <tr>
                <th>Exposure</th>
                <td>{(equity.exposure * 100).toFixed(0)}% of sessions with a position</td>
              </tr>
              <tr>
                <th>NIFTY buy &amp; hold</th>
                <td className={tone(equity.benchReturn)}>{formatPct(equity.benchReturn)}</td>
              </tr>
              <tr>
                <th>Costs paid</th>
                <td>
                  {formatRupees(result.costs.total)} charges + {formatRupees(result.costs.slippage)} slippage
                  <div className="tx-dim tx-bt-small">
                    STT {formatRupees(result.costs.stt)} · brokerage {formatRupees(result.costs.brokerage)} · NSE {formatRupees(result.costs.exchange)} · stamp {formatRupees(result.costs.stamp)} · GST{" "}
                    {formatRupees(result.costs.gst)} · SEBI {formatRupees(result.costs.sebi)}
                  </div>
                </td>
              </tr>
              <tr>
                <th>Signals not taken</th>
                <td>
                  {result.skipped.noSlot} no free slot · {result.skipped.held} already held · {result.skipped.notTriggered} buy-stop not hit · {result.skipped.gapped} gapped past a level ·{" "}
                  {result.skipped.tooSmall} too small to size
                </td>
              </tr>
            </tbody>
          </table>
          <p className="tx-bt-hint">Sharpe and Sortino use daily close-to-close equity returns, annualised by √252, with a 0% risk-free rate.</p>
        </section>
      </div>

      {result.byScreen.length > 0 && (
        <section className="tx-bt-card">
          <h3>By strategy</h3>
          <div className="tx-bt-scroll">
            <table className="tx-bt-table">
              <thead>
                <tr>
                  <th className="is-left">Strategy</th>
                  <th>Hold</th>
                  <th>First signal</th>
                  <th>Signals</th>
                  <th>Trades</th>
                  <th>Win rate</th>
                  <th>Avg R</th>
                  <th>PF</th>
                  <th>Net P&amp;L</th>
                  <th>Avg held</th>
                </tr>
              </thead>
              <tbody>
                {result.byScreen.map((row) => (
                  <tr key={row.screenId} className="is-static">
                    <td className="is-left">
                      <span className={`tx-bt-strat tx-hz-${row.group}`}>
                        <span className="tx-hz-dot" />
                        {GROUP_LABEL[row.group]} · {row.name}
                      </span>
                    </td>
                    <td>{row.holdBars}d</td>
                    <td>{row.firstSignal ? formatDate(row.firstSignal) : "never"}</td>
                    <td>{row.signals}</td>
                    <td>{row.stats.trades}</td>
                    <td>{row.stats.winRate === null ? "—" : `${(row.stats.winRate * 100).toFixed(0)}%`}</td>
                    <td className={tone(row.stats.avgR)}>{formatR(row.stats.avgR)}</td>
                    <td>{row.stats.profitFactor === null ? (row.stats.trades ? "∞" : "—") : formatRatio(row.stats.profitFactor)}</td>
                    <td className={tone(row.stats.netPnl)}>{formatRupees(row.stats.netPnl)}</td>
                    <td>{formatRatio(row.stats.avgHoldDays, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="tx-bt-card">
        <h3>Monthly returns</h3>
        <MonthlyHeatmap months={result.monthly} />
      </section>

      <section className="tx-bt-card">
        <h3>
          Trades <span className="tx-dim">({result.trades.length}) · click a row to open its daily chart</span>
        </h3>
        <TradeTable trades={result.trades} />
      </section>
    </div>
  );
}

function Kpi({ label, value, sub, tone: toneClass = "" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="tx-bt-kpi">
      <span className="tx-bt-kpi-label">{label}</span>
      <span className={`tx-bt-kpi-value ${toneClass}`}>{value}</span>
      {sub && <span className="tx-bt-kpi-sub">{sub}</span>}
    </div>
  );
}

function TradeRef({ trade }: { trade: BacktestTrade }) {
  return (
    <button type="button" className="tx-bt-link" onClick={() => openIdea(trade.symbol)}>
      {trade.symbol} {formatDate(trade.entryDate, false)}: <span className={tone(trade.pnl)}>{formatRupees(trade.pnl)}</span> ({formatR(trade.r)})
    </button>
  );
}

function SplitTable({ inSample, outOfSample, fraction }: { inSample: SampleStats; outOfSample: SampleStats; fraction: number }) {
  const rows: Array<{ label: string; get: (s: SampleStats) => string; num?: (s: SampleStats) => number | null }> = [
    { label: "Period", get: (s) => `${formatDate(s.from, false)} – ${formatDate(s.to, false)}` },
    { label: "Sessions", get: (s) => String(s.equity.sessions) },
    { label: "Trades", get: (s) => String(s.trades.trades) },
    { label: "Win rate", get: (s) => (s.trades.winRate === null ? "—" : `${(s.trades.winRate * 100).toFixed(0)}%`) },
    { label: "Avg R", get: (s) => formatR(s.trades.avgR), num: (s) => s.trades.avgR },
    { label: "Profit factor", get: (s) => (s.trades.profitFactor === null ? (s.trades.trades ? "∞" : "—") : formatRatio(s.trades.profitFactor)) },
    { label: "Return", get: (s) => formatPct(s.equity.totalReturn), num: (s) => s.equity.totalReturn },
    { label: "Max drawdown", get: (s) => formatPct(s.equity.maxDrawdown), num: (s) => s.equity.maxDrawdown },
    { label: "Sharpe", get: (s) => formatRatio(s.equity.sharpe) },
  ];
  return (
    <table className="tx-bt-table tx-bt-split">
      <thead>
        <tr>
          <th className="is-left" />
          <th>In-sample ({Math.round((1 - fraction) * 100)}%)</th>
          <th>Out-of-sample ({Math.round(fraction * 100)}%)</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} className="is-static">
            <th className="is-left">{row.label}</th>
            <td className={row.num ? tone(row.num(inSample)) : ""}>{row.get(inSample)}</td>
            <td className={row.num ? tone(row.num(outOfSample)) : ""}>{row.get(outOfSample)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function MonthlyHeatmap({ months }: { months: MonthReturn[] }) {
  if (!months.length) return <p className="tx-bt-hint">No months in the period.</p>;
  const years = [...new Set(months.map((m) => m.year))].sort();
  const scale = Math.max(0.02, ...months.map((m) => Math.abs(m.ret)));
  const yearReturn = (year: number) => months.filter((m) => m.year === year).reduce((acc, m) => acc * (1 + m.ret), 1) - 1;
  return (
    <div className="tx-bt-scroll">
      <table className="tx-bt-heat">
        <thead>
          <tr>
            <th />
            {MONTH_NAMES.map((name) => (
              <th key={name}>{name}</th>
            ))}
            <th>Year</th>
          </tr>
        </thead>
        <tbody>
          {years.map((year) => (
            <tr key={year}>
              <th>{year}</th>
              {MONTH_NAMES.map((_, month) => {
                const m = months.find((entry) => entry.year === year && entry.month === month);
                if (!m) return <td key={month} className="is-empty" />;
                const strength = Math.min(1, Math.abs(m.ret) / scale);
                const color = m.ret >= 0 ? "var(--pos)" : "var(--neg)";
                return (
                  <td
                    key={month}
                    style={{ background: `color-mix(in srgb, ${color} ${Math.round(8 + strength * 52)}%, transparent)` }}
                    title={`${MONTH_NAMES[month]} ${year}: strategy ${formatPct(m.ret)}${m.bench !== null ? ` · NIFTY ${formatPct(m.bench)}` : ""}`}
                  >
                    {formatPct(m.ret, 1)}
                  </td>
                );
              })}
              <td className={`tx-bt-heat-year ${tone(yearReturn(year))}`}>{formatPct(yearReturn(year), 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type SortKey = "symbol" | "screen" | "signalDate" | "entryDate" | "exitDate" | "exitReason" | "r" | "pnl" | "pnlPct" | "costs" | "holdDays";

const COLUMNS: Array<{ key: SortKey; label: string; left?: boolean }> = [
  { key: "symbol", label: "Symbol", left: true },
  { key: "screen", label: "Strategy", left: true },
  { key: "signalDate", label: "Signal" },
  { key: "entryDate", label: "Entry" },
  { key: "exitDate", label: "Exit" },
  { key: "exitReason", label: "Reason" },
  { key: "r", label: "R" },
  { key: "pnl", label: "P&L ₹" },
  { key: "pnlPct", label: "P&L %" },
  { key: "costs", label: "Costs" },
  { key: "holdDays", label: "Held" },
];

const REASON: Record<BacktestTrade["exitReason"], string> = { target: "Target", stop: "Stop", time: "Time", end: "Period end" };

function TradeTable({ trades }: { trades: BacktestTrade[] }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "exitDate", dir: -1 });
  const sorted = useMemo(() => {
    const value = (t: BacktestTrade): number | string =>
      sort.key === "screen" ? (SCREEN_MAP[t.screenId]?.name ?? t.screenId) : sort.key === "costs" ? t.costs + t.slippage : (t[sort.key] as number | string);
    return [...trades].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      return (typeof va === "string" ? va.localeCompare(vb as string) : va - (vb as number)) * sort.dir || a.id - b.id;
    });
  }, [trades, sort]);

  if (!trades.length) return <p className="tx-bt-hint">No trades.</p>;
  return (
    <div className="tx-bt-scroll tx-bt-trades">
      <table className="tx-bt-table">
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th key={column.key} className={column.left ? "is-left" : ""} aria-sort={sort.key === column.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                <button
                  type="button"
                  onClick={() => setSort((current) => (current.key === column.key ? { key: column.key, dir: current.dir === 1 ? -1 : 1 } : { key: column.key, dir: column.left ? 1 : -1 }))}
                >
                  {column.label}
                  {sort.key === column.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((t) => {
            const screen = SCREEN_MAP[t.screenId];
            return (
              <tr key={t.id} onClick={() => openIdea(t.symbol)} title={`Open ${t.symbol}'s daily chart`}>
                <td className="is-left">
                  <b>{t.symbol}</b>
                  {t.sample === "out" && <span className="tx-bt-oos-tag" title="Out-of-sample trade">OOS</span>}
                </td>
                <td className="is-left">
                  <span className={`tx-bt-strat tx-hz-${screen?.group ?? "swing"}`}>
                    <span className="tx-hz-dot" />
                    {screen?.name ?? t.screenId}
                  </span>
                </td>
                <td>{formatDate(t.signalDate, false)}</td>
                <td title={`${t.lots !== null ? `${t.lots} lot${t.lots === 1 ? "" : "s"} · ` : ""}${t.qty} shares`}>
                  {formatDate(t.entryDate, false)} <span className="tx-dim">@ {formatPrice(t.entryPrice)}</span>
                </td>
                <td>
                  {formatDate(t.exitDate, false)} <span className="tx-dim">@ {formatPrice(t.exitPrice)}</span>
                </td>
                <td className={t.exitReason === "target" ? "is-up" : t.exitReason === "stop" ? "is-down" : ""}>{REASON[t.exitReason]}</td>
                <td className={tone(t.r)}>{formatR(t.r)}</td>
                <td className={tone(t.pnl)}>{formatRupees(t.pnl)}</td>
                <td className={tone(t.pnlPct)}>{formatPct(t.pnlPct / 100)}</td>
                <td className="tx-dim" title={`Charges ${formatRupees(t.costs)} + slippage ${formatRupees(t.slippage)}`}>
                  {formatRupees(t.costs + t.slippage)}
                </td>
                <td>{t.holdDays}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
