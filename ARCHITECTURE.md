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
            │  src/server/providers   data: Fyers, NSE files, caches, db      │
            └───────┼─────────────────────────────────────────────────────────┘
                    ▼
            src/core   pure calculation engine — used by both sides
```

| Layer | Folder | What goes here | May import |
|---|---|---|---|
| Engine | `src/core` | Indicators, patterns, screens, scoring, backtest, tick and futures maths, IST session rules, file parsers. Pure functions: no I/O, no React, no Next. | `@/core` |
| Contracts | `src/contracts/api.ts` | The JSON body each `/api` route returns. Types only. | `@/core` (types) |
| Data engine | `src/server/data` | One pipeline for market data whatever the source: source adapters, routing with fallback, caches, and the live price stream. See below. | `@/core`, `@/contracts`, `@/server` |
| Providers | `src/server/providers` | Raw clients for each external system: Fyers client/auth/socket/budget, NSE bhavcopy store (`dailyStore`), lot files, results calendar, universes, symbols, sample data. | same |
| Services | `src/server/services` | One use case per file: load data from providers, run the engine, return a contract type. | same |
| Routes | `src/app/api/**/route.ts` | `export const GET = authed(...)`: read params, call one service, `NextResponse.json`. No logic. | `@/server`, `@/contracts` |
| Client data | `src/client` | `api.ts` (typed fetchers, the only place that knows URLs) plus feeds: `marketData` (history, quotes, live ticks), `screenerFeed`, `highLowFeed`, `lotsFeed`. | `@/core`, `@/contracts`, `@/client` |
| Renderer | `src/chart` | Canvas chart engine, drawings, annotations, theme. Draws engine output; fetches nothing. | `@/core`, `@/chart` |
| UI | `src/terminal`, `src/components` | React components and UI state (`store`, `uiPrefs`, `presets`, `ideaActions`). | everything except `@/server` and `@/app` |

## Where to add things

- **A new indicator or pattern:** `src/core/indicators`. Register it in `indicators.ts`; the chart draws it through `annotate()`.
- **A new screen:** add a `ScreenDef` to `SCREENS` in `src/core/screener/screens.ts`. The service, API and UI pick it up with no other changes.
- **A new market-data source** (another broker, a vendor API): see "Adding a data source" below. For reference files (lot sizes, calendars), add a provider in `src/server/providers` with its parser in `src/core/parsers`, so the parser can be tested without the network.
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

## Data engine (`src/server/data`)

Market data reaches the app through one pipeline that doesn't depend on where it comes from:

```
 sources/fyers.ts ─┐                                   ┌─ /api/chart, /api/quotes (services)
 sources/eod.ts  ──┼─▶ DataEngine (engine.ts) ─────────┼─ screener backfill + live bar (dailyStore)
 sources/sample.ts ┘     history · quotes             ├─ Day High/Low sweep
        │                                               │
        └── live socket ─▶ MarketStream (stream.ts) ──┴─ /api/broker/stream (SSE) ─▶ browser liveHub
                             socket, or polled quotes
```

| Piece | Job |
|---|---|
| `types.ts` | The `DataSource` interface. A source declares what it can do: `history` (which intervals, how far back, whether downloads are worth caching), `quotes` (live or delayed) and `stream` (live socket and its symbol limit). |
| `engine.ts` | `DataEngine.history()` and `.quotes()`: try sources in order, skip ones that can't serve, and fall back on failure. Sources are rested for 30 s after network, auth, 5xx or rate-limit errors; an error about one symbol doesn't rest the whole source. History is kept on disk incrementally; quotes are cached with per-caller freshness. Every answer is tagged with its source. |
| `stream.ts` | `MarketStream`: one live pipeline. It uses a source's socket when one connects, highest-priority symbols first, up to the symbol limit. Everything else, or everything when there's no socket, is polled through the engine and sent as identical `Tick` events marked `polled`. When the socket returns, polled symbols move onto it. |
| `sources/` | `fyers` (broker: history, quotes, socket; every call charged to the Fyers budget), `eod` (the screener's daily store: real daily candles and the last close as a delayed quote, at no API cost), `sample` (generated candles, last resort, clearly labelled). |
| `index.ts` | Wiring. `DATA_SOURCES` in `.env` sets the order (default `fyers,eod,sample`). `/api/data/sources` shows each source's state. |

**What the app sees:**
- Charts get `source` (`broker`, `eod` or `sample`), `sourceId`, and a `sourceReason` when a fallback answered.
- Quotes carry `source` and `delayed`.
- Ticks carry `source` and `polled`.
- The top bar shows **Live** (socket), **Delayed** (polling) or **Feed offline**.

The screener asks for broker data only (`kinds: ["broker"]`), so sample data can never get into it.

### Adding a data source

1. Write `src/server/data/sources/<name>.ts` exporting a `DataSource`:
   - Map the app's symbols (`RELIANCE`, `NIFTY`, `NSE:SBIN26NOVFUT`) to the source's own naming.
   - Return `unavailable()` reasons when it isn't configured.
   - Throw `SourceSkip` for "not now", for example when its quota is spent.
2. Add it to `AVAILABLE` in `src/server/data/index.ts` and list it in `DATA_SOURCES`.
3. Test it the way `engine.test.ts` does, with fake responses.

Charts, quotes, the screener, the scanner and the live stream pick it up with no other changes.

## Broker API budget (Fyers)

Fyers limits Data API calls (quotes, history, option chain) per plan. From 16 Oct 2026:

| Plan | Per second | Per minute | Per day | Symbols per quote call | Live-socket symbols |
|---|---|---|---|---|---|
| Standard | 5 | 50 | 5,000 | 50 | 100 |
| Prime | 10 | 500 | 5,00,000 | 1,000 | 5,000 |

More than 3 per-minute breaches in a day block the account for the rest of that day. Set `FYERS_PLAN=prime` in the environment if you're on Prime; the default is `standard`.

Every data call goes through `src/server/providers/fyers/budget.ts`, which applies the policy in `src/core/ratelimit/budget.ts`:

- **Headroom:** at most 3 calls a second (60% of Standard's 5), 80% of the per-minute limit and 95% of the daily one.
- **Windows are counted as Fyers sees them:** a call holds its slot from when it's sent until one window-length after its response arrives. Counting by send time isn't enough: on a cold start the first calls are slowed by connection setup and reach Fyers together with the next second's calls. That produced real 429s at 4 sends a second.
- **On a 429:** it is never retried. All calls pause for a minute, and the strike counts once per burst. For the rest of that day the budget runs at 1 call a second and half the per-minute cap, to avoid a 4th strike. Calls from the last minute are saved, so a restart can't start with a burst.
- **Priorities:** `asPriority("background", fn)` tags every call made inside `fn`.

  | Priority | Used for | Share of each minute | Share of the day |
  |---|---|---|---|
  | `user` | charts, search, order ticket | all | all |
  | `refresh` | watchlist, alerts | 75% | 85% |
  | `background` | high/low sweep, screener, backfill | 50% | 70% |

- **Persistence:** the day's count is saved to `.cache/fyers-usage.json`, so a restart doesn't reset it. The top bar meter (`/api/broker/usage`) shows the count.

Tradex is for shortlisting; orders are placed in the broker's own app. So the defaults favour a low call count over tick-fresh numbers:

- The Day High/Low scan runs only while its panel is open.
- Watchlist and screener quotes may be up to 5 minutes old; on-screen rows and charts stream live over the socket at no API cost.
- The order ticket uses cached quotes; it is a planning aid only.

How the app keeps its calls down:

- **Quotes:** one cache in the data engine serves every reader. Each caller says how old a quote it accepts: the order ticket takes 5 s; the watchlist and screener take 5 min on Standard, so they share one fetch. The high/low sweep usually pays for everyone.
- **Day high/low sweep:**
  - It is paced from what's left of the background budget for the rest of the session (`sweepIntervalMs`), about every 1½ min on Standard.
  - Symbols on the live socket are checked on every tick at no cost.
- **Chart history:** candles live in a local SQLite database, `.cache/market.db` (`src/server/data/candleDb.ts`), one series per source, symbol and interval.
  - A chart opened before costs one "tail" call, or nothing within its freshness window.
  - Downloads use Fyers' request limits: 90 days per intraday request, 365 per daily request.
  - Fyers' `{ s: "error" }` replies (sent with HTTP 200) are treated as errors. With a broker connected, a failed load shows that error instead of sample candles.
- **Download F&O history** (`src/server/services/historyPrefetch.ts`, `/api/data/history-db`, the Market data dialog):
  - fills the database with 5 years of daily and 1 year of 15-minute candles for every F&O stock plus NIFTY, BANKNIFTY and FINNIFTY;
  - runs at background priority, skips what's stored (resumable), and pauses when the day's background budget is spent;
  - the screener's daily store extends itself from the database with `history({ offline: true })`, which reads the database only and never calls the API, so backtests get the full 5 years.
- **Live socket:** charts get the 100 symbols first, then alerts, then watchlist rows in list order. Symbols that don't fit fall back to the quote refresh.

## Backtesting (`src/core/backtest`)

The **Backtest** tab in the bottom dock replays the screens over the stored daily history and trades their signals as one account. It answers "what would this set of screens have done with my sizing, my position limit and real costs", with enough detail to judge whether the result can be trusted.

```
 screenerStore (stored daily bars, disk only)
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
2. **Entries.** A signal is decided on the session's close. By default it is bought at the **next session's open** (skipped if that open is already beyond the stop or the target). "Signal close" buys at the signal session's close instead, as the screens are meant to be run at 3:15–3:25 PM; that is slightly optimistic because the real close isn't known yet. A plan whose entry is above the close is a **buy-stop**: it must trade through on the next session, filling at the higher of the open and the trigger, or it is dropped.
3. **Exits**, the same rules as the track record's `simulatePlan`:
   - a bar that touches both the stop and the target counts as the stop;
   - a gap through a level fills at the open (worse than the level), except on a buy-stop's fill bar;
   - otherwise the position is closed at the close after the holding period: each screen's `HOLD_BARS` (BTST 1, swing 10, 15–30 days 25, results 10) or the override. The time exit is never the entry session itself, so a BTST bought at the next open is sold at the following close;
   - anything still open on the period's last session is closed at its close ("Period end").
4. **Slots.** At most *max positions* open (pending next-open orders count), one position per stock across all screens. When more signals fire than there are free slots, they are taken by the screen's `score`, highest first. Scores of different screens are on different scales, so with several screens they are interleaved: each screen's best signal, then each screen's second best, and so on.
5. **Sizing.** Risk per trade = *risk %* × current equity (marked to market at the signal close). Quantity = risk ÷ (planned entry − stop), rounded down to **whole futures lots** (NSE lot file, `getLotSizes`) or to whole shares when lots are off or unknown; the result says which. A signal whose single lot risks more than the budget is skipped and counted. Total open notional is capped at equity × *max leverage* (default 4×; stock-futures margin is roughly 20–25% of notional).
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

- **Survivorship bias.** The universe is today's list (today's F&O stocks, today's Nifty 200). Stocks that were dropped, delisted or merged during the period are missing, and stocks added after strong runs are included. That flatters results.
- **Cash prices stand in for futures.** The futures basis (usually a small premium that decays to expiry) is ignored, as are rollover costs and slippage at monthly expiry. Positions held over an expiry would really be rolled: two more orders and a calendar spread.
- **Daily bars only.** Inside a session the order of high and low is unknown; that's why a bar touching both stop and target counts as the stop. Intraday entries and trailing stops can't be modelled.
- **About one year of history.** Roughly 250 sessions are stored. Most screens need 60–250 sessions of warm-up, so a backtest often covers only the last few months: one market phase. The panel shows the sessions, signals and trades behind every result.
- **Lot sizes are today's**, applied to the whole period; NSE revises them twice a year.
- **Delivery-based screens** need NSE delivery data, which exists only for completed sessions in the bhavcopy.

More history gives more reliable results. The data engine can fetch longer daily history (`dataEngine().history`, about 5 calls per symbol on Fyers Standard, see the budget section), but the backtester never triggers downloads; it uses what the screener has already stored.
