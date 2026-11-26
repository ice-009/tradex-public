// The Signal Lab from the command line (issue #22): the same service and the
// same report as the Lab panel. Run through scripts/lab.mjs (`npm run lab`),
// which bundles this file with the app's `@/` paths. Needs HUB_URL and HUB_KEY
// (read from .env when present); reads daily bars from the hub's archive like
// the server, records every run in the trial record (#24, .cache/market.db) and
// saves it as the variant's report card (#23), whose verdict it prints last.
//
//   npm run lab -- --list
//   npm run lab -- --signal momentum-12-1 --from 2021-01-01
//   npm run lab -- --signal screen:pos-52w-high --horizons 1,5,10,21 --costs futures-2026
//   npm run lab -- --signal reversal-1m --param lookback=10 --from 2010-01-01 --to 2015-12-31 --json out.json

import { writeFileSync } from "node:fs";
import { COST_PRESETS } from "@/core/backtest/costs";
import { MARKET_PHASES, phaseById } from "@/core/backtest/phases";
import { formatLabReport, num } from "@/core/lab/format";
import { LAB_SIGNALS, findSignal } from "@/core/lab/signals";
import { shortHash } from "@/core/repro/stamp";
import { parseLabRequest, runLabRequest } from "@/server/services/lab";
import { labCard } from "@/server/services/labCards";
import { trialSummary } from "@/server/services/labTrials";

const USAGE = `Usage: npm run lab -- --signal <id> [options]

  --signal <id>        a signal (see --list): momentum-12-1, screen:<screen id>, screen-score:<screen id>, …
  --param key=value    a signal parameter (repeatable)
  --universe <id>      fno (default), nifty50, nifty200, nifty500
  --from YYYY-MM-DD    first formation day, back to 1994 (default: 5 years ago); longer periods take longer
  --to YYYY-MM-DD      last formation day (default: newest session)
  --phase <id>         a market phase instead of --from/--to: ${MARKET_PHASES.map((phase) => phase.id).join(", ")}
  --horizons 1,5,10,21 forward horizons in sessions
  --quantiles 5        buckets
  --costs <preset>     ${Object.keys(COST_PRESETS).join(", ")} (default futures-2026)
  --json <file>        also write the full response (report + stamp) as JSON
  --list               list the signals`;

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  const params: Record<string, number> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--list" || key === "--help" || key === "-h") {
      args[key.replace(/^-+/, "")] = "1";
      continue;
    }
    const value = argv[i + 1];
    if (!key.startsWith("--") || value === undefined) throw new Error(`Unexpected argument ${key}\n\n${USAGE}`);
    i += 1;
    if (key === "--param") {
      const [name, raw] = value.split("=");
      if (!name || raw === undefined || !Number.isFinite(Number(raw))) throw new Error(`--param wants key=number, got ${value}`);
      params[name] = Number(raw);
    } else args[key.slice(2)] = value;
  }
  return { args, params };
}

const day = (iso: string | undefined) => {
  if (!iso) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`Not a date: ${iso} (use YYYY-MM-DD)`);
  return t;
};

async function main() {
  const { args, params } = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.list) {
    for (const signal of LAB_SIGNALS) {
      const defaults = signal.params.map((spec) => `${spec.key}=${spec.default}`).join(", ");
      console.log(`${signal.id.padEnd(36)} ${signal.name}${defaults ? ` (${defaults})` : ""}`);
    }
    return 0;
  }
  if (!args.signal || !findSignal(args.signal)) throw new Error(`${args.signal ? `Unknown signal "${args.signal}". ` : ""}Pick one with --signal (--list shows them).\n\n${USAGE}`);
  const phase = args.phase ? phaseById(args.phase) : null;
  if (args.phase && !phase) throw new Error(`Unknown phase "${args.phase}".`);
  const request = parseLabRequest({
    signal: args.signal,
    params,
    universe: args.universe ?? "fno",
    from: phase ? phase.from : day(args.from),
    to: phase ? phase.to : day(args.to),
    horizons: args.horizons ? args.horizons.split(",").map(Number) : undefined,
    quantiles: args.quantiles ? Number(args.quantiles) : undefined,
    costPreset: args.costs,
  });

  const started = Date.now();
  process.stderr.write(`Running ${request.signal} on ${request.universe} (daily bars from the Market Data Hub's archive)…\n`);
  const response = await runLabRequest(request);
  if (response.status === "error") throw new Error(response.error);

  const { report, stamp, runtime, trials } = response;
  console.log(formatLabReport(report).join("\n"));
  console.log("");
  console.log(`Costs: ${response.costs.label}.`);
  console.log(`Stamp ${shortHash(stamp.hash)} · data ${shortHash(stamp.data.hash)} (${stamp.data.symbols.length} stocks) · code ${stamp.code.commit} ${stamp.code.engine} · result ${shortHash(stamp.resultHash)}`);
  if (trials.error) console.log(`Trials NOT recorded: ${trials.error}`);
  else {
    const summary = trialSummary(trials.ideaId);
    const best = summary.best;
    console.log(
      `Trials: ${trials.recorded} recorded for idea ${trials.ideaId} (${summary.n} distinct, ${summary.runs} runs; luck benchmark Sharpe ${num(summary.sr0Annual)}/yr)` +
        (best ? `; best ${best.variantKey} @ ${best.horizon}d: deflated Sharpe ${num(best.verdict.dsr, 3)} — ${best.verdict.reason}` : ""),
    );
  }
  const card = labCard(report.signal.id, report.signal.variantKey)?.card;
  const verdict = card?.verdicts.find((entry) => entry.horizon === card.primary);
  if (verdict) {
    console.log("");
    console.log(`Verdict (report card, /lab/${encodeURIComponent(report.signal.id)}): ${verdict.label.toUpperCase()} at ${verdict.horizon}d — ${verdict.headline}`);
    for (const reason of verdict.reasons) console.log(`  · ${reason}`);
  }
  console.log(`Time: load ${(runtime.loadMs / 1000).toFixed(1)} s, signal ${(runtime.signalMs / 1000).toFixed(1)} s, lab ${(runtime.labMs / 1000).toFixed(2)} s; total ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  if (args.json) {
    writeFileSync(args.json, JSON.stringify(response, null, 2));
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
