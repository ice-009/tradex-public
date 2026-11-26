# Contributing to Tradex

Please read and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Thanks for helping. Bug reports, data-source adapters, screens, indicators and UI fixes are all welcome.

## Setup

See [Getting started](README.md#getting-started) in the README. In short:

```bash
npm install
cp .env.example .env    # set NEXTAUTH_SECRET at least
npm run db:setup
npm run dev
```

## Before you open a pull request

```bash
npm run check   # typecheck + lint (including the layer rules) + unit tests
npm run build
npm run e2e     # end-to-end tests against the build (see below)
```

All must pass. CI runs the same commands, plus:

- **Coverage:** `npm run test:coverage`. The PR's CI run shows a table per layer in its job summary (the HTML report is the `coverage` artifact). There's no gate for the app as a whole, but `src/core` has a floor in `vitest.config.ts`; raise it when you add tests, never lower it to make a PR pass.
- **Dependency audit:** `npm audit --omit=dev --audit-level=high` (runtime dependencies only).
- **CodeQL** code scanning on every PR and weekly. Dependabot opens weekly PRs for npm packages and GitHub Actions.

### End-to-end tests

`e2e/` holds Playwright tests that run the production build against a **stub Market Data Hub** (`e2e/stub-hub.mjs`): fixed fixture data (a seeded random walk per symbol, five years of daily bars ending on Friday 2026-11-13), so every run sees the same prices. The browser's clock is frozen at the following Saturday noon IST.

```bash
npm run build
npm run e2e              # starts the stub hub (port 8797) and the app (port 3107), then runs the tests
```

The app runs in a throwaway directory (`e2e/.run`) with its own `dev.db` and `.cache`, so your own account and caches are never touched. `E2E_PORT` and `STUB_HUB_PORT` change the ports.

CI's `docker` job runs the real stack instead: `docker compose up` with no `.env` and no broker keys, so the hub is in end-of-day mode, with `e2e/nse-stub.mjs` standing in for NSE (`e2e/compose.no-broker.yaml`). `e2e/no-broker-smoke.mjs` then checks charts, quotes, the screener, a backtest and the plan through Tradex's API. To run it yourself: `COMPOSE_FILE=compose.yaml:e2e/compose.no-broker.yaml docker compose up -d --build`, then `SHORT_HISTORY=1 node e2e/no-broker-smoke.mjs http://127.0.0.1:3000`.

- `e2e/smoke.spec.ts`: sign in, open a chart, run a screen, run a backtest, open the plan.
- `e2e/chart.visual.spec.ts`: screenshots of the chart canvas (candles, the trade-plan overlay, drawings) compared with the baselines in `e2e/__screenshots__`, with a small tolerance for anti-aliasing.

The baselines are rendered on Linux in the Playwright container CI uses, so the screenshot tests are skipped on macOS and Windows. To run them locally, or to re-render the baselines after an intended change to the chart, use Docker:

```bash
npm run e2e:docker                                                         # everything, as CI runs it
npm run e2e:docker -- e2e/chart.visual.spec.ts --update-snapshots=all      # re-render the baselines
```

Without Docker, add the label `update-screenshots` to your PR: the **Re-render chart screenshots** workflow renders them in CI and uploads them as the `e2e-screenshots` artifact. A failed CI run also uploads what it rendered under the same name. Look at the images before you commit them.

### Performance budgets

`npm run perf` times the hot paths on fixed synthetic data (seeded, so every run sees the same bars) and checks them against their budgets:

| Metric | What it times | Budget |
|---|---|---|
| `chart.firstPaint.2k` | Open a chart on 2,000 daily bars (EMA, SMA, RSI pane, auto patterns) to its first frame | 300 ms |
| `chart.panZoom.50k.p95` | 95th-percentile frame while panning and zooming across 50,000 5-minute bars | 8 ms |
| `screener.scan.fno` | A full screener pass over the F&O list (220 stocks × 5 years, with live bars) | 2 s |
| `backtest.5y.fno` | Signal scan + portfolio simulation, every screen, 5 years × the F&O list | 10 s |
| `lab.5y.fno.momentum-12-1`, `lab.5y.fno.volatility-20d` | A Signal Lab run of a built-in signal (values, quintiles, 1–21 session returns, splits, decay, turnover), 5 years × the F&O list | 3 s |

The chart runs in Node on a no-op canvas, so it measures the engine's own work per frame (layout, scaling, indicators, building paths), not the browser's rasterising; the 8 ms frame budget leaves the other half of a 60 Hz frame for that.

The **Performance** workflow (`.github/workflows/perf.yml`) runs the same benchmarks on every pull request against its merge base, on the same runner, and fails on a slowdown of more than 20% (and at least 0.25 ms) or on any metric over its budget. To compare against another checkout locally: `node perf/run.mjs --base ../tradex-main`.

## How the code is organised

Read [ARCHITECTURE.md](ARCHITECTURE.md) first. The short version: each folder is a layer with one job, and ESLint rejects imports that cross layers the wrong way.

| You're adding… | Put it in… |
|---|---|
| An indicator, pattern, screen, scoring rule, backtest logic | `src/core` (pure functions, unit-tested, no I/O) |
| New market data (another dataset, another broker) | the [Market Data Hub](https://github.com/ice-009/market-data-hub) first, then a typed method in `src/server/providers/hub/client.ts` and a provider that caches it |
| An API endpoint | type in `src/contracts/api.ts` → service in `src/server/services` → thin route in `src/app/api` → fetcher in `src/client/api.ts` |
| A panel or control | `src/terminal`, reading data through `src/client` |

## Guidelines

- **Tests:**
  - Keep `src/core` pure and add a `*.test.ts` next to what you change.
  - Engine code is tested with fake sources and a fake clock, never the network.
- **Market data comes from the hub only:**
  - Never call a broker or NSE from Tradex: add the data to the hub and read it through `src/server/providers/hub/client.ts`. `src/hubOnly.test.ts` fails otherwise.
  - The hub keeps the broker's request budget for every app on it; pace background work with `budgetFor` (`src/server/providers/hub/budget.ts`).
- **Styling:**
  - Use the design tokens in `src/app/globals.css` (`--surface-*`, `--text-*`, `--accent`, `--pos`, `--neg`, spacing `--sp-*`, type `--fs-*`).
  - Don't hard-code colours.
- **Screens and scoring:**
  - Cite where a rule comes from (`sources` on each screen).
  - Say what the backtest shows, including the out-of-sample split. A rule that only looks good in-sample isn't an improvement.
- **Git:**
  - Never commit `.env`, `*.db` or anything under `.cache/`; they're git-ignored for a reason.
  - One topic per pull request, and describe how you tested it.

## Reporting a security problem

Please don't open a public issue. See [SECURITY.md](SECURITY.md).
