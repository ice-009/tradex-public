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
```

Both must pass. CI runs the same commands.

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
