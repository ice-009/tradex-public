// Research studies from the command line. Run through scripts/research.mjs
// (`npm run research -- <study>`), which bundles this file with the app's `@/`
// paths. Needs HUB_URL and HUB_KEY (from the environment, or .env).
//
//   npm run research -- iima-check                 # issue #25: our momentum and market factors vs IIM Ahmedabad's
//   npm run research -- iima-check --weights ew    # equal-weight portfolios instead of traded-value weights
//   npm run research -- iima-check --json out.json # also write every month's numbers

import { runIimaCheck, IIMA_USAGE } from "./research/iimaCheck";

const STUDIES: Record<string, { usage: string; run: (argv: string[]) => Promise<number> }> = {
  "iima-check": { usage: IIMA_USAGE, run: runIimaCheck },
};

async function main() {
  const [study, ...rest] = process.argv.slice(2);
  if (!study || study === "--help" || study === "-h" || !STUDIES[study]) {
    console.log(`Usage: npm run research -- <study> [options]\n\nStudies:\n${Object.entries(STUDIES)
      .map(([id, item]) => `  ${id}\n${item.usage}`)
      .join("\n")}`);
    return study && !STUDIES[study] && study !== "--help" && study !== "-h" ? 1 : 0;
  }
  return STUDIES[study].run(rest);
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
