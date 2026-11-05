# Contributing to Tradex

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
```

Both must pass. CI runs the same commands.

## How the code is organised

Read [ARCHITECTURE.md](ARCHITECTURE.md) first. The short version: each folder is a layer with one job, and ESLint rejects imports that cross layers the wrong way.

| You're adding… | Put it in… |
|---|---|
| An indicator, pattern, screen, scoring rule, backtest logic | `src/core` (pure functions, unit-tested, no I/O) |
| A market-data source (another broker, a vendor API) | `src/server/data/sources/` (implement `DataSource`) |
| A reference-data file (lot sizes, calendars) | a provider in `src/server/providers` + its parser in `src/core/parsers` |
| An API endpoint | type in `src/contracts/api.ts` → service in `src/server/services` → thin route in `src/app/api` → fetcher in `src/client/api.ts` |
| A panel or control | `src/terminal`, reading data through `src/client` |

## Guidelines

- **Tests:**
  - Keep `src/core` pure and add a `*.test.ts` next to what you change.
  - Engine code is tested with fake sources and a fake clock, never the network.
- **Broker API budget:**
  - Never call the broker directly from a new place: go through the data engine, so the request budget (`src/server/providers/fyers/budget.ts`) still covers every call.
  - Fyers blocks an account for the day after repeated rate-limit breaches.
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
