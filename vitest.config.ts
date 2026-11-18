import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests for the pure layers (src/core, src/contracts). They need no
// server, browser or network: `npm test`. End-to-end tests live in e2e/ (Playwright).
//
// `npm run test:coverage` adds a coverage report (coverage/). There is no gate
// for the app as a whole, only a floor for the engine (src/core): CI fails if
// its coverage drops below these numbers. Raise them as coverage grows.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src"), "server-only": path.resolve(__dirname, "src/test/server-only.ts") } },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.ts", "src/test/**", "src/types/**", "src/generated/**"],
      reporter: ["text-summary", "json-summary", "html"],
      reportOnFailure: true,
      thresholds: {
        "src/core/**": { statements: 72, branches: 82, functions: 62, lines: 72 },
      },
    },
  },
});
