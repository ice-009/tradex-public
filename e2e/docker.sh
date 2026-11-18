#!/usr/bin/env bash
# Runs the end-to-end tests in the Playwright container CI uses, so the chart
# screenshots match the Linux baselines in e2e/__screenshots__.
#
#   npm run e2e:docker                                   # all tests
#   npm run e2e:docker -- e2e/chart.visual.spec.ts --update-snapshots=all   # re-render the baselines
#
# node_modules and .next live in container volumes (Linux binaries), so your
# own install and build are left alone.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package-lock.json').packages['node_modules/@playwright/test'].version")
exec docker run --rm -t --ipc=host \
  -v "$PWD":/work -v /work/node_modules -v /work/.next -w /work \
  -e CI=1 -e NEXTAUTH_SECRET=e2e -e NEXTAUTH_URL=http://localhost:3000 -e DATABASE_URL=file:./dev.db -e NEXT_TELEMETRY_DISABLED=1 \
  "mcr.microsoft.com/playwright:v${VERSION}-noble" \
  bash -c 'npm ci --no-audit --no-fund && npm run build && npx playwright test "$@"' bash "$@"
