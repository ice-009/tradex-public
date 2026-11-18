import { execSync } from "child_process";
import path from "path";
import type { NextConfig } from "next";

/**
 * The commit this build is made from, for run stamps (src/core/repro/stamp.ts):
 * TRADEX_COMMIT when set (builds without git, e.g. Docker), else git HEAD with
 * "-dirty" when tracked files have uncommitted changes, else "dev".
 */
function buildCommit(): string {
  if (process.env.TRADEX_COMMIT) return process.env.TRADEX_COMMIT;
  const run = (args: string) => execSync(`git ${args}`, { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  try {
    const head = run("rev-parse HEAD");
    return run("status --porcelain --untracked-files=no") ? `${head}-dirty` : head;
  } catch {
    return "dev";
  }
}

const nextConfig: NextConfig = {
  // Inlined into the server code at build time (and when `next dev` starts).
  env: { TRADEX_COMMIT: buildCommit() },
  // better-sqlite3 is a native Node addon: keep it out of the Server Components
  // bundle and let it load via native require.
  serverExternalPackages: ["better-sqlite3"],
  turbopack: {
    root: path.join(__dirname),
  },
  experimental: {
    // Don't preload every route's module graph into memory when the dev
    // server starts — reduces the initial memory spike during `next dev`.
    preloadEntriesOnStart: false,
    // Only takes effect on the Webpack path (`next dev --webpack` /
    // `next build --webpack`); trades a little compile time for lower peak
    // memory. Harmless under Turbopack.
    webpackMemoryOptimizations: true,
  },
};

export default nextConfig;
