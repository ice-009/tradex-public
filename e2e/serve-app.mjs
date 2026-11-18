// Starts the production build (`npm run build` first) for the end-to-end tests,
// pointed at the stub hub (e2e/stub-hub.mjs), in a throwaway working directory
// (e2e/.run): Tradex keeps its SQLite accounts database (./dev.db), its caches
// (.cache/) and its market database relative to the working directory, so the
// tests never touch your own dev.db or .cache, and every run starts empty.
//
// Usage: node e2e/serve-app.mjs  (E2E_PORT, default 3107; STUB_HUB_PORT, default 8797)

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN = path.join(ROOT, "e2e", ".run");
const PORT = process.env.E2E_PORT || "3107";
const HUB_PORT = process.env.STUB_HUB_PORT || "8797";
const bin = (name) => path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);

if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
  console.error("No production build: run `npm run build` first.");
  process.exit(1);
}

rmSync(RUN, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });
// Symbols and the index lists are read from ./data.
symlinkSync(path.join(ROOT, "data"), path.join(RUN, "data"), "dir");

const env = {
  ...process.env,
  NODE_ENV: "production",
  DATABASE_URL: `file:${path.join(RUN, "dev.db")}`,
  NEXTAUTH_SECRET: "e2e-only-not-a-secret",
  NEXTAUTH_URL: `http://127.0.0.1:${PORT}`,
  HUB_URL: `http://127.0.0.1:${HUB_PORT}`,
  HUB_KEY: process.env.STUB_HUB_KEY || "mdh_e2e",
  HUB_TIMEOUT_MS: "10000",
  MARKET_DB_PATH: path.join(RUN, ".cache", "market.db"),
  DATA_SOURCES: "",
  NEXT_TELEMETRY_DISABLED: "1",
};

const push = spawnSync(bin("prisma"), ["db", "push"], { cwd: ROOT, env, stdio: "inherit" });
if (push.status !== 0) process.exit(push.status ?? 1);

const server = spawn(bin("next"), ["start", ROOT, "--port", PORT, "--hostname", "127.0.0.1"], { cwd: RUN, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
