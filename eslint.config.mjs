import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Layer boundaries (see ARCHITECTURE.md). Each layer may import only from the
// layers listed for it; anything else is a lint error.
const layerPatterns = (message, ...groups) => groups.map((group) => ({ group, message }));
const layer = (message, ...groups) => ({
  "no-restricted-imports": ["error", { patterns: layerPatterns(message, ...groups) }],
});
const NO_UI = ["@/terminal/*", "@/components/*", "@/app/*", "react", "react-dom", "next", "next/*"];
const CORE_LAYER = layerPatterns("src/core is the pure engine: import only from @/core.", ["@/server/*", "@/client/*", "@/contracts/*", "@/chart/*", ...NO_UI, "node:*", "fs", "path"]);
const SERVER_LAYER = layerPatterns("src/server must not import frontend code.", ["@/client/*", "@/chart/*", "@/terminal/*", "@/components/*", "@/app/*", "react", "react-dom"]);

// Point in time (issue #19): the screener, the plan and the backtester read
// reference data — F&O list, lot sizes, ban list, results, sector map,
// universes, tickers, price factors — only through asOf
// (src/server/providers/asOf.ts), never from the providers behind it. Matched
// by regex so relative imports ("../providers/reference") are caught too.
const AS_OF = "Read reference data through asOf (@/server/providers/asOf), so it is as known on the day (issue #19).";
const REFERENCE_READS = [
  { regex: "(^|/)providers/(reference|referenceHistory)$", message: AS_OF },
  { regex: "(^|/)providers/foData$", importNames: ["foMembership"], message: AS_OF },
  { regex: "(^|/)providers/universe$", importNames: ["getUniverse"], message: AS_OF },
  { regex: "(^|/)providers/hub$", importNames: ["hubClient"], message: AS_OF },
  { regex: "(^|/)providers/hub/client$", importNames: ["HubClient"], message: AS_OF },
];
/** The screener, plan and backtest engines and the services that run them. */
const POINT_IN_TIME_ENGINE = ["src/core/screener/**", "src/core/plan/**", "src/core/backtest/**", "src/core/lab/**"];
const POINT_IN_TIME_SERVICES = ["screener", "evidence", "backtest", "btstRecord", "analyze", "trades", "lab", "labOverlay", "labSectors", "timeMachine", "planLedger", "coach"].map((name) => `src/server/services/${name}.ts`);

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Engine: pure calculations. No I/O, no framework, no other layer.
    files: ["src/core/**"],
    rules: { "no-restricted-imports": ["error", { patterns: CORE_LAYER }] },
  },
  {
    // API contract: types shared by both ends; may only reference engine types.
    files: ["src/contracts/**"],
    rules: layer("src/contracts holds API types only: import only from @/core.", ["@/server/*", "@/client/*", "@/chart/*", ...NO_UI]),
  },
  {
    // Backend: providers (data sources, caches, db) and services (orchestration).
    files: ["src/server/**"],
    rules: { "no-restricted-imports": ["error", { patterns: SERVER_LAYER }] },
  },
  {
    // Point in time: these read reference data only through asOf. (A later block's options
    // replace an earlier one's for the same rule, so each repeats its layer's patterns.)
    files: POINT_IN_TIME_ENGINE,
    rules: { "no-restricted-imports": ["error", { patterns: [...CORE_LAYER, ...REFERENCE_READS] }] },
  },
  {
    files: POINT_IN_TIME_SERVICES,
    rules: { "no-restricted-imports": ["error", { patterns: [...SERVER_LAYER, ...REFERENCE_READS] }] },
  },
  {
    // Route handlers stay thin: parse → service → JSON.
    files: ["src/app/api/**"],
    rules: layer("API routes call services in @/server; they must not import frontend code.", ["@/client/*", "@/chart/*", "@/terminal/*", "@/components/*"]),
  },
  {
    // Frontend data layer: talks to /api through @/client/api, never to the backend directly.
    files: ["src/client/**"],
    rules: layer("src/client talks to the backend over HTTP only (src/client/api.ts), and holds no UI.", ["@/server/*", "@/app/*", "@/terminal/*", "@/components/*", "@/chart/*"]),
  },
  {
    // Chart renderer: canvas drawing on engine output; no data fetching, no React UI.
    files: ["src/chart/**"],
    rules: layer("src/chart is the canvas renderer: import only from @/core and @/chart.", ["@/server/*", "@/client/*", "@/contracts/*", ...NO_UI]),
  },
  {
    // UI: never reaches the backend except through @/client.
    files: ["src/terminal/**", "src/components/**"],
    rules: layer("UI must load data through @/client, not import the backend or route files.", ["@/server/*", "@/app/*"]),
  },
  {
    // Playwright fixtures call `use(...)`, which isn't a React hook.
    files: ["e2e/**"],
    rules: { "react-hooks/rules-of-hooks": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Claude Code worktrees (parallel copies of the repo), not this project's code.
    ".claude/**",
    // Generated reports and the end-to-end tests' scratch directory.
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "blob-report/**",
    "e2e/.run/**",
  ]),
]);

export default eslintConfig;
