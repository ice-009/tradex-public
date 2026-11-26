// Volatility-managed momentum from the command line (issue #27): a signal's
// monthly long–short book with and without Barroso–Santa-Clara volatility
// scaling (src/server/services/labOverlay.ts). Run through scripts/lab.mjs:
//
//   npm run lab -- overlay --signal momentum-12-1 --from 2002-01-01 --sub-from 2010-01-01
//   npm run lab -- overlay --signal residual-momentum --param factors=2 --from 2002-01-01 --json out.json
//
// Both books are recorded as trials of the idea "vol-managed-momentum" (#24).

import { writeFileSync } from "node:fs";
import type { CostPresetId } from "@/core/backtest/costs";
import type { OverlayStats } from "@/core/lab/overlay";
import { shortHash } from "@/core/repro/stamp";
import { OVERLAY_IDEA, runOverlay } from "@/server/services/labOverlay";
import { trialSummary } from "@/server/services/labTrials";

const USAGE = `Usage: npm run lab -- overlay --signal <id> [--param key=value …] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
       [--sub-from YYYY-MM-DD (default 2010-01-01)] [--lookback 126] [--quantiles 5] [--costs futures-2026] [--universe fno] [--json <file>]`;

const day = (iso: string | undefined) => {
  if (!iso) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`Not a date: ${iso} (use YYYY-MM-DD)`);
  return t;
};
const iso = (t: number | null) => (t === null ? "—" : new Date(t).toISOString().slice(0, 10));
const pct = (value: number | null, digits = 2) => (value === null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : "−"}${Math.abs(value * 100).toFixed(digits)}%`);
const num = (value: number | null, digits = 2) => (value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits));

function table(rows: string[][]) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((row) => row[c].length)));
  return rows.map((row, r) => row.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join("  ") + (r === 0 ? `\n${widths.map((w) => "-".repeat(w)).join("  ")}` : "")).join("\n");
}

function summary(label: string, books: Array<[string, OverlayStats | null]>) {
  const rows = [["Book", "Months", "Mean/mo", "t (NW3)", "Sd/mo", "Sharpe/yr", "Hit", "Max DD", "Worst mo", "Up mean (t)", "Down mean (t)", "First 60%", "Last 40%", "Weight avg [min–max]"]];
  for (const [name, s] of books) {
    if (!s) continue;
    rows.push([
      name,
      String(s.months),
      pct(s.mean),
      num(s.t),
      pct(s.sd),
      num(s.sharpeAnnual),
      s.hitRate === null ? "—" : `${Math.round(s.hitRate * 100)}%`,
      pct(s.maxDrawdown === null ? null : -s.maxDrawdown, 1),
      s.worst[0] ? `${pct(s.worst[0].net, 1)} ${iso(s.worst[0].end).slice(0, 7)}` : "—",
      `${pct(s.regimes.up.mean)} (${num(s.regimes.up.t)})`,
      `${pct(s.regimes.down.mean)} (${num(s.regimes.down.t)})`,
      pct(s.split.first.mean),
      pct(s.split.last.mean),
      s.weight ? `${num(s.weight.mean)} [${num(s.weight.min)}–${num(s.weight.max)}]` : "1",
    ]);
  }
  console.log(`\n${label}`);
  console.log(table(rows));
  const crash = [["Period", ...books.filter(([, s]) => s).map(([name]) => name)]];
  const first = books.find(([, s]) => s)?.[1];
  first?.periods.forEach((period, i) => crash.push([`${period.label} (${period.months} mo)`, ...books.filter(([, s]) => s).map(([, s]) => pct(s!.periods[i].net, 1))]));
  console.log("");
  console.log(table(crash));
}

async function main() {
  const argv = process.argv.slice(2);
  const args: Record<string, string> = {};
  const params: Record<string, number> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [key, value] = [argv[i], argv[i + 1]];
    if (key === "--help" || key === "-h") {
      console.log(USAGE);
      return 0;
    }
    if (!key.startsWith("--") || value === undefined) throw new Error(`Unexpected argument ${key}\n\n${USAGE}`);
    if (key === "--param") {
      const [name, raw] = value.split("=");
      if (!name || raw === undefined || !Number.isFinite(Number(raw))) throw new Error(`--param wants key=number, got ${value}`);
      params[name] = Number(raw);
    } else args[key.slice(2)] = value;
  }
  if (!args.signal) throw new Error(`Pick a signal with --signal.\n\n${USAGE}`);
  const started = Date.now();
  process.stderr.write(`Volatility-managed ${args.signal} on ${args.universe ?? "fno"} (daily bars from the Market Data Hub's archive)…\n`);
  const result = await runOverlay({
    signal: args.signal,
    params,
    universe: args.universe ?? "fno",
    from: day(args.from),
    to: day(args.to),
    subFrom: day(args["sub-from"] ?? "2010-01-01"),
    costPreset: args.costs as CostPresetId | undefined,
    quantiles: args.quantiles ? Number(args.quantiles) : undefined,
    lookback: args.lookback ? Number(args.lookback) : undefined,
  });
  const p = result.plain;
  const m = result.managed;
  console.log(`Volatility-managed momentum — ${result.signal.name} (${result.signal.id} ${JSON.stringify(result.signal.params)})`);
  console.log(
    `Monthly Q5 − Q1 book, formed at each month's last close; ${result.lookback}-day volatility forecast; target ${pct(result.targetMonthlyVol)} a month (managed volatility = plain over the full period). Costs: ${result.costs}, on stocks entering a leg.`,
  );
  summary(`Full period: months formed ${iso(p.full.from)} – ${iso(p.full.to)} (managed − plain: NW t ${num(result.differenceT.full)})`, [
    ["Plain", p.full],
    ["Vol-managed", m.full],
  ]);
  if (p.sub && m.sub) {
    summary(`Since ${iso(p.sub.from)} (managed − plain: NW t ${num(result.differenceT.sub)})`, [
      ["Plain", p.sub],
      ["Vol-managed", m.sub],
    ]);
  }
  console.log(`\nDeflated-Sharpe inputs (monthly net): plain SR ${num(p.full.sharpe, 3)} T ${p.full.months} skew ${num(p.full.skewness)} kurt ${num(p.full.kurtosis)}; managed SR ${num(m.full.sharpe, 3)} T ${m.full.months} skew ${num(m.full.skewness)} kurt ${num(m.full.kurtosis)}`);
  console.log(`Data errors (stock-sessions beyond ±50%, earning 0): ${result.dataErrors}; months skipped: ${result.skippedMonths}.`);
  for (const note of result.notes) console.log(`Note: ${note}`);
  console.log(`Stamp ${shortHash(result.stamp.hash)} · data ${shortHash(result.stamp.data.hash)} (${result.stamp.data.symbols.length} stocks) · code ${result.stamp.code.commit} ${result.stamp.code.engine}`);
  if (result.trials.error) console.log(`Trials NOT recorded: ${result.trials.error}`);
  else {
    const s = trialSummary(OVERLAY_IDEA);
    for (const key of result.trials.variantKeys) {
      const row = s.variants.find((variant) => variant.variantKey === key);
      if (row) console.log(`Trial ${key}: Sharpe ${num(row.annualSharpe)}/yr, deflated Sharpe ${num(row.dsr, 3)}${row.passes ? " — passes" : ""}`);
    }
    console.log(`Trials: idea ${OVERLAY_IDEA} has ${s.n} distinct (${s.runs} runs); luck benchmark Sharpe ${num(s.sr0Annual)}/yr.`);
  }
  console.log(`Time: ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  if (args.json) {
    writeFileSync(args.json, JSON.stringify(result, null, 2));
    console.log(`Wrote ${args.json}.`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
