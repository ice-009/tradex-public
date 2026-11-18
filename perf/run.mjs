#!/usr/bin/env node
// Runs the performance benchmarks (perf/bench.ts) and checks them against
// their budgets and, optionally, against another checkout of the repo.
//
//   node perf/run.mjs [--base <dir>] [--rounds <n>] [--only a,b] [--threshold 0.2] [--json out.json] [--markdown out.md]
//
// The benchmark code and fixtures always come from THIS checkout; only `@/…`
// (the app's src/) is resolved against the checkout being measured. So with
// --base, both sides run the identical benchmark on identical data and only
// the app code differs. Each benchmark runs in a fresh Node process, and head
// and base alternate round by round on the same machine, so runner speed and
// background noise hit both sides alike. A metric's result is its median over
// the rounds.
//
// Fails (exit 1) when a metric is over its absolute budget, or when a compared
// metric is more than --threshold (default 20%) slower than the base — and at
// least MIN_DELTA_MS slower, so sub-millisecond jitter can't fail a run.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const MIN_DELTA_MS = 0.25;
const here = path.dirname(fileURLToPath(import.meta.url));
const headRoot = path.resolve(here, "..");

function parseArgs(argv) {
  const args = { base: null, rounds: null, only: null, threshold: 0.2, json: null, markdown: process.env.GITHUB_STEP_SUMMARY ?? null };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, value] = [argv[i], argv[i + 1]];
    if (key === "--base") args.base = path.resolve(value);
    else if (key === "--rounds") args.rounds = Number(value);
    else if (key === "--only") args.only = value.split(",");
    else if (key === "--threshold") args.threshold = Number(value);
    else if (key === "--json") args.json = value;
    else if (key === "--markdown") args.markdown = value;
    else throw new Error(`Unknown argument ${key}`);
    i += 1;
  }
  args.rounds ??= args.base ? 3 : 1;
  return args;
}

/** Bundle perf/bench.ts with `@/` pointing at `root`/src. */
async function bundle(root, outfile) {
  const src = path.join(root, "src");
  await esbuild.build({
    entryPoints: [path.join(here, "bench.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "error",
    // The base checkout has no node_modules of its own; anything bare resolves from this one.
    nodePaths: [path.join(headRoot, "node_modules")],
    plugins: [
      {
        name: "app-alias",
        setup(build) {
          build.onResolve({ filter: /^@\// }, (args) => build.resolve(`./${args.path.slice(2)}`, { resolveDir: src, kind: args.kind }));
        },
      },
    ],
  });
  return outfile;
}

function runOne(file, name) {
  const result = spawnSync(process.execPath, [file, name], { encoding: "utf8", maxBuffer: 1 << 24 });
  const line = result.stdout?.split("\n").find((l) => l.startsWith("PERF_RESULT "));
  if (result.status !== 0 || !line) return { error: (result.stderr || result.stdout || `exit ${result.status}`).trim().split("\n").slice(0, 8).join("\n") };
  return { metrics: JSON.parse(line.slice("PERF_RESULT ".length)) };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const fmt = (ms) => (ms === null || ms === undefined ? "–" : ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(2)} ms`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const work = mkdtempSync(path.join(tmpdir(), "tradex-perf-"));
  const sides = [{ id: "head", file: await bundle(headRoot, path.join(work, "head.mjs")) }];
  if (args.base) {
    try {
      sides.push({ id: "base", file: await bundle(args.base, path.join(work, "base.mjs")) });
    } catch (error) {
      console.warn(`::warning::Couldn't build the benchmarks against the base checkout, so only the budgets are checked: ${error.message}`);
    }
  }
  const list = spawnSync(process.execPath, [sides[0].file, "--list"], { encoding: "utf8" }).stdout.trim().split("\n");
  const names = args.only ?? list;

  // samples[side][metric] = [ms per round]; meta[metric] = head's last Metric (budget, info…)
  const samples = { head: {}, base: {} };
  const meta = {};
  const baseErrors = {};
  for (let round = 0; round < args.rounds; round += 1) {
    for (const name of names) {
      const order = round % 2 ? [...sides].reverse() : sides;
      for (const side of order) {
        if (side.id === "base" && baseErrors[name]) continue;
        const started = Date.now();
        const result = runOne(side.file, name);
        if (result.error) {
          if (side.id === "head") throw new Error(`Benchmark ${name} failed:\n${result.error}`);
          baseErrors[name] = result.error;
          console.warn(`::warning::Benchmark ${name} doesn't run against the base (an API it uses changed?), so it is checked against its budget only.\n${result.error}`);
          continue;
        }
        for (const [metric, value] of Object.entries(result.metrics)) {
          (samples[side.id][metric] ??= []).push(value.ms);
          if (side.id === "head") meta[metric] = value;
        }
        console.log(`round ${round + 1}/${args.rounds} ${side.id.padEnd(4)} ${name} (${((Date.now() - started) / 1000).toFixed(1)} s): ${Object.entries(result.metrics).map(([metric, value]) => `${metric} ${fmt(value.ms)}`).join(", ")}`);
      }
    }
  }

  const rows = Object.keys(meta).map((metric) => {
    const { budget, compare, info } = meta[metric];
    const head = median(samples.head[metric]);
    const base = samples.base[metric] ? median(samples.base[metric]) : null;
    const change = base ? head / base - 1 : null;
    const failures = [];
    if (budget !== null && head > budget) failures.push(`over budget (${fmt(head)} > ${fmt(budget)})`);
    if (compare && base !== null && change > args.threshold && head - base >= MIN_DELTA_MS) {
      failures.push(`${(change * 100).toFixed(0)}% slower than base (limit ${(args.threshold * 100).toFixed(0)}%)`);
    }
    return { metric, head, base, change, budget, compare, info, failures, samples: { head: samples.head[metric], base: samples.base[metric] ?? [] } };
  });

  const lines = [
    "### Performance budgets",
    "",
    `${args.rounds} round(s), median shown${sides.length > 1 ? "; base = the merge base, measured on the same runner" : ""}. Budgets: issue #14.`,
    "",
    "| Metric | Head | Base | Change | Budget | Result |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...rows.map((row) => {
      const change = row.change === null ? "–" : `${row.change >= 0 ? "+" : ""}${(row.change * 100).toFixed(1)}%${row.compare ? "" : " (not compared)"}`;
      return `| \`${row.metric}\` | ${fmt(row.head)} | ${fmt(row.base)} | ${change} | ${row.budget === null ? "–" : fmt(row.budget)} | ${row.failures.length ? `**FAIL**: ${row.failures.join("; ")}` : "ok"} |`;
    }),
    "",
    "<details><summary>Details</summary>",
    "",
    ...rows.map((row) => `- \`${row.metric}\`: ${Object.entries(row.info ?? {}).map(([key, value]) => `${key} ${value}`).join(", ") || "–"}; head ${row.samples.head.map(fmt).join(" / ")}${row.samples.base.length ? `; base ${row.samples.base.map(fmt).join(" / ")}` : ""}`),
    ...Object.entries(baseErrors).map(([name, error]) => `- \`${name}\` didn't run on the base: ${error.split("\n")[0]}`),
    "",
    "</details>",
    "",
  ];
  const markdown = lines.join("\n");
  console.log(`\n${markdown}`);
  if (args.markdown) appendFileSync(args.markdown, markdown);
  if (args.json) writeFileSync(args.json, JSON.stringify(rows, null, 2));

  const failed = rows.filter((row) => row.failures.length);
  if (failed.length) {
    for (const row of failed) console.error(`::error::${row.metric}: ${row.failures.join("; ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
