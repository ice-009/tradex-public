#!/usr/bin/env node
// `npm run lab -- <args>`: bundles scripts/lab.ts with the app's `@/` paths
// (as perf/run.mjs does) and runs it, so the CLI uses exactly the server's code.
// `server-only` (which throws outside a Next.js server build) is replaced by
// the same stand-in the unit tests use; npm packages stay external. HUB_URL
// and HUB_KEY come from the environment, or from .env when it exists.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
// Inside the checkout, so the bundle's bare imports resolve from its node_modules.
const outfile = path.join(root, "node_modules", ".cache", "tradex-lab", "lab.mjs");

await esbuild.build({
  entryPoints: [path.join(root, "scripts", "lab.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "error",
  packages: "external",
  // Bundled ESM still has CommonJS dependencies that call require().
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  plugins: [
    {
      name: "app-alias",
      setup(build) {
        build.onResolve({ filter: /^server-only$/ }, () => ({ path: path.join(src, "test", "server-only.ts") }));
        build.onResolve({ filter: /^@\// }, (args) => build.resolve(`./${args.path.slice(2)}`, { resolveDir: src, kind: args.kind }));
      },
    },
  ],
});

const env = path.join(root, ".env");
const nodeArgs = [...(existsSync(env) ? [`--env-file=${env}`] : []), outfile, ...process.argv.slice(2)];
// Run from the checkout: .cache/ (stored bars, the trial record) is the server's.
const result = spawnSync(process.execPath, nodeArgs, { stdio: "inherit", cwd: root });
process.exit(result.status ?? 1);
