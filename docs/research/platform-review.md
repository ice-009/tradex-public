# Platform review: what the live terminal got wrong, and what other platforms do

Based on a screenshot of the live terminal on a MacBook: the "1 large + 2 small" BTST layout on HAL, running on the Fyers feed. Compared with TradingView, Zerodha Kite, Fyers, Chartink and StockEdge.

## Problems seen in the live terminal, worst first
1. **Labels collided with the legend and with each other.**
   - Plan labels avoided only a fixed 56 px strip, but a legend with two EMAs and pills is ~140 px tall.
   - Plan, pattern and S/R labels each avoided collisions only within their own group.
   - **Fixed:** the engine now gets the legend's and the toolbar's measured sizes. All labels share one placement list per frame; the plan claims space first, then pattern and S/R labels move or are skipped.
2. **Price-axis tags overlapped** (e.g. last price on a round tick, MACD tags on top of each other).
   - **Fixed, TradingView-style:**
     - tags are placed in priority order: last price fixed, then plan stop/target, then alerts and drawings;
     - later tags slide to the nearest free slot;
     - tick labels under a tag are hidden;
     - the plan's entry tag is dropped when it equals the last price.
3. **The same levels were drawn twice.** The pattern's breakout/stop/target lines duplicated the plan's.
   - **Fixed:** "level" lines are hidden while a plan is shown.
4. **The legend header was crowded** by the Patterns and setups pills.
   - **Fixed:** they're now toggles in the chart's top-right toolbar: a target icon with the setup count, and a patterns icon.
   - The toolbar is always visible (dimmed until hover). Narrow charts keep only those two; link, sync and snapshot show on the selected chart.
5. **The results badge read "399"**, counting every NSE company.
   - **Fixed:** it now counts only the open list plus screener ideas with results within 3 days.
6. **Linking the symbol across charts was manual.**
   - **Fixed:** a link button. Changing the symbol in one chart changes all of them; each keeps its timeframe.
7. **Touch:** indicator buttons were always on, which cluttered the legend.
   - **Fixed:** tap a legend row to reveal its buttons.

## What other platforms offer that matters for short-term trading

| Platform | Feature | Status here |
|---|---|---|
| TradingView | Price alerts with lines on the chart | **Added:** alerts from a plan (breakout / stop / target) or any price; dashed line with 🔔; toast, sound, and a system notification where allowed |
| TradingView | Symbol and interval sync between charts | **Added** (symbol); crosshair sync already existed |
| TradingView | Bar replay | Not yet: see the backlog |
| Zerodha Kite | GTT OCO (stop and target that cancel each other) | **Added:** an order ticket that turns a plan into entry + GTT OCO values, rounded to NSE ticks, with copy buttons. It places nothing. |
| Fyers | Order placement through its API | Not yet: it needs explicit confirmations and limits; see the backlog |
| Chartink | Custom scan formulas | Not yet: see the backlog |
| StockEdge | FII/DII, bulk/block deals | Not yet: no data source wired |
| All | Installable app on iPad / Mac | **Added:** web app manifest + icons; "Add to Home Screen" opens it full-screen |

## Order ticket details
- **Kite GTT OCO:** two triggers, a stop below and a target above the current price, each with its own trigger and limit price. When one fires the other is cancelled ([Zerodha support](https://support.zerodha.com/category/trading-and-markets/kite-features/gtt/articles/how-can-i-use-the-gtt-feature), *(search)*).
  - The stop leg's limit sits 0.5% below its trigger so it still fills in a fast fall.
  - The ticket tells you to add the GTT after the entry fills.
- **NSE tick sizes since 15 April 2025:**

  | Price | Tick |
  |---|---|
  | below ₹250 | ₹0.01 |
  | ₹250–1,000 | ₹0.05 |
  | ₹1,000–5,000 | ₹0.10 |
  | ₹5,000–10,000 | ₹0.50 |
  | ₹10,000–20,000 | ₹1 |
  | above ₹20,000 | ₹5 |

  Sources: [Fyers notice](https://fyers.in/notice-board/tick-size-revision-for-nse-derivatives-cash-segment-effective-april-15-2025/), [Angel One](https://www.angelone.in/news/market-updates/nse-revises-tick-size-for-stocks-and-indices-from-april-15-what-traders-need-to-know), *(search)*.
- **Rounding:** NSE sets each stock's band on review dates, so a stock that moved since can carry the neighbouring tick. Ticket prices are rounded to the tick **one band coarser**, because each tick divides the next one up. That price is valid in either band, at a cost of at most one tick. A unit check confirms this across ₹1–30,000 (`src/lib/ticks.ts`).

## Alerts details
- Alerts are checked against live ticks and a 30-second quote refresh **while the terminal is open**. End-of-day fallback prices never fire an alert.
- **iPad:** system notifications need the terminal added to the Home Screen as a web app (iPadOS 16.4+) and a tap to allow them ([OneSignal docs](https://documentation.onesignal.com/docs/ios-web-push), *(search)*). The in-app toast and sound work everywhere.

## Backlog (proposed, not built)
1. **Bar replay:** step a chart forward bar by bar from a past date to practise on past setups (engine: render a prefix of the bars).
2. **Server-side alerts**, so alerts fire with the terminal closed. This needs a background worker on the Fyers feed plus web push (VAPID keys, service worker).
3. **Fyers order placement** from the ticket. It needs explicit per-order confirmation, max-loss and daily-loss limits, and paper mode first.
4. **Custom scan builder** (Chartink-style): rules over the existing `Features` fields.
5. **Account sync** of watchlists, alerts and layouts: they live in each browser's storage today, so a Mac and an iPad each keep their own.
6. **FII/DII and bulk/block deals** from NSE reports, as context on the setup card.

## Day high / low feed (F&O cash + futures)
Code:
- `src/lib/highLowCore.ts`: pure detection and futures contract naming, unit-checked.
- `src/lib/highLow.ts`: the server scanner.
- `src/lib/quoteCache.ts`: the shared 10 s quote cache.
- `/api/highlow` and `src/terminal/HighLowPanel.tsx`: the API and the UI.

**How it works:**
- **Why polling:** Fyers' data socket tracks at most **200 symbols** ([Fyers support](https://support.fyers.in/portal/en/kb/articles/is-there-a-limit-to-the-number-of-symbols-i-can-track-using-the-data-websocket-in-api-v3), *(search)*). Cash plus near-month futures for the F&O list is ~436, so the scanner polls the quotes API instead.
  - It runs every 20 s, 50 symbols per request (~9 requests a cycle).
  - It only runs during market hours (plus one poll after 15:30) and while a terminal has asked in the last 90 s.
- **Shared quotes:** the watchlist reuses the same 10 s quote cache, so its quotes for those symbols cost no extra requests.
- **What counts as an event:** the first quote of the day is only a baseline. After that, an event fires whenever the exchange's running day high rises (or the low falls) since the last poll, so a break between polls is still caught. The "From 9:30" filter (on by default) hides the opening minutes, when nearly everything makes new extremes.
- **Futures contract:** `NSE:{SYMBOL}{YY}{MMM}FUT` ([Fyers symbology](https://fyers.in/api-docs/v3/api/appendix/symbology-format/), *(search)*). It uses the near month, rolling after the **last Tuesday**, which has been NSE's stock-derivatives monthly expiry since September 2025 ([HDFC Securities](https://www.hdfcsec.com/blog/details/changes-in-expiry-day-for-index-derivatives-on-bse-nse), *(search)*). If a contract stops quoting for 3 polls (e.g. expiry moved earlier for a holiday), that stock moves to next month's contract.
- **Default watchlist:** the full F&O list ("F&O stocks (all)") is created and opened once. Only rows on screen (± 5) and the charted symbol stream live ticks; the rest refresh every 20 s.


## Futures-only (stock futures, held at least overnight, no options)
- **Lot sizes:** from NSE's `fo_mktlots.csv`, found by header name (the `SYMBOL` column and the month columns), with Fyers' public `NSE_FO.csv` as a fallback. They're cached 12 h and on disk (`src/lib/lotSizes.ts`, parsers unit-checked). If neither loads, the ticket asks for the lot size.
- **Order ticket → futures:**
  - **Contract:** the near-month contract, or next month when expiry (last Tuesday) falls inside the setup's holding period.
  - **Product:** NRML, since MIS is squared off the same day.
  - **Levels:** the cash-chart levels shifted by the live basis (futures − cash).
  - **Size:** lots from your max loss. When one lot already risks more than the max loss, the ticket says so instead of rounding up.
  - **Exit:** a Kite GTT OCO on the contract. Kite supports NRML F&O GTTs, F&O triggers run until 3:40 PM, and one user reported a futures GTT stop that didn't fully exit ([Zerodha support](https://support.zerodha.com/category/trading-and-markets/kite-features/gtt/articles/how-can-i-use-the-gtt-feature), [Kite forum](https://kite.trade/forum/discussion/comment/51931/), *(search)*).
- **Setup card and Compare** size in lots.
- **Defaults:**
  - the screener runs on the F&O universe
  - the Day High/Low feed shows futures
  - the intraday layout is removed
  - the BTST note now says futures carry no delivery/auction risk, but the same overnight gap risk
