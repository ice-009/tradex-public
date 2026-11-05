import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests for the pure layers (src/core, src/contracts). They need no
// server, browser or network: `npm test`.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
