# Tradex architecture

Tradex is split into layers. Each one has one job and may import only from the
layers below it. ESLint enforces this (`no-restricted-imports` in
`eslint.config.mjs`), so a wrong import fails `npm run lint`.

```
            ┌──────────────────────────── browser ────────────────────────────┐
            │  src/terminal   React UI + UI state (store, prefs, layouts)     │
            │       │                     │                                   │
            │       ▼                     ▼                                   │
            │  src/client     data feeds  src/chart   canvas chart renderer   │
            │  (api.ts = the only fetch)                                      │
            └───────┼─────────────────────────────────────────────────────────┘
                    │  HTTP, shapes in src/contracts/api.ts
            ┌───────▼──────────────────────── server ─────────────────────────┐
            │  src/app/api     thin route handlers: parse → service → JSON    │
            │       ▼                                                         │
            │  src/server/services    orchestration (screener, chart, …)      │
            │       ▼                                                         │
            │  src/server/providers   the Market Data Hub client, caches, db  │
            └───────┼─────────────────────────────────────────────────────────┘
                    ▼
            src/core   pure calculation engine — used by both sides
```

| Layer | Folder | What goes here | May import |
|---|---|---|---|
| Engine | `src/core` | Indicators, patterns, screens, scoring, backtest, tick and futures maths, IST session rules, pacing against the broker budget. Pure functions: no I/O, no React, no Next. | `@/core` |
| Contracts | `src/contracts/api.ts` | The JSON body each `/api` route returns. Types only. | `@/core` (types) |
| Data engine | `src/server/data` | One pipeline for market data whatever the source: source adapters, routing with fallback, caches, and the live price stream. See below. | `@/core`, `@/contracts`, `@/server` |
| Providers | `src/server/providers` | The Market Data Hub client (`hub/`) and what is built on it: the daily-bar store (`dailyBars`, `dailyStore`), reference data (`reference`: lots, ban list, results calendar), F&O data (`foData`: OI, membership), futures contracts (`futures`), universes; plus symbols, sample data and the trade-record database. | same |
| Services | `src/server/services` | One use case per file: load data from providers, run the engine, return a contract type. | same |
| Routes | `src/app/api/**/route.ts` | `export const GET = authed(...)`: read params, call one service, `NextResponse.json`. No logic. | `@/server`, `@/contracts` |
| Client data | `src/client` | `api.ts` (typed fetchers, the only place that knows URLs) plus feeds: `marketData` (history, quotes, live ticks), `screenerFeed`, `highLowFeed`, `lotsFeed`, `futuresFeed`, `usageFeed` (the hub's health and budget). | `@/core`, `@/contracts`, `@/client` |
| Renderer | `src/chart` | Canvas chart engine, drawings, annotations, theme. Draws engine output; fetches nothing. | `@/core`, `@/chart` |
| UI | `src/terminal`, `src/components` | React components and UI state (`store`, `uiPrefs`, `presets`, `ideaActions`). | everything except `@/server` and `@/app` |

## Where to add things

- **A new indicator or pattern:** `src/core/indicators`. Register it in `indicators.ts`; the chart draws it through `annotate()`.
- **A new screen:** add a `ScreenDef` to `SCREENS` in `src/core/screener/screens.ts`. The service, API and UI pick it up with no other changes.
- **New market data** (another dataset, another exchange): add it to the [Market Data Hub](https://github.com/ice-009/market-data-hub), then a typed method on `src/server/providers/hub/client.ts` and a provider that caches it. Tradex itself never calls a broker or an exchange.
- **A new endpoint:**
  1. Add the response type to `src/contracts/api.ts`.
  2. Add the service in `src/server/services`.
  3. Add a three-line route in `src/app/api`.
  4. Add a fetcher to `src/client/api.ts`.
  5. Add a feed in `src/client` if the endpoint is polled or shared.
- **A new panel:** `src/terminal`. Read data through a `src/client` feed or fetcher, never `fetch("/api/...")` directly.

## Conventions

- **Time:** use `src/core/market/session.ts` for IST days, market hours and day keys (UTC midnight of the IST date). Don't write a new `+ 5.5h` helper.
- **Futures:** contract names, expiry and lot maths live in `src/core/market/futures.ts`. Prices are rounded with `src/core/market/ticks.ts`.
- **Auth:** every route goes through `authed()` in `src/server/http.ts`.
- **Tests:** engine tests sit next to the code as `*.test.ts` (vitest). They need no network or server.

```bash
npm run check   # typecheck + lint (layer rules) + unit tests
npm test        # unit tests only
```

## Market data: the Market Data Hub

Tradex fetches no market data itself. Everything — candles, quotes, live prices, daily bars with delivery %, open interest, the F&O list, lot sizes, the ban list, results dates, futures contracts — comes from a [Market Data Hub](https://github.com/ice-009/market-data-hub): a separate service that owns the one broker login, its request budget and live socket, and NSE's daily files, and serves them to every app over HTTP with an API key (`HUB_URL`, `HUB_KEY`). Tradex's key needs only the read scopes `history`, `live` and `fo`; backfills and downloads are run on the hub.

`src/hubOnly.test.ts` keeps it that way: no code under `src/` may mention Fyers or NSE's download hosts, and on the server only the hub client may call `fetch()`.

```
 Market Data Hub
   /v1/candles (1m … 1d), /v1/quotes ─────────▶ providers/hub/client.ts ─▶ sources/hub.ts ─▶ DataEngine ─▶ /api/chart, /api/quotes
   /v1/stream (one SSE) ──────────────────────▶ providers/hub/stream.ts ─▶ HubLiveFeed ──▶ MarketStream ─▶ /api/broker/stream ─▶ browser
   /v1/candles/batch (300 symbols, 5 years) ──▶ providers/dailyBars.ts (dailyStore) ─▶ screener, backtests, plan evidence, journal
   /v1/fo/oi/day ─────────────────────────────▶ providers/foData.ts ─▶ the screener's OI tag
   /v1/fo/members?from&to ────────────────────▶ providers/foData.ts ─▶ point-in-time F&O list for backtests and evidence
   /v1/fo/contracts ──────────────────────────▶ providers/futures.ts ─▶ order ticket, Day High/Low futures segment
   /v1/lots, /v1/fo/ban, /v1/results-calendar ▶ providers/reference.ts
   /v1/universe/fno ──────────────────────────▶ providers/universe.ts (index lists are snapshots in data/universe)
   /v1/status ────────────────────────────────▶ providers/hub/index.ts ─▶ budget pacing, top bar, "Market data" panel
```

Without `HUB_URL`/`HUB_KEY`, or while the hub is unreachable, charts draw clearly labelled **sample data**, a banner says **Connect a Market Data Hub** (with a link to the hub's README), the screener and backtests wait, and `/api/broker/status` reports the hub's state. There is no other fallback.

### Data engine (`src/server/data`)

| Piece | Job |
|---|---|
| `types.ts` | The `DataSource` interface: `history` (which intervals, how far back, whether downloads are cached), `quotes` and `stream`. |
| `engine.ts` | `DataEngine.history()` and `.quotes()`: try sources in order, skip ones that can't serve, fall back on failure. A source is rested for 30 s after network, auth, 5xx or rate-limit errors; an error about one symbol doesn't rest it. History is kept on disk incrementally (`market.db`, `candleDb.ts`), so a chart opened before asks only for its newest candles. Quotes are cached with per-caller freshness; a quote the source marks `delayed` (the hub's stored last price) is answered but never cached as live. |
| `stream.ts` | `MarketStream`: one live pipeline. Symbols go on the hub's stream (up to 100), highest priority first; the rest are polled through the engine and sent as identical `Tick` events marked `polled`. A watchdog restarts a silent stream. |
| `sources/hub.ts` | The `hub` source (kind `broker`). Symbols are hub tickers: `SBIN`, `NIFTY`, and stock futures like `SBIN26NOVFUT`; `NSE:SBIN-EQ`, `NSE:NIFTY50-INDEX` and `NSE:SBIN26NOVFUT` (names older layouts saved) are mapped to them, and only plain tickers are sent. Intervals: 1m, 5m, 15m, 1h and 1d as served; 3m from 1m, 10m from 5m, 30m from 15m, 2h/4h from 1h, resampled from 09:15 IST (`resampleIntraday`). Windows: 5 years daily, 1 year intraday, 30 days of 1-minute bars. A 503 that still carries stored candles is shown but not stored as complete. |
| `sources/sample.ts` | Generated candles: the offline / demo fallback, always labelled "Sample data", never used by the screener or backtests. |
| `selectSources.ts`, `index.ts` | Wiring: `hub, sample` with a hub, `sample` alone without one. Sources are built from factories, so the hub source isn't constructed without its settings. `DATA_SOURCES` from earlier versions is ignored with a warning. |
| `seriesKey.ts` | Keys of stored candle series (`NSE:SBIN-EQ:D`, `NSE:SBIN26NOVFUT:1`): unchanged from earlier versions, so their stored candles are reused. |

**What the app sees:** charts get `source` (`broker` or `sample`), `sourceId` and a `sourceReason` when sample data answered; quotes carry `source` and `delayed`; ticks carry `source` and `polled`; the top bar shows **Live**, **Delayed** or **Feed offline**, and the hub's meter.

### Hub client (`src/server/providers/hub`)

| Piece | Job |
|---|---|
| `config.ts` | Reads `HUB_URL`, `HUB_KEY`, `HUB_TIMEOUT_MS`. `hubMode()` is the one switch. |
| `client.ts` | Typed `GET`s with a timeout. 429, 502–504 and network errors are retried with doubling back-off, waiting the hub's `Retry-After` but never more than 10 s. Batch candles are asked 300 symbols at a time and F&O membership 400 days at a time. The key is a private field and is scrubbed from every error message. |
| `sse.ts`, `stream.ts` | One SSE connection for every live symbol (at most 100): reopened when the symbol set changes (coalesced over 250 ms), reconnected with back-off and `Last-Event-ID`, and treated as dead after 45 s of silence. |
| `index.ts` | The app's one client and stream, and the hub's `/v1/status` cached for 30 s (`hubHealth`). |
| `budget.ts` | The hub's broker budget as services see it (`planLimits`, `budgetFor`), from `/v1/status`, for pacing the screener's live quotes and the high/low sweep (`sweepIntervalMs`, `shareOfCaps` in `src/core/ratelimit/budget.ts`). The hub enforces the broker's limits itself; Tradex only avoids spending more than its share of the day. |

### Daily bars (`providers/dailyBars.ts`, `dailyStore.ts`)

The screener, backtests, the plan's evidence and the trade journal read one store of daily bars per symbol:

- A new symbol is read in full — 5 years — with every other new symbol of the universe in one `/v1/candles/batch` request. After that only the last week is asked for; the overlap replaces provisional bars and fills in delivery %.
- A stored close that moved (the hub re-downloaded adjusted history after a split or bonus) triggers a full re-read of that symbol.
- Symbols the hub doesn't hold in full come back in `queued`: the hub downloads them in the background. What it has is used meanwhile (not saved), the screener and backtest panel say "the hub is downloading N symbols", and the store asks again after 30 s. When the hub's broker can't be used, the answer carries a `warning` instead and the store asks again in 5 minutes. Between ~16:00 and ~18:00 IST a stock missing only the day's bar (filled by NSE's evening file) is not queued and counts as held.
- Bars are kept in memory and in `.cache/screener/daily/` with the range they cover; files from earlier versions (about a year, no coverage) are read in full once.
- During the session, today's forming bar is laid over the stored ones: the hub's live quotes, refreshed at a pace its broker budget allows (`livePaceMs`), with newer stream ticks on top. A stored last price (`delayed`) is never used as today's bar.

### F&O data (`providers/foData.ts`, `futures.ts`)

- **Open interest** for the screener's tag: `/v1/fo/oi/day` (the newest stored trade day), cached 30 minutes and shown when it's at most a week old. Each row becomes a `FoDayRecord` and `oiFact` (`src/core/market/openInterest.ts`) gives the buildup class (sign of the near-month future's change × sign of the combined OI change) and OI change %. It is **information only and never scored**: over Oct 2025 – Nov 2026 neither the buildup classes nor the futures basis showed a tradeable edge after costs.
- **Point-in-time F&O membership** for backtests and the plan's evidence: `/v1/fo/members?from&to` over the stored span (400 days per request), cached 6 hours. Days the hub has no F&O file for are absent and fall back to today's list (`src/core/backtest/universe.ts`).
- **Futures contracts**: `/v1/fo/contracts?symbol=` lists the near and next month as hub tickers with their real expiries and the lot, cached until the near month expires. The order ticket picks the contract (`pickContract`: the near month unless it expires inside the holding period) and reads the basis from one quote of the stock and its future. The Day High/Low sweep loads the F&O list's contracts in the background, two at a time, and sweeps each stock's near-month future once its ticker is known. Right after an expiry the hub may list only one contract (as near) until the evening's file. Tradex never builds a contract name itself.

### Broker budget

The hub enforces the broker's limits (Fyers' Standard plan: 5 calls a second, 50 a minute, 5,000 a day; Prime is 100× the day) for every app connected to it. Tradex reads the hub's counters from `/v1/status` and paces its own background work from them:

| Priority | Used for | Share of the hub's minute | Share of its day |
|---|---|---|---|
| `user` | charts, search, order ticket | all | all |
| `refresh` | watchlist, alerts, the screener's live quotes | 75% | 85% |
| `background` | high/low sweep | 50% | 70% |

- The Day High/Low scan runs only while its panel is open, about every 1½ minutes on Standard (`sweepIntervalMs`); symbols on the live stream are checked on every tick.
- Watchlist quotes may be up to 5 minutes old on Standard; on-screen rows and charts stream live.
- Screener quotes are refreshed during market hours at a pace worked out from the `refresh` budget left for the session (~35 s for the F&O list on Standard, never under 15 s).

The top bar's meter (`/api/broker/usage`) shows the hub's calls today against its cap; clicking it opens the read-only **Market data** panel (`/api/data/hub`): the hub's health, problems and warnings, and how fresh each dataset is.

## Daily trade plan (`src/core/plan`)

The **Plan** tab (the bottom panel's default) turns the screener into a short list: which trades to take today, how many lots, how to get in and out, plus your open trades and a journal.

```
 dailyStore: 5 years of daily bars + delivery %, from the hub's batch candles
        │  + point-in-time F&O list (providers/foData.ts, /v1/fo/members)
        ▼
 scanSignals → evidence.ts replaySignals → summarizeEvidence   services/evidence.ts: background,
        per screen × NIFTY above / below its 200-day             cached in .cache/plan-evidence.json
        │                                                         by last stored session
        ▼  GET /api/plan/evidence
 builder.ts buildPlan(screener matches, evidence, market state, open trades, ban list, lots, settings)
        │                                                         in the browser (terminal/usePlan.ts)
        ▼
 PlanPanel.tsx ── "I took it" → POST /api/trades (Prisma `Trade`) ── tracker.ts / journal.ts
```

| Piece | Job |
|---|---|
| `evidence.ts` | Replays every screen over the stored history (`scanSignals`, no look-ahead) and walks each signal with `simulatePlan`: bought at the signal close or on the buy-stop, out at the stop, target, next open (BTST) or the close after `HOLD_BARS`. R is on the planned risk, net of the `futures-2026` cost preset (slippage both legs + charges, one lot). Per screen and market state (NIFTY close vs its 200-day average on the signal day): n, mean, t-stat over days (each day's trades averaged first), first 60% / last 40% of that bucket's signals in date order, last 12 months, and top vs bottom third by score. **PASS = mean > 0 in both parts and t > 2** (and ≥ 30 trades). |
| `builder.ts` | Candidates = today's matches of screens that pass in the current state; one per stock (highest expected R); ranked by expected R, with the score as a tie-break only where it ranks trades; F&O-ban and held stocks left out; sized at risk % ÷ (entry − stop) in whole lots under a leverage cap; fills the free slots. Ideas whose one lot risks more than the budget are listed separately as "too big". |
| `instructions.ts` | Entry and exit wording, and the stored exit rule (`next-open`, `stop-target`, `time`, `trail-low:10`). |
| `tracker.ts` | Today's action for an open trade from the stored daily bars (server) with the live price laid over it (browser). |
| `journal.ts` | Realised R, net R after charges, and slippage of your fills against the plan. |

The split is per bucket because NIFTY spent most of 2022–24 above its 200-day average and most of 2025–26 below it; a calendar split would leave one part of each state nearly empty. The evidence covers the 5 years of daily bars the hub serves. Point-in-time F&O membership is used on the sessions the hub has an F&O list for.

The trade journal is the Prisma model `Trade` (per user; `side` is stored so short strategies can be added later). Routes: `GET/POST /api/trades`, `PATCH/DELETE /api/trades/:id`, `POST /api/trades/:id/close`.

## Backtesting (`src/core/backtest`)

The **Backtest** tab in the bottom dock replays the screens over the stored daily history and trades their signals as one account. It answers "what would this set of screens have done with my sizing, my position limit and real costs", with enough detail to judge whether the result can be trusted.

```
 screenerStore (up to 5 years of daily bars from the hub's batch candles; opening the panel asks for any symbol not held)
        │
        ▼
 signals.ts  scanSignals()   every screen × every stock × every session  ── cached per universe + last session
        │                    (the slow part: ~10 s for ~220 stocks × 257 sessions)
        ▼
 portfolio.ts runPortfolio() one account: slots, sizing, fills, costs   ── milliseconds; cached per request
        │
        ▼
 metrics.ts   trade + equity statistics, monthly returns, IS/OOS split
```

- Service: `src/server/services/backtest.ts`. Routes: `GET /api/backtest?universe=` (stored history: sessions, dates) and `POST /api/backtest` (a `BacktestRequest`, see `src/contracts/api.ts`). The scan yields to the event loop between sessions, and the response reports its runtime.
- UI: `src/terminal/BacktestPanel.tsx` (form `BacktestForm.tsx`, results `BacktestResults.tsx`, SVG chart `BacktestChart.tsx`, styles `backtest.css`).
- The screener's **Track** column (`runTrackRecord` in `src/core/screener/backtest.ts`) is separate: it scores each screen's signals one by one, with no account, sizing or costs.

### How a session is simulated

1. **Signals.** Each screen's rules run on features computed from that stock's bars **up to and including** the session (`computeFeatures` on `bars.slice(…, i + 1)`), with relative strength ranked across stocks on the same session. `signals.test.ts` checks that rewriting every bar after a date leaves the signals before it unchanged. A stock needs 60 sessions of warm-up; screens that use the 200-day average or the 52-week high fire only once that much history exists.
2. **Entries.** A signal is decided on the session's close. By default it is bought at the **signal session's close**, as the screens are meant to be run at 3:15–3:25 PM; that is slightly optimistic because the real close isn't known yet. "Next open" buys at the next session's open instead (skipped if that open is already beyond the stop or the target). A plan whose entry is above the close is a **buy-stop**: it must trade through on the next session, filling at the higher of the open and the trigger, or it is dropped.
3. **Exits**, the same rules as the track record's `simulatePlan`:
   - a bar that touches both the stop and the target counts as the stop;
   - a gap through a level fills at the open (worse than the level), except on a buy-stop's fill bar;
   - otherwise the position is closed at the close after the holding period: each screen's `HOLD_BARS` (BTST 1, swing 10, 15–30 days 25, results 10) or the override. The time exit is never the entry session itself, so a BTST bought at the next open is sold at the following close;
   - anything still open on the period's last session is closed at its close ("Period end").
4. **Slots.** At most *max positions* open (pending next-open orders count), one position per stock across all screens. When more signals fire than there are free slots, they are taken by the screen's `score`, highest first. Scores of different screens are on different scales, so with several screens they are interleaved: each screen's best signal, then each screen's second best, and so on.
5. **Sizing.** Risk per trade = *risk %* × current equity (marked to market at the signal close). Quantity = risk ÷ (planned entry − stop), rounded down to **whole futures lots** (the hub's lot sizes, `getLotSizes`) or to whole shares when lots are off or unknown; the result says which. A signal whose single lot risks more than the budget is skipped and counted. Total open notional is capped at equity × *max leverage* (default 4×; stock-futures margin is roughly 20–25% of notional).
6. **Equity** is cash plus open positions marked to the close. R = net P&L ÷ the ₹ risk the trade was sized for.

### Costs (`costs.ts`)

Defaults for NSE stock futures carried overnight (NRML), as of November 2026. Each rate is cited in the file; check your contract note.

| Charge | Rate | Side |
|---|---|---|
| Brokerage | ₹20 per order, or 0.03% if lower | both |
| STT | 0.05% (raised from 0.02% on 1 Apr 2026, Budget 2026-27) | sell |
| NSE transaction + IPFT | ₹183 per crore (0.00183%) | both |
| SEBI fee | ₹10 per crore | both |
| Stamp duty | 0.002% | buy |
| GST | 18% of brokerage + transaction + SEBI | both |
| Slippage | 0.05% of price a leg by default (or N ticks) | both, against you |

Presets: "Stock futures, 2026 rates", "cautious fills" (0.15% slippage) and "No costs" (to see what costs take). Costs matter most for short holds: on a trade with a stop 1% below entry, STT alone is 0.05R and the default slippage another 0.1R.

### Statistics (`metrics.ts`)

- Daily returns are close-to-close changes of marked-to-market equity.
- **Sharpe** = mean ÷ standard deviation of daily returns × √252, risk-free rate 0. A futures account's margin cash usually earns nothing; against a ~6.5% T-bill rate the ratio would be lower.
- **Sortino** uses the downside deviation √(mean of min(r, 0)²) instead.
- **CAGR** annualises over the calendar length of the period. Under a year it is an extrapolation, and the UI says so.
- **Max drawdown** is the largest fall from a running equity peak. Its duration is the longest run of sessions below a previous peak.
- **Exposure** is the share of sessions with at least one open position.
- **Win rate** counts trades with net P&L > 0. **Profit factor** = gross profit ÷ gross loss.
- The benchmark is NIFTY bought at the close before the period on the same capital, without costs.

### Reading in-sample vs out-of-sample

The period is split by signal date: the first 70% is in-sample, the last 30% out-of-sample (20/30/40% selectable). The screens' thresholds weren't fitted to this data, so the split is not a re-optimisation check. It shows whether the result is **stable over time**:

- Similar R, win rate and profit factor in both columns is the reassuring case.
- A positive in-sample and a flat or negative out-of-sample column means the overall result leans on one stretch of the market. The panel warns when out-of-sample R is below half of in-sample, or turns negative.
- With fewer than ~30 trades overall, or ~10 out-of-sample, the numbers are anecdotes; the panel says so.

Further warnings flag one trade making most of the profit, most signals being skipped for lack of slots, many signals too small to size, and short history.

### Known limitations

- **Survivorship bias.** The Nifty universes are today's lists. Stocks that were dropped, delisted or merged during the period are missing, and stocks added after strong runs are included. That flatters results. The **F&O universe is point-in-time** on every session the hub has NSE's F&O bhavcopy for (see "F&O data" above): on those sessions only stocks that had stock futures that day can signal; other sessions use today's list, and every result says how many sessions used which. Former members without stored daily bars still can't be replayed (the note names them). In testing this moved a BTST backtest by only ~0.015 pp a day, so it is a correctness fix, not an edge.
- **Cash prices stand in for futures.** The futures basis (usually a small premium that decays to expiry) is ignored, as are rollover costs and slippage at monthly expiry. Positions held over an expiry would really be rolled: two more orders and a calendar spread.
- **Daily bars only.** Inside a session the order of high and low is unknown; that's why a bar touching both stop and target counts as the stop. Intraday entries and trailing stops can't be modelled.
- **Up to five years of history.** The hub serves about 5 years of daily bars (the broker's limit). Most screens need 60–250 sessions of warm-up. The panel shows the sessions, signals and trades behind every result.
- **Lot sizes are today's**, applied to the whole period; NSE revises them twice a year.
- **Delivery-based screens** need NSE delivery data, which exists only for completed sessions in the bhavcopy.

The daily bars come from the hub's `/v1/candles/batch`; a symbol the hub doesn't hold yet is downloaded by the hub in the background, and the panel says so until it arrives.
