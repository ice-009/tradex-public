<div align="center">

# Tradex

**Shortlist stock-futures trades on NSE: charts, screeners, setup scores and backtests in one open-source terminal.**

[![CI](https://github.com/ice-009/tradex-public/actions/workflows/ci.yml/badge.svg)](https://github.com/ice-009/tradex-public/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520.9-339933?logo=node.js&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)

[Features](#features) · [Getting started](#getting-started) · [Architecture](#architecture) · [Roadmap](#roadmap) · [Contributing](#contributing)

</div>

**An open-source trading terminal for Indian (NSE) stock futures, built to shortlist trades.** Tradex combines TradingView-style charts with screeners, a 100-point setup score, a portfolio backtester and live prices, so you can narrow 200+ F&O stocks down to the one or two worth taking. You place orders in your broker's app; Tradex never sends one.

![Terminal: chart with the trade plan, screener and setup card](docs/screenshots/terminal.png)

> **Not investment advice.** Tradex is a research tool. Its screens, scores and backtests describe what rules did on past data; they don't predict what a stock will do. Check every idea yourself and trade at your own risk.

## Features

**Charts**
- A fast canvas chart engine: candles, hollow candles, Heikin-Ashi, OHLC bars, line and area.
- Indicators, including Smart Money Concepts, plus automatic chart patterns (triangles, rectangles, bull flags, double bottoms, VCP, cup-and-handle) with support/resistance zones.
- Drawing tools, and multi-chart layouts with linked symbols and crosshairs.
- Designed for iPad and 13–14" laptops; installable as a home-screen app.

**Daily trade plan** (the bottom panel's first tab)
- **Which trades to take today, how many lots, and how to get in and out.** Only setups that held up in a 5-year replay of the F&O list *in the current market* are used: NIFTY above or below its 200-day average decides which. A setup qualifies when it made money, net of costs, in both the first 60% and the last 40% of its signals with a t-stat over 2.
- Ideas are ranked by that tested expected R, one per stock, sized at your risk % of capital in whole futures lots under a leverage cap, and capped at your free slots (default 5 open trades). Lots that would risk more than your budget are shown as "too big for your risk", not hidden.
- Each idea says what to do ("buy 3:15–3:25 PM near ₹X", "buy-stop at ₹X next session", "sell at tomorrow's open") and shows its evidence: "5y +0.22R/trade · last 12m +0.13R · live 4/6".
- **Open trades and a journal:** press "I took it" with your fill; each open trade shows its session of the hold, R at the live price, and today's action (sell at the open, stop or target hit, time exit due, trailing level). Closed trades show realised R and your slippage against the plan.

**Exploring the screens**
- 17 screens in four horizons: **BTST** (overnight), **Swing** (3–10 sessions), **15–30 days** and **Results** (post-earnings drift and gaps). Each cites its sources.
- Screens with no edge in the 5-year test are hidden by default ("Show all screens" brings them back); each is labelled *works in any market*, *uptrends only* or *no edge in 5-year test*.
- Every match comes with a **trade plan** (entry, stop, target, exit rule) and a **100-point setup score** across eight factors: trend, relative strength, accumulation, pattern, reward:risk, stop distance, extension and track record. Penalties apply for results inside the holding period, gaps and falling days.
- **Live during the session:** setups are re-checked against fresh quotes every ~30–60 s (paced from the remaining API budget, with socket ticks laid over the top). Setups that appear after the opening scan get a **NEW** badge, and the **N new** button sorts them to the top.
- **Market context:** a regime badge (NIFTY vs its 50/200-day averages plus breadth), sector strength and the NSE **F&O ban list** all feed the score. Relative strength is volatility-adjusted (6 and 12 months) with credit for trading near the 52-week high.
- **Track record** shows how often each screen's past signals hit target before stop. **Compare** ranks a whole watchlist side by side.
- Live watchlists (every F&O stock, grouped by sector), market movers, sector strength, an NSE results calendar and price alerts.
- A **Day High / Low** scanner for F&O cash and near-month futures.
- A futures **order ticket helper**: the right contract, basis-adjusted levels, lots sized from your max loss, and GTT OCO prices to copy into your broker.

**Backtesting**
- A portfolio backtest of any combination of screens. It uses risk-% sizing, position limits and full Indian futures costs: brokerage, STT, exchange and SEBI fees, stamp duty, GST and slippage.
- Results include an equity curve against NIFTY with drawdown, a monthly heatmap, a trade list and an **in-sample vs out-of-sample** split, with plain warnings when a result isn't robust.

![Backtest: equity vs NIFTY, drawdown and out-of-sample check](docs/screenshots/backtest.png)

**Data**
- All market data comes from a [Market Data Hub](https://github.com/ice-009/market-data-hub): a separate service that owns the one broker connection, its request budget and NSE's daily files, and serves every app on it. Tradex makes no broker or exchange requests itself.
- Charts from 1 minute to monthly; up to 5 years of daily bars (with NSE delivery %) for the screener, backtests and the daily plan; stock futures (`SBIN26NOVFUT`) charted and quoted like any symbol.
- Live prices stream from the hub, with polling as the fallback and a watchdog that reconnects silent feeds.
- Without a hub, Tradex still runs on clearly labelled sample data and says **Connect a Market Data Hub**.

![Compare: a watchlist ranked by setup score](docs/screenshots/compare.png)

## Getting started

**Requirements:** Node.js 20.9 or newer, and npm.

```bash
git clone https://github.com/ice-009/tradex-public.git
cd tradex-public
npm install                 # also generates the Prisma client
cp .env.example .env        # then set NEXTAUTH_SECRET (openssl rand -base64 32), HUB_URL and HUB_KEY
npm run db:setup            # creates the local SQLite database
npm run dev
```

> **Updating an existing install?** Run `npm install` and then `npm run db:setup` again after pulling. The daily plan's trade journal adds a `Trade` table to `dev.db`; `db:setup` (`prisma db push`) adds it without touching your account. Restart `npm run dev` afterwards.

Open http://localhost:3000, create a local account (stored only in your `dev.db`) and sign in.

### Connect a Market Data Hub (required for real data)

Tradex gets all its market data from a [Market Data Hub](https://github.com/ice-009/market-data-hub). The hub logs in to the broker (Fyers today), keeps its request budget and live socket, downloads NSE's daily files, and serves several apps — Tradex, a backtester, notebooks — over HTTP with an API key, so they never trip the broker's rate limits together. Tradex only needs its URL and a key.

1. Run a hub: see its [README](https://github.com/ice-009/market-data-hub#readme) (a Mac, a small VM or Docker, optionally behind a Cloudflare Tunnel). For a full 5-year daily history, run its backfill once: `npm run hub -- data backfill --tf 1d --years 5`.
2. On the hub, create a key for Tradex. Read scopes are enough; Tradex never needs admin:
   ```bash
   npm run hub -- keys create tradex --scopes history,live,fo
   ```
3. In Tradex's `.env`, set:
   ```bash
   HUB_URL=http://127.0.0.1:8787      # or your hub's HTTPS address
   HUB_KEY=mdh_…
   ```
4. Restart Tradex. The top bar's meter reads **Hub** with the hub's broker budget; click it for the read-only **Market data** panel: the hub's health and how fresh each dataset is.

Without `HUB_URL` and `HUB_KEY` (or while the hub is unreachable) Tradex shows a **Connect a Market Data Hub** banner, charts draw labelled sample data, and the screener, backtests and plan wait for real data.

**What comes from the hub:**

| Tradex feature | Hub endpoint |
|---|---|
| Charts (1m … monthly; 3m from 1m, 10m/30m/2h/4h resampled) | `GET /v1/candles` |
| Watchlist, order ticket and screener quotes | `GET /v1/quotes` |
| Live prices | `GET /v1/stream` (Server-Sent Events) |
| Screener, backtests, plan evidence: up to 5 years of daily bars with delivery % | `GET /v1/candles/batch` |
| OI buildup next to each F&O setup | `GET /v1/fo/oi/day` |
| Point-in-time F&O list for backtests | `GET /v1/fo/members?from&to` |
| Futures contract, basis and lot in the order ticket; Day High/Low futures | `GET /v1/fo/contracts`, futures tickers like `SBIN26NOVFUT` |
| Lot sizes, F&O ban list, results calendar, F&O list | `/v1/lots`, `/v1/fo/ban`, `/v1/results-calendar`, `/v1/universe/fno` |
| Health, broker budget | `GET /v1/status` |

> **Upgrading from a version that talked to Fyers itself?** The Fyers login (`FYERS_*`), the **Download F&O history** and **F&O bhavcopy** buttons, and `DATA_SOURCES` are gone: the hub does all of that now. Remove the `FYERS_*` lines from `.env` and set `HUB_URL`/`HUB_KEY`. Candles already in `.cache/market.db` are still used as a chart cache, and the hub can import them (`npm run hub -- data import-tradex`). The screener's daily bars are read again from the hub once, for the full 5 years.

## Architecture

Tradex is a Next.js 16 app (React 19, TypeScript). The server side runs in the same process: API routes, a disk cache and one connection to the Market Data Hub. The code is split into layers, and ESLint enforces the boundaries, so a wrong import fails the build.

```
            ┌──────────────────────────── browser ────────────────────────────┐
            │  src/terminal   React UI + UI state (store, prefs, layouts)     │
            │       │                     │                                   │
            │       ▼                     ▼                                   │
            │  src/client     data feeds  src/chart   canvas chart renderer   │
            │  (api.ts = the only fetch)                                      │
            └───────┼─────────────────────────────────────────────────────────┘
                    │  HTTP + Server-Sent Events, shapes in src/contracts/api.ts
            ┌───────▼──────────────────────── server ─────────────────────────┐
            │  src/app/api     thin route handlers: parse → service → JSON    │
            │       ▼                                                         │
            │  src/server/services    one use case per file                   │
            │       ▼                                                         │
            │  src/server/data        data engine: hub + sample, cache,       │
            │                         live market stream                      │
            │       ▼                                                         │
            │  src/server/providers   Market Data Hub client, daily bars,     │
            │                         reference and F&O data, caches          │
            └───────┼─────────────────────────────────────────────────────────┘
                    ▼  HTTP + SSE, API key
            Market Data Hub   (broker, NSE files — github.com/ice-009/market-data-hub)

            src/core   pure calculation engine — used by both sides
```

| Layer | Folder | What's in it |
|---|---|---|
| Engine | `src/core` | Indicators, patterns, screens, scoring, backtester, tick/futures maths, IST session rules, budget pacing. Pure functions, no I/O. |
| Contracts | `src/contracts/api.ts` | The JSON shape of every API response, shared by both ends. |
| Data engine | `src/server/data` | The `hub` and `sample` `DataSource`s, the `DataEngine` (fallback to labelled sample data, rests a failing hub, quote cache, incremental history in a local SQLite candle cache) and the `MarketStream` (one live price pipeline: the hub's stream or polling, with a watchdog). |
| Providers | `src/server/providers` | The Market Data Hub client, and what's built on it: the daily-bar store, lot sizes, ban list, results calendar, OI and F&O membership, futures contracts, universes. |
| Services and routes | `src/server/services`, `src/app/api` | One use case per service; routes only parse, call and return. |
| Client data | `src/client` | Typed API fetchers and feeds (market data, screener, high/low, lots, futures, the hub's health). |
| Renderer | `src/chart` | The canvas chart: drawing, annotations, theme. |
| UI | `src/terminal` | Panels, dialogs, layouts and UI state. |

**How data flows:**
1. A chart asks `/api/chart`. The chart service asks the data engine, which asks the hub (or reads its own cache of the hub's candles).
2. The screener, backtests and plan read one store of daily bars, filled from the hub's batch candles.
3. Live prices go through one Server-Sent Events stream: the hub's stream, relayed by the `MarketStream`.

`src/hubOnly.test.ts` fails the build if code under `src/` mentions Fyers or NSE's download hosts, or if anything on the server but the hub client calls `fetch()`.

**Broker rate limits** are the hub's job: it counts every broker call for every app connected to it. Tradex reads the hub's counters and paces its background work (the screener's live quotes, the Day High/Low sweep) to its share of the day; a meter in the top bar shows the hub's usage.

**[ARCHITECTURE.md](ARCHITECTURE.md)** has the details: where to add things, the data engine, the hub endpoints, the daily-bar store and the backtester's fill rules, costs and limitations.

## Project structure

```
src/
  app/            Next.js pages and API routes (thin)
  chart/          canvas chart renderer
  client/         browser data layer (api.ts + feeds)
  contracts/      API types shared by server and browser
  core/           pure engine: indicators, screener, backtest, market maths
  server/         data engine, Market Data Hub client and providers, services, auth
  terminal/       React UI
data/             index lists and a fallback F&O list (NSE snapshots)
docs/             screenshots and research notes
prisma/           database schema (users, sessions, trade journal)
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server on http://localhost:3000 |
| `npm run build` / `npm start` | Production build / serve it |
| `npm run check` | Typecheck + lint (including layer rules) + unit tests |
| `npm test` | Unit tests (Vitest) |
| `npm run db:setup` | Create or update the local SQLite database from the schema |

## Configuration

All settings live in `.env`. [`.env.example`](.env.example) documents each one.

| Variable | Purpose |
|---|---|
| `NEXTAUTH_SECRET`, `NEXTAUTH_URL` | Sign-in sessions (required) |
| `DATABASE_URL` | SQLite file (default `file:./dev.db`) |
| `HUB_URL`, `HUB_KEY` | The [Market Data Hub](https://github.com/ice-009/market-data-hub) all market data comes from (required for real data; `HUB_TIMEOUT_MS` sets the request timeout) |
| `MARKET_DB_PATH` | Where the local candle cache lives (default `.cache/market.db`) |

Runtime data is written to `.cache/`, which is git-ignored: the candle cache `market.db`, the screener's daily bars, the plan's evidence and the hub's last lot sizes.

## Roadmap

Tradex is young. These are the next things that would help most, and good places to contribute:

- [ ] **Backtest comparisons.** "Enter at close" vs "wait for strength", and parameter sweeps with walk-forward validation.
- [ ] **Futures-native data.** Continuous futures series with roll handling instead of cash prices as a proxy.
- [ ] **Alerts that run without the browser open** (server-side, with push notifications).
- [ ] **More brokers** — in the [Market Data Hub](https://github.com/ice-009/market-data-hub), so every app on it gets them.
- [ ] A light theme, and more indicators and drawing tools.

Have an idea? [Open an issue](https://github.com/ice-009/tradex-public/issues/new/choose).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the layer rules and what a good pull request includes. Please report security issues privately ([SECURITY.md](SECURITY.md)).

## Acknowledgements

- Screens, patterns and scoring cite their sources in code (`sources` on each screen) and in [docs/research](docs/research).
- Ideas from the MIT-licensed [Day Trader skill](https://github.com/jakeschincariol/day-trader-skill).
- Market data through the [Market Data Hub](https://github.com/ice-009/market-data-hub), from the broker's API and NSE's public files (bhavcopy, F&O bhavcopy, lot sizes, ban list, event calendar). Use of NSE data is subject to [NSE's terms](https://www.nseindia.com/).

## License

[MIT](LICENSE)
