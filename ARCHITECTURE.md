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
| Providers | `src/server/providers` | The Market Data Hub client (`hub/`) and what is built on it: the daily-bar store (`dailyBars`, `dailyStore`), reference data (`reference`: lots, ban list, results calendar; `referenceHistory`: their past values; `asOf`: the point-in-time door the screener, plan and backtests must use), F&O data (`foData`: OI, membership), futures contracts (`futures`), universes; plus symbols, sample data and the trade-record database. | same |
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
- **Tests:** engine tests sit next to the code as `*.test.ts` (vitest). They need no network or server. End-to-end tests (`e2e/`, Playwright) run the production build against a stub Market Data Hub with fixed data, including screenshots of the chart canvas; see [CONTRIBUTING.md](CONTRIBUTING.md#end-to-end-tests).

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
   /v1/lots, /v1/fo/ban, /v1/results-calendar ▶ providers/reference.ts ─┐
   /v1/lots/history, /v1/fo/ban/history,                                ├▶ providers/asOf.ts ─▶ screener, plan, backtests
   /v1/adjustments/batch, /v1/symbols/changes ▶ providers/referenceHistory.ts ┘   (the only door to reference data for them)
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
| `sources/hub.ts` | The `hub` source (kind `broker`). Symbols are hub tickers: `SBIN`, `NIFTY`, and stock futures like `SBIN26NOVFUT`; `NSE:SBIN-EQ`, `NSE:NIFTY50-INDEX` and `NSE:SBIN26NOVFUT` (names older layouts saved) are mapped to them, and only plain tickers are sent. Intervals: 1m, 5m, 15m, 1h and 1d as served; 3m from 1m, 10m from 5m, 30m from 15m, 2h/4h from 1h, resampled from 09:15 IST (`resampleIntraday`). Windows: daily back to NSE's first session (3 Nov 1994: the broker's ~5 years, NSE's archive before them — market-data-hub#22), 1 year intraday, 30 days of 1-minute bars. A 503 that still carries stored candles is shown but not stored as complete; nor is an answer reaching before the broker's window that the hub doesn't call complete (its archive may still be downloading). |
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

### Decades of daily history (`providers/longBars.ts`, `core/backtest/phases.ts`, `core/market/olderBars.ts`)

The hub serves daily history back to 1994 (market-data-hub#22): NSE's archive before the broker's ~5-year window, the broker's bars inside it, one series per company across ticker renames (INFY includes INFOSYSTCH before June 2011), with `sources` saying which stretch came from where. Tradex uses it in three places, all opt-in, so the defaults cost what they did:

- **Charts.** A daily, weekly or monthly chart opens with 5 years. Scrolled or zoomed to within 20 bars of its oldest bar (`ChartEngine` `onNeedOlder`), it asks `/api/chart?…&from&to` for the stretch before: ten more years of daily bars, or weekly/monthly ones back to 1994 at once, put in front with `prependBars` (the view is anchored to the newest bar, so nothing on screen moves). The answer's `hasOlder` says whether to keep going.
- **Backtests.** A period starting before the store's 5 years — a custom date back to 1994, or a **market phase** (2008 crash, 2010–13 sideways, 2020 Covid crash, 2021–26) — is a long run: its bars are read from the hub for that run (`LongBars`, 40 symbols a request, the newest set kept in memory, nothing on disk because the hub lines the archive up with the broker's level at a seam that moves daily), from 440 days before the period (the features' 260-session look-back) to its end, and only that stretch is scanned. The F&O list is point-in-time over the period. Before 2012 NSE's index file has no NIFTY: the hub's equal-weight NIFTY 50 basket stands in for it (`spliceBenchmark`), and the result says so. Cost grows with length: ~6 s for the 2008 crash, ~25 s per decade, ~90 s and ~0.8 GB for 1994–2026 (220 stocks, Apple-silicon laptop), so it stays out of the CI budgets; the default 5-year run and its run stamps are unchanged.
- **Evidence.** The plan keeps its 5-year evidence. "Show the evidence" can also replay a market phase (`/api/plan/evidence?from&to`), computed in the background the same way and counting only the period's own sessions.

Each long run's warnings name the stocks joined across renames, those the hub doesn't hold whole yet, and those with sessions missing inside their own history (`historyGaps`: across a rename, that would be the join failing — ice-009/tradex-public#16).

### F&O data (`providers/foData.ts`, `futures.ts`)

- **Open interest** for the screener's tag: `/v1/fo/oi/day` (the newest stored trade day), cached 30 minutes and shown when it's at most a week old. Each row becomes a `FoDayRecord` and `oiFact` (`src/core/market/openInterest.ts`) gives the buildup class (sign of the near-month future's change × sign of the combined OI change) and OI change %. It is **information only and never scored**: over Oct 2025 – Nov 2026 neither the buildup classes nor the futures basis showed a tradeable edge after costs.
- **Point-in-time F&O membership** for backtests and the plan's evidence: `/v1/fo/members?from&to` over the stored span (400 days per request), cached 6 hours, read through `asOf` (below). A day without a file uses the file before it, up to a week back (holidays); further gaps are unknown and fall back to today's list (`src/core/backtest/universe.ts`).
- **Futures contracts**: `/v1/fo/contracts?symbol=` lists the near and next month as hub tickers with their real expiries and the lot, cached until the near month expires. The order ticket picks the contract (`pickContract`: the near month unless it expires inside the holding period) and reads the basis from one quote of the stock and its future. The Day High/Low sweep loads the F&O list's contracts in the background, two at a time, and sweeps each stock's near-month future once its ticker is known. Right after an expiry the hub may list only one contract (as near) until the evening's file. Tradex never builds a contract name itself.

### Point in time: `asOf` (`providers/asOf.ts`, `src/core/reference/pointInTime.ts`)

The screener, the plan and the backtester read reference data only through one API, so every number can be asked "as it was known on day D":

```ts
const known = await asOf(day);                       // one day (today by default)
const span = await asOfSpan(from, to, { symbols });  // every day of a span, one set of hub requests
span.at(day)                                         // the same answer asOf(day) gives
```

Each answer is a `Known<T>`: `{ known: true, value, asOf, source }` or `{ known: false, reason, knownFrom }`. Where the hub keeps no history the answer is **unknown, with the reason** — never today's value passed off as that day's. A caller that wants today's value as a stand-in says so with `orElse(fact, fallback)` and says so in its output (the backtest and evidence notes count the sessions).

| Field | Known on day D when | Otherwise |
|---|---|---|
| `foList` | the hub has NSE's F&O bhavcopy for D, or for a day up to a week before (holidays) | unknown (before the hub's archive, gaps) |
| `lots` (as traded that day), `lotInTodayShares(s)` | D is on or after 8 Jul 2024 (NSE's F&O files carry the lot column from then; `/v1/lots/history`); today: NSE's lot file | unknown before 8 Jul 2024 — the backtest and evidence use today's lot there and say on how many sessions |
| `ban` | the hub stored that trade date's list (`/v1/fo/ban/history`, from when the hub started downloading it); today: the newest list | unknown |
| `results.reported` | results dated D−7…D, from the hub's calendar | unknown outside the span read |
| `results.upcoming` | today only | unknown for past days: the hub doesn't store when a date was first announced |
| `sectors` | indices with stored history by D (their first session ≤ D); the industry → index map is the hub's current one | — |
| `industries`, `universe("nifty…")` | today only (snapshots) | unknown for past days; `universe("fno")` of a past day is that day's F&O list |
| `ticker(s)` | today's ticker as named on D, from NSE's ticker changes (`/v1/symbols/changes`) | unknown if the hub can't answer |
| `priceScale(s)` | split/bonus factors loaded (`/v1/adjustments/batch`): what a today-adjusted price is multiplied by to be adjusted only for actions with an ex-date on or before D (`adjustAsOf` re-expresses bars) | unknown |

Lots and prices meet in `lotInTodayShares`: the daily bars are adjusted to today, so a lot of 250 before RELIANCE's 1:1 bonus (28 Oct 2024) is 500 of the bars' shares — the same notional as 250 shares at the price then.

**The lint rule.** `src/core/screener`, `src/core/plan`, `src/core/backtest` and the services `screener`, `evidence`, `backtest`, `btstRecord`, `analyze` and `trades` may not import `providers/reference`, `providers/referenceHistory`, `foMembership`, `getUniverse`, `hubClient` or `HubClient` (ESLint `no-restricted-imports`, matched by regex so relative paths are caught too; `src/asOfOnly.test.ts` proves it). Other features (the results panel, the lots endpoint, the high/low sweep) may still read today's data directly.

### The Time Machine (`?asOf=YYYY-MM-DD`, issue #31)

The whole terminal as it was at a past day's close, with nothing from after it. The day lives in the URL (`/?asOf=2020-03-23`; the top bar's **As of** picker sets it) and in `src/client/timeMachine.ts`; `src/client/api.ts` adds it to every endpoint that answers as of a day, so no caller can forget it. The server decides what was known: `services/timeMachine.ts` (`pastDay`) snaps the day to the last session on or before it from the hub's calendar (`/v1/calendar`, through `asOf.tradingDays`; without it weekends are skipped and the answer says holidays weren't checked). Today or later is the live terminal.

| What | As of day D | How it can't see later |
|---|---|---|
| Charts (`/api/chart`) | daily bars read from the hub up to D (`dailyCandlesThrough`), intraday ones up to 15:30 IST that day (the hub keeps a year of them; older days switch charts to D/W/M); weekly/monthly built from those; split/bonus markers up to D | `barsThrough` cuts every bar after D's close; no live bar: the browser's stream is closed and `liveHub.getLatest` answers nothing |
| Prices | adjusted only for the splits and bonuses with an ex-date ≤ D: today's adjusted price × `asOf.priceScales(D)` (RELIANCE before its 2017 bonus shows the price it traded at) | the factors after D are undone; a stock whose factors the hub can't give is said in the notes |
| Watchlist (`/api/quotes`) | D's close and its change on the session before | read from the hub up to D; marked `delayed`, so no alert fires |
| Screener, track record | `runScreener(…, past)`: bars up to D (the store when it covers the 640-day look-back, else read from the hub for that day, `pastBars`), that day's F&O list, ban list and sector indices (`asOf(D)`); no live bar, OI tag, first-seen times or BTST record | index lists and industries are today's snapshots and the notes say so (survivorship); the track record counts only signals whose holding period ended by D |
| Plan evidence (`/api/plan/evidence`) | the same five years the live plan uses, ending D, on bars up to D adjusted as of D; F&O list and lots of each session, with D's own as the stand-in (never today's); kept in memory per day | a signal needs its whole holding period inside the bars (`replaySignals`), so only trades closed by D count (`evidenceAsOf.test.ts`); market state from NIFTY up to D; no live record |
| Lots (`/api/lots`), results (`/api/results`) | lots as traded on D (NSE's files have them from 8 Jul 2024; before, ≈ ₹5 lakh at D's close stands in, said); results dated D−7…D | upcoming dates aren't stored with when they were announced, so none are shown |
| Live-only | Day High/Low, Compare, Backtest and Lab panels, price alerts, the order ticket, the BTST alerts, "I took it", the journal and Lab receipts are off or labelled | — |

`src/server/services/timeMachine.test.ts` is the guard: it computes everything for a past day from a fake hub twice, with two different futures after the day (rewritten bars, a stock joining and one leaving F&O, a bonus that rescales the hub's earlier bars, a ban, a lot change, a results date), and with a hub that ignores `to` — the answers must be identical.

Measured on the live hub (Apple-silicon laptop): 23 Mar 2020's screener (143 F&O stocks, bars read from the hub) ~0.7–1.3 s the first time, ~40 ms after; its evidence ~8 s in the background (bars ~1.3 s, replay ~6–7 s over 234 stocks × 1,528 sessions).

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

## Health, logs and metrics

The **`/health`** page answers "why is this number old?". It reads `GET /api/health/details` (signed in) every 15 s:

| Section | From |
|---|---|
| Why might a number be old? | `assessHealth` in `services/healthRules.ts`: the hub's own `problems`/`warnings`, plus what only Tradex knows: a resting data source, its stream from the hub failing, no ticks while the market is open, the hub's day budget nearly spent, its own copies behind the hub, failed jobs, and the market being closed. Verdict `ok` / `degraded` / `down`. |
| Market Data Hub, broker, budget | The hub's `/v1/status` (cached 30 s, `providers/hub/index.ts`). |
| Live prices | Three links: broker → hub (`live.feed` in `/v1/status`), hub → Tradex (`HubStream.diagnostics()`), Tradex → browsers (`MarketStream.diagnostics()`), and any source resting after errors. |
| Data freshness | Each hub dataset (`hubDatasetHealth`): **stale** when the hub's health check says so (it knows exchange holidays), **late** for its "fine if a holiday" warning, **refresh failed** when its newest attempt failed but an older copy is used, **waiting** during a weekday before the evening NSE file is due (20:00 IST). Then Tradex's own copies: the screener's daily bars (behind the hub's newest session?), the OI tag, the plan evidence; and the hub's stored candles for information. Each row says what in Tradex uses it. |
| Data quality | The hub's data-quality checks (`quality` in `/v1/status`, mapped by `src/core/quality/findings.ts`), run on the hub after every evening import and archive download: missing sessions, files for the wrong date, repeated files, candle gaps, price outliers no corporate action explains, stored (broker) closes against NSE's, lot-size and F&O-list changes. The last 30 days' open findings, worst checks first. Recent problems make the verdict `degraded`; warnings are grouped per check in the issues list. |
| Background jobs | The hub's backfills and live gap repair; Tradex's daily-bar sync, plan evidence and Day High/Low sweep. |
| Recent warnings and errors | The newest 30 warn/error lines of the server log, with their request ids. |

**Logs** (`src/server/log.ts`): one JSON object per line on stdout (warn/error on stderr), threshold `LOG_LEVEL`. Every API route goes through `authed()` (`src/server/http.ts`), which gives the request an id (the caller's `X-Request-Id` if sane, else a UUID), returns it as `X-Request-Id`, puts it on every log line written while handling the request (AsyncLocalStorage), and includes it in a 500's body. Requests are logged at `debug`, or `info` when slow (≥ 1 s) or 4xx, `warn` when 5xx. The hub key, `METRICS_TOKEN`, `NEXTAUTH_SECRET`, hub API keys and bearer tokens are scrubbed from every line. `src/instrumentation.ts` logs server start and errors Next.js catches itself. Use `log` instead of `console` on the server.

**Metrics** (`GET /api/metrics`, Prometheus text format, no client library): a signed-in session or `Authorization: Bearer $METRICS_TOKEN`. Request counts and a duration histogram per route (`tradex_http_*`), log lines per level, and the health page as gauges: `tradex_hub_reachable`, `tradex_hub_budget_*`, `tradex_hub_feed_*`, `tradex_hub_stream_*`, `tradex_dataset_stale{dataset}`, `tradex_dataset_as_of_timestamp_seconds{dataset}`, `tradex_job_failed{job}`, the hub's data-quality findings (`tradex_data_quality_findings{severity}`, `tradex_data_quality_recent_findings{severity}`, `…_by_check{check,severity}`, `tradex_data_quality_pending_days`) and more (`services/metrics.ts`).

**Data-quality alerts**: new problems, warnings and lot-size / F&O-list changes from the hub's checks flash as terminal toasts (`src/terminal/QualityAlerts.tsx`, polling `GET /api/health/quality` every 5 minutes; what flashed is remembered in the browser), one per check and trade date, and go to the server log (`hub data-quality finding`) when Tradex reads the hub's status.

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

The split is per bucket because NIFTY spent most of 2022–24 above its 200-day average and most of 2025–26 below it; a calendar split would leave one part of each state nearly empty. The evidence covers the 5 years of daily bars the hub serves. Point-in-time F&O membership is used on the sessions the hub has an F&O list for, and each trade's costs use its session's lot where known (both through `asOf`).

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

### Reproducible runs (`src/core/repro`)

Every backtest result and the plan's evidence table carry a **run stamp** (`RunStamp` in `stamp.ts`):

- **Data:** a content hash of the inputs the run actually read. It has one part for each input: `bars` (every symbol's and NIFTY's daily bars, hashed per series), `membership` (the point-in-time F&O lists up to the last session), `lots` (today's lot sizes of the symbols used), `lotHistory` (their lot changes and split/bonus factors, when sized point in time) and `universe` (today's list). It also records the symbols, the first and last session, and, for reading only, the hub's version and bhavcopy dates.
- **Code:** the git commit (`TRADEX_COMMIT`, set by `next.config.ts` at build time; `-dirty` with uncommitted changes, `dev` without git) and the engine version (`backtest/7`, `evidence/3`).
- **Parameters:** the validated request.
- **Hashes:** `hash` covers the inputs and `resultHash` covers the result. Both are SHA-256 (`sha256.ts`, plain TypeScript) over canonical JSON (`canonical.ts`: sorted keys, integers exact, other numbers to 12 significant digits).

**Re-run this** under a result posts the stamp to `/api/backtest/replay` or `/api/plan/evidence/replay`. The server runs it again from scratch, with no cached scan or result, using the stamp's parameters, its symbols and the bars up to its last session. `compareRuns` then reports the outcome. If the stamp and result hashes match, the run reproduced. If not, it shows which input changed (commit, a data part, a parameter) and which result fields differ. Symbols are scanned in sorted order, so a run doesn't depend on the order of the universe list.

`golden.test.ts` is the guard. It builds a fixed synthetic dataset and runs a backtest and the evidence twice. Both runs must give byte-identical canonical results, and the hashes must match `golden.json` in CI and locally. If a change is meant to alter results, bump the engine version and update `golden.json` from the values the failing test prints.

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
- **Five years by default, back to 1994 on request.** The store holds the broker's ~5 years; a period before them (a custom date or a market phase) is read from the hub's NSE archive for that run (see "Decades of daily history"), with NIFTY's equal-weight stand-in before 2012. Most screens need 60–250 sessions of warm-up. The panel shows the sessions, signals and trades behind every result.
- **Lot sizes before 8 Jul 2024 are today's.** From then each signal is sized with its session's lot (`src/core/backtest/lots.ts`, through `asOf`); NSE's older F&O files don't carry lot sizes, so earlier sessions use today's lot, and the notes say on how many sessions.
- **Delivery-based screens** need NSE delivery data, which exists only for completed sessions in the bhavcopy.

The daily bars come from the hub's `/v1/candles/batch`; a symbol the hub doesn't hold yet is downloaded by the hub in the background, and the panel says so until it arrives.

## Signal Lab (`src/core/lab`)

The **Lab** tab in the bottom dock (and `npm run lab`) is a test bench for any signal: one number per stock per day. Every idea has to show an edge on Tradex's own data, net of costs and after counting how many variants were tried, before it reaches the score.

```
 researchData (services/backtest.ts)   the bars a backtest of the period reads: the store's 5 years, or the hub's
        │                              archive back to 1994 (opt-in); point-in-time F&O list, former members included;
        │                              the data stamp; for screen signals, the backtester's cached signal scan
        ▼
 signals.ts   the signal's value per (day, stock)       built-ins + every screen as "matched vs the rest" and "score among matches"
        ▼
 engine.ts runLab()   rank → forward returns → spreads, splits, decay, turnover      ~0.5 s for 220 stocks × 5 years
        ▼
 LabReport ── run stamp (kind "lab") ── trial record (#24: trialInputs.ts → services/labTrials.ts)
        ▼
 POST /api/lab/run → LabPanel.tsx / LabResults.tsx          scripts/lab.ts → the same report as text (format.ts)
```

| Step | Rule |
|---|---|
| Universe | Each formation day: stocks on that day's F&O list (via `asOf`), traded that day, with a value. Days with fewer than 20 are skipped. |
| Ranking | Into quintiles by value (Q1 lowest, Q5 highest; `quantiles.ts`). Ties share a bucket; a signal with no more distinct values than buckets (a screen's 1/0) is spread by value, so "matched" is always Q5 and "the rest" Q1. `reverse` (`--reverse`) ranks by minus the value, which is how you test the long side of a signal whose expected sign is negative (MAX, volatility). It is part of the variant key. |
| Forward returns | close(t + h) / close(t) − 1 on the stock's own bars, h = 1, 5, 10, 21 (any of 1–63). With `forward: "close-open"` (`--forward close-open`) it is open(t + h) / close(t) − 1 instead: sold at the open h sessions later, so h = 1 is the BTST trade. This is also part of the variant key. A stock whose bars stop before the data's (delisted, merged) is closed at its last close. A window holding a session that moved more than ±50% close to close is a data error (a missed split or bonus) and is left out; in close → open mode so is one holding an open that gapped more than ±50%. The report counts them. |
| Costs | A futures round trip per position (`costs.ts` presets, ~₹5 lakh position): ~0.17% with the 2026 rates. The long–short spread pays two. "Net @ turnover" charges only the stocks replaced at each h-session rebalance (not reported for close → open, where every position is sold at the open). |
| Spread and t | Q5 − Q1 mean per day; t-stats are Newey–West with lag h − 1, because a new h-session window starts every day. IC: daily rank correlation of value and return. |
| Splits | NIFTY above / below its 200-day average on the formation day (`marketStates`), and the evidence's first 60% / last 40% of days (`splitDay`). **Edge** = the evidence's PASS rule on the net spread: > 0 in both parts and t > 2. |
| Decay | The spread at every horizon 1–21, and of each session alone. |
| Turnover | Share of each bucket (and the long and short legs) not in it h sessions earlier. |
| Trials | Each run records one trial per horizon (idea = the signal, variant = its parameters): the net spread's Sharpe on every h-th day (non-overlapping, 252 ÷ h a year), its length, skewness and kurtosis, for the deflated Sharpe ratio. |

**Adding a signal** is one entry in `BUILT_IN_SIGNALS` (`src/core/lab/signals.ts`); the API, CLI, panel and report cards list it automatically.

**Sector signals** (`src/core/lab/sectorSignals.ts`, issue #30) give each stock its sector's value: sector momentum (relative strength vs NIFTY 500), sector reversal and RRG quadrant membership. They declare `usesSectors`; the service (`services/labSectors.ts`) then reads each industry's long series — its NSE index from 2012 with the hub's synthetic equal-weight basket spliced in front (`src/core/sector/series.ts`) — and NIFTY 500 over the run's span, and adds their hashes and the industry map to the data stamp. The RRG maths (`src/core/sector/rrg.ts`: a documented approximation, not RRG Research's formula) also feeds the Sectors panel's rotation graph. Results: [docs/research/sector-rotation.md](docs/research/sector-rotation.md).

### Report cards (`/lab`, `/lab/<signal>`)

Every run (panel, CLI, card; not a replay of an old stamp) is saved as its variant's latest report (`lab_reports` in `.cache/market.db`, `providers/labReports.ts`, next to the trial record), so a card opens without running the Lab again. `/lab` lists every signal with its latest verdict, period and DSR; `/lab/<signal>[?variant=…]` is one signal's card: the verdict and its reasons, the long–short spread's equity curve (net, summed over non-overlapping h-session holds), decay with a ±2 Newey–West se band, bucket returns, regime and 60/40 tables, costs and turnover, sample sizes, data errors, notes, the trial record and the run stamp ("Re-run this", "Run again on the latest data"). The Lab tab links to it ("Open report card").

The verdict (`src/core/lab/verdict.ts`, rules in its header) is worked out when the card is read, against the trial record as it stands then, at the horizon with the highest net t (or the one picked on the card):

| Verdict | When |
|---|---|
| too little data | fewer than 30 days with a spread, or fewer than 20 non-overlapping h-session spreads |
| works | net spread > 0 with t > 2 over the period, > 0 in both the first 60% and last 40%, and the variant's deflated Sharpe ratio ≥ 0.95 |
| works in uptrends / downtrends only | one regime (NIFTY vs its 200-day average) has an edge on its own (> 0, t > 2, 30+ days) and the other is ≤ 0; deflated on that regime's days |
| no edge | anything else — including an edge that fails the deflated Sharpe ratio, which the card calls "looks good, but likely luck after N trials" |

```bash
npm run lab -- --list
npm run lab -- --signal momentum-12-1 --from 2021-01-01
npm run lab -- --signal screen:pos-52w-high --horizons 1,5,10,21 --json out.json
npm run lab -- --signal max-21d --param top=5 --reverse --from 2010-01-01          # issue #26
npm run lab -- --signal overnight-return --forward close-open --horizons 1 --from 2010-01-01   # issue #28
```

Results so far: [lottery-max-volatility.md](docs/research/lottery-max-volatility.md) (#26) and [overnight-intraday.md](docs/research/overnight-intraday.md) (#28).
