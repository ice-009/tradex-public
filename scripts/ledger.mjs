#!/usr/bin/env node
// `npm run ledger -- <command>`: bundles scripts/ledger.ts with the app's `@/`
// paths (as scripts/lab.mjs does) and runs it, so the CLI checks the ledger
// with exactly the server's code. `server-only` is replaced by the unit tests'
// stand-in; npm packages stay external.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const outfile = path.join(root, "node_modules", ".cache", "tradex-ledger", "ledger.mjs");

await esbuild.build({
  entryPoints: [path.join(root, "scripts", "ledger.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "error",
  packages: "external",
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

// Run from the checkout: .cache/market.db is the server's (MARKET_DB_PATH overrides it).
const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit", cwd: root });
process.exit(result.status ?? 1);
