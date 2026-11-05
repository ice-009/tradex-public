import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Layer boundaries (see ARCHITECTURE.md). Each layer may import only from the
// layers listed for it; anything else is a lint error.
const layer = (message, ...groups) => ({
  "no-restricted-imports": ["error", { patterns: groups.map((group) => ({ group, message })) }],
});
const NO_UI = ["@/terminal/*", "@/components/*", "@/app/*", "react", "react-dom", "next", "next/*"];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Engine: pure calculations. No I/O, no framework, no other layer.
    files: ["src/core/**"],
    rules: layer("src/core is the pure engine: import only from @/core.", ["@/server/*", "@/client/*", "@/contracts/*", "@/chart/*", ...NO_UI, "node:*", "fs", "path"]),
  },
  {
    // API contract: types shared by both ends; may only reference engine types.
    files: ["src/contracts/**"],
    rules: layer("src/contracts holds API types only: import only from @/core.", ["@/server/*", "@/client/*", "@/chart/*", ...NO_UI]),
  },
  {
    // Backend: providers (data sources, caches, db) and services (orchestration).
    files: ["src/server/**"],
    rules: layer("src/server must not import frontend code.", ["@/client/*", "@/chart/*", "@/terminal/*", "@/components/*", "@/app/*", "react", "react-dom"]),
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
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Claude Code worktrees (parallel copies of the repo), not this project's code.
    ".claude/**",
  ]),
]);

export default eslintConfig;
