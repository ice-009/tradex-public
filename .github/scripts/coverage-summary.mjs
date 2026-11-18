// Turns coverage/coverage-summary.json (vitest --coverage) into a Markdown
// table per layer, for the CI job summary on every PR.
// Usage: node .github/scripts/coverage-summary.mjs >> "$GITHUB_STEP_SUMMARY"

import { readFileSync } from "node:fs";
import path from "node:path";

const summary = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8"));
const root = path.resolve("src");
const metrics = ["lines", "statements", "functions", "branches"];
const layers = new Map();

for (const [file, entry] of Object.entries(summary)) {
  if (file === "total") continue;
  const relative = path.relative(root, file);
  const layer = relative.includes(path.sep) ? `src/${relative.split(path.sep)[0]}` : "src (root)";
  const totals = layers.get(layer) ?? Object.fromEntries(metrics.map((metric) => [metric, { covered: 0, total: 0 }]));
  for (const metric of metrics) {
    totals[metric].covered += entry[metric].covered;
    totals[metric].total += entry[metric].total;
  }
  layers.set(layer, totals);
}

const pct = ({ covered, total }) => (total ? `${((covered / total) * 100).toFixed(1)}%` : "–");
const lines = [
  "### Unit-test coverage",
  "",
  "| Layer | Lines | Statements | Functions | Branches |",
  "|---|---:|---:|---:|---:|",
  ...[...layers.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([layer, totals]) => `| ${layer === "src/core" ? "**src/core** (floor in vitest.config.ts)" : layer} | ${metrics.map((metric) => pct(totals[metric])).join(" | ")} |`),
  `| **All of src** | ${metrics.map((metric) => `**${summary.total[metric].pct.toFixed(1)}%**`).join(" | ")} |`,
  "",
  "Only `src/core` has a floor; the full HTML report is in this run's `coverage` artifact.",
];
console.log(lines.join("\n"));
