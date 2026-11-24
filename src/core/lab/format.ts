import type { DecayPoint, HorizonReport, LabReport, SpreadPair } from "./engine";

// The Lab report as plain text: what the CLI prints (`npm run lab`). The Lab
// panel shows the same numbers from the same LabReport. Pure.

/** A fraction as a signed percentage: 0.0123 → "+1.23%". */
export function pct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const p = value * 100;
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(digits)}%`;
}

/** A t-stat or ratio: "2.31", "−0.40". */
export function num(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}`;
}

export const isoDay = (day: number | null | undefined) => (day === null || day === undefined ? "—" : new Date(day).toISOString().slice(0, 10));

const pad = (text: string, width: number) => (text.length >= width ? text : " ".repeat(width - text.length) + text);
const padEnd = (text: string, width: number) => (text.length >= width ? text : text + " ".repeat(width - text.length));

function table(head: string[], rows: string[][]): string[] {
  const widths = head.map((cell, i) => Math.max(cell.length, ...rows.map((row) => row[i]?.length ?? 0)));
  const line = (cells: string[]) => cells.map((cell, i) => (i === 0 ? padEnd(cell, widths[i]) : pad(cell, widths[i]))).join("  ");
  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)];
}

const pair = (p: SpreadPair) => [pct(p.net.mean, 3), num(p.net.t), String(p.net.n)];

/** "Edge", "No edge" per the evidence's PASS rule. */
export const verdictOf = (h: HorizonReport) => (h.passes ? "PASS" : (h.spread.net.mean ?? 0) > 0 ? "weak" : "none");

export function formatLabReport(report: LabReport): string[] {
  const { signal, period, universe } = report;
  const params = Object.entries(signal.params)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  const out: string[] = [
    `Signal Lab — ${signal.name} (${signal.id}${params ? `; ${params}` : ""})`,
    `Variant ${signal.variantKey}`,
    `Period ${isoDay(period.from)} – ${isoDay(period.to)}: ${period.days} ranked sessions of ${period.sessions}; ${universe.symbols} stocks, ${universe.perDay.mean.toFixed(0)} a day (${universe.perDay.min}–${universe.perDay.max}).`,
    `Q${report.quantiles} = highest values. Costs: ${pct(report.costPerTrade, 3)} a round trip per position (futures, slippage both legs + charges).`,
    `Observations ${report.observations}; closed at a delisted stock's last close ${report.truncated}; left out as data errors (a session beyond ±${Math.round(report.dataErrors.maxDailyMove * 100)}%) ${report.dataErrors.observations}.`,
    "",
    "Long–short spread (Q5 − Q1), per formation day; t-stats Newey–West with lag h − 1",
    ...table(
      ["Horizon", "Gross", "Net", "t (net)", "Days", "Sharpe/yr", "Hit", "IC", "IC t", "Net @ turnover", "Verdict"],
      report.byHorizon.map((h) => [
        `${h.horizon}d`,
        pct(h.spread.gross.mean, 3),
        pct(h.spread.net.mean, 3),
        num(h.spread.net.t),
        String(h.spread.net.n),
        num(h.sharpeAnnual),
        pct(h.spread.net.hitRate, 0),
        num(h.ic.mean, 3),
        num(h.ic.t),
        pct(h.netAtTurnover, 3),
        verdictOf(h),
      ]),
    ),
    "",
    `Quantile returns (gross, mean per day)`,
    ...table(
      ["Bucket", "Stocks", ...report.byHorizon.map((h) => `${h.horizon}d`), ...report.byHorizon.map((h) => `t ${h.horizon}d`)],
      Array.from({ length: report.quantiles }, (_, b) => [
        `Q${b + 1}`,
        (report.byHorizon[0]?.quantiles[b]?.stocks ?? 0).toFixed(1),
        ...report.byHorizon.map((h) => pct(h.quantiles[b].gross, 3)),
        ...report.byHorizon.map((h) => num(h.quantiles[b].t)),
      ]),
    ),
    "",
    "Net spread by market regime (NIFTY vs its 200-day average) and by the first 60% / last 40% of days",
    ...table(
      ["Horizon", "Up", "t", "n", "Down", "t", "n", "First 60%", "t", "n", "Last 40%", "t", "n"],
      report.byHorizon.map((h) => [`${h.horizon}d`, ...pair(h.regimes.up), ...pair(h.regimes.down), ...pair(h.split.first), ...pair(h.split.last)]),
    ),
    `Split at ${isoDay(report.byHorizon[0]?.split.splitDate)}.`,
    "",
    "Turnover: share of the long / short leg replaced since the last rebalance",
    ...table(
      ["Rebalance", "Long (top)", "Short (bottom)", ...Array.from({ length: report.quantiles }, (_, b) => `Q${b + 1}`)],
      [
        ["daily", pct(report.dailyTurnover.long, 0), pct(report.dailyTurnover.short, 0), ...report.dailyTurnover.buckets.map((v) => pct(v, 0))],
        ...report.byHorizon.map((h) => [`every ${h.horizon}d`, pct(h.turnover.long, 0), pct(h.turnover.short, 0), ...h.turnover.buckets.map((v) => pct(v, 0))]),
      ],
    ),
    "",
    "Decay: spread by horizon (cumulative) and of that one session alone (marginal)",
    ...table(
      ["h", "Gross", "Net", "t", "Marginal", "t"],
      report.decay.map((d: DecayPoint) => [`${d.horizon}`, pct(d.gross, 3), pct(d.net, 3), num(d.t), pct(d.marginal, 3), num(d.marginalT)]),
    ),
    "",
    "Deflated-Sharpe inputs (net spread, every h-th day: non-overlapping)",
    ...table(
      ["Horizon", "Sharpe", "n", "Skew", "Kurtosis"],
      report.byHorizon.map((h) => [`${h.horizon}d`, num(h.dsr.sharpe, 3), String(h.dsr.n), num(h.dsr.skewness), num(h.dsr.kurtosis)]),
    ),
  ];
  if (report.notes.length) out.push("", ...report.notes.map((note) => `Note: ${note}`));
  return out;
}
