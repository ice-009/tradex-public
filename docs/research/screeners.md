# Screeners: BTST, swing (3–10 sessions), 15–30 day positional

Code: `src/lib/screener/screens.ts` (rules), `features.ts` (metrics), `dailyStore.ts` (data), `backtest.ts` (track record), `src/app/api/screener/route.ts` and `track/route.ts`. UI: `src/terminal/ScreenerPanel.tsx`, `SetupCard.tsx`, `screenerData.ts` (shared feed).

**These are mechanical filters.** Each screen's track record (below) replays its rules on the cached history, but that is a check, not a validated strategy. Each rule set comes from a published source below. Where a source gives a range, the stricter end is used. Nothing here is investment advice.

## Data

| Input | Source | Notes |
|---|---|---|
| Daily OHLCV, ~245 sessions | Fyers `/data/history` (resolution D), one request per stock, cached in `.cache/screener/daily/` | Fyers allows ~200 requests/min. The first scan of a universe downloads it once. |
| Daily extension + **delivery %** | NSE `sec_bhavdata_full_DDMMYYYY.csv` (one file per session, whole market), cached in `.cache/screener/bhav/` | Published in the evening. `DELIV_PER` is the % of traded quantity taken into delivery. |
| Corporate actions | NSE bhavcopy `PREV_CLOSE` is adjusted on ex-dates | If it disagrees with our stored close by more than 1.5%, that stock is re-downloaded from Fyers. |
| Today's forming candle | Fyers `/data/quotes`, 50 symbols per request | Overlaid during market hours until that day's bhavcopy is out. |
| Universes | niftyindices.com `ind_nifty{50,200,500}list.csv`; NSE `fo_mktlots.csv` | Snapshots in `data/universe/`. Indices rebalance twice a year, so refresh then. These are today's constituents, so results carry survivorship bias. |

Cross-check (4 Nov 2026): the screener showed BEL +4.71% with 49.9% delivery and TCS −2.52%, the same figures as NSE's bhavcopy.

## Market facts that shape the BTST screens

- **BTST risk.** In a BTST you sell shares before they reach your demat account. If your seller short-delivers, you short-deliver too, and the auction penalty can be up to 20% of the value. That's why the BTST screens require ₹10 cr+ average daily turnover. [Zerodha Support — BTST risk](https://support.zerodha.com/category/trading-and-markets/trading-faqs/articles/btst-risk)
- **When to run it.** NSE's official close is the volume-weighted average price of the last 30 minutes (3:00–3:30 PM), so a 3:00–3:25 PM scan sees a nearly settled close. This comes from a secondary source; NSE's own circular wasn't found. [Upstox — LTP vs closing price](https://upstox.com/learning-center/demat-account/difference-between-ltp-and-closing-price/article-1565/)
- **Why momentum is held overnight.** In US data, almost all of the abnormal return of momentum strategies is earned overnight rather than intraday, and transaction costs reduce that edge a lot. [Lou, Polk & Skouras (2019), JFE](https://personal.lse.ac.uk/polk/research/TugOfWar.pdf)

## BTST (overnight)

### Closing-strength breakout
Rules:
- Up ≥ 2% on the day.
- Close in the top 25% of the day's range (CLV ≥ 0.75).
- Volume ≥ 1.5× the 20-day average.
- Close above the previous day's high.
- Close > 20 EMA > 50 EMA.
- RSI(14) between 55 and 80.
- 20-day average turnover ≥ ₹10 cr.

Plan: stop at the day's low, capped at 1 ATR below entry; target 1.5R; exit next session.
Sources:
- Zerodha (liquidity and short-delivery risk).
- Lou/Polk/Skouras (overnight momentum).
- [Zerodha Varsity — The Finale](https://zerodha.com/varsity/chapter/finale-helping-get-started/): volume at least the 10-day average, risk:reward ≥ 1.5.

### 20-day high into the close
Rules:
- Close above the prior 20-session high.
- Up ≥ 1% on the day.
- CLV ≥ 0.7.
- Volume ≥ 1.5× the 20-day average.
- Close above the 50-day SMA.
- Close no more than 8% above the 20 EMA.
- Turnover ≥ ₹10 cr.

Sources:
- [Turtle rules](https://www.turtletrader.com/turtle-trading/) (20-day breakout).
- [George & Hwang (2004), J. Finance](https://doi.org/10.1111/j.1540-6261.2004.00695.x): nearness to the 52-week high predicts returns better than past returns do.

## Swing (3–10 sessions)

### Pullback to 25 EMA in an uptrend
Rules:
- 25 EMA > 50 EMA.
- Close > 200 SMA.
- Low within 1% of the 25 EMA in the last 3 sessions, and close back above it.
- RSI(14) between 40 and 60.
- Green, up day.

Plan: stop under the 5-session low, at most 2 ATR below entry; target 2R.
Source: [Varsity — Moving Averages](https://zerodha.com/varsity/chapter/moving-averages/) says 9/21 EMA suits trades of a few sessions and 25/50 EMA suits trades of a few weeks.

### Connors RSI(2) oversold
Rules:
- Close > 200-day SMA.
- RSI(2) ≤ 10. Connors found ≤ 5 gave better returns.

Exit: on a close above the 5-day SMA. Connors uses no stop; 2 ATR is shown only as a risk reference.
Source: [StockCharts ChartSchool — RSI(2)](https://chartschool.stockcharts.com/table-of-contents/trading-strategies-and-models/trading-strategies/rsi-2). The article says to enter just before the close or at the next open.

### NR7 squeeze in an uptrend
Rules:
- Today's high-low range is the narrowest of the last 7 sessions.
- Close above a 50 EMA that is rising compared with 5 sessions ago.

Plan: buy only on a break of today's high; stop at today's low; target 2R. An inside day is tagged.
Source: Toby Crabel (1990), *Day Trading with Short Term Price Patterns and Opening Range Breakout*. NR7 is a ranking of ranges, not a candle shape, so only completed bars count.

### Delivery-backed up-move (India-specific, uses the last completed session)
Rules:
- Delivery % ≥ 1.5× its 20-session average.
- Up ≥ 1.5% on the day.
- Volume ≥ 1.5× the 20-day average.
- CLV ≥ 0.6.
- Close above the 50 EMA.

Sources:
- [Zerodha — delivery % on Kite](https://support.zerodha.com/category/trading-and-markets/general-kite/kite-mw/articles/delivery-volume-percentage-on-kite).
- [Upstox — trade vs delivery volume](https://upstox.com/learning-center/online-trading/trade-volume-vs-delivery-volume/article-1714/): delivery % = delivery qty / traded qty × 100; compare it with the stock's own recent average.

The 1.5× threshold is a practitioner convention. I found no academic test of it.

### Bull flag, Reclaimed the 20-day average, Oversold bounce
These three come from the [Day Trader skill's `trader-scanner`](https://github.com/jakeschincariol/day-trader-skill/tree/main/trader-scanner) daily setups (MIT):
- **Bull flag**: up more than 10% over the 10 sessions before the last 5 (the pole), then the last 5 closes inside a 5% range (the flag), with the close above the 20-day SMA. Plan: buy-stop at the flag high, stop under the flag low (at most 2 ATR), target 2R.
- **Reclaimed the 20-day average**: yesterday's close below its 20-day SMA, today's above it. A close > 200 SMA filter was added so it stays a long-side, with-trend trade. Plan: stop under the 5-session low (at most 2 ATR), target 2R.
- **Oversold bounce**: RSI(14) below 30 yesterday and an up close today. Counter-trend. Plan: stop under the 3-session low (at most 1.5 ATR), target 1.5R.

The skill's 20-day closing-high breakout is already covered by *20-day high into the close* and *20-day breakout + ADX*.

## Results / news reactions

Code: the `results` group in `screens.ts`, event features in `features.ts` (`eventAgo`, `eventGapPct`, …), the calendar in `src/lib/resultsCalendar.ts`.

**What the research says.** Post-earnings-announcement drift (PEAD) is well documented in the US (Bernard & Thomas, 1989). The Indian evidence is mixed:
- An [IIM Bangalore study](https://repository.iimb.ac.in/handle/2074/17935) of NSE shares over 120 days found post-earnings drift.
- A [peer-reviewed study of 100 NSE firms, 2014–2018](https://journals.vutbr.cz/index.php/trends/article/view/541) found the market efficient to earnings news. It suggests the effect differs with liquidity.
- An [event study of 665 BSE-500 announcements, FY2007–12](https://eprints.nottingham.ac.uk/26569) found the market efficient to *good* news but saw a negative drift for over a week after *bad* news.

So these screens are built from the **price and volume reaction itself**, and their track record is shown next to them. Nothing assumes the drift exists.

**Event day.** A gap of at least 4% (either way) on at least 3× the 50-day volume. That usually means results or other news. The thresholds sit in the middle of what Episodic Pivot write-ups use: gaps from "several percent" to 8–10%+, volume 2–4× average. See [Tradingsim's EP explainer](https://tradingsim.com/blog/episodic-pivot-power-earnings-gap-buyable-gap-up-explained/); Stockbee's own pages weren't reachable for this write-up.

### Results gap-up (episodic pivot)
Rules:
- Gap up ≥ 4% at the open, on volume ≥ 3× the 50-day average.
- Closes in the top half of the range and above yesterday's high.
- Close ≥ open − 1%.
- Turnover ≥ ₹10 cr.

Plan: stop under the gap day's low (at most 2 ATR); target 2R; hold up to 10 sessions.

### Post-results drift
Rules:
- A gap-up event 2–10 sessions ago.
- The stock has never traded below the event day's low since, and is at or above the event day's close.
- Close above the 50 EMA.
- Turnover ≥ ₹10 cr.

Plan: stop under the event day's low (at most 2.5 ATR); target 2R.

### Bad-news warning (not a screen)
Long-only, so the negative drift after bad news is used as a **caution**. Any setup on a stock that gapped down ≥ 4% on ≥ 3× volume in the last 10 sessions (or today) shows a warning on its setup card.

### Results calendar (best-effort)
- Source: `https://www.nseindia.com/api/event-calendar`, an undocumented endpoint used by open-source NSE wrappers. The server loads the NSE home page for cookies first, keeps rows whose purpose mentions results, and caches for 6 h (30 min after a failure).
- It's used to show "Results in N days" and to warn when a plan would be held into the announcement.
- If NSE refuses the request, the calendar says so. The Results screens don't depend on it.
- It couldn't be tested from the development container, which has no access to nseindia.com. The response parser was checked against the field names the wrappers document: `symbol`, `company` / `sm_name`, `purpose` / `bm_purpose` / `bm_desc`, `date` / `bm_date`.

## 15–30 days (positional)

### Minervini Trend Template
All 8 must pass:
1. Close above the 150-day and 200-day SMA.
2. 150-day SMA above the 200-day SMA.
3. 200-day SMA rising for at least 1 month (22 sessions).
4. 50-day SMA above the 150-day and 200-day.
5. Close above the 50-day SMA.
6. Close ≥ 30% above the 52-week low.
7. Close within 25% of the 52-week high.
8. RS rank ≥ 70.

Source: Mark Minervini, *Trade Like a Stock Market Wizard* (2013). Rules cross-checked with [ChartMill's write-up](https://www.chartmill.com/documentation/stock-screener/technical-analysis-trading-strategies/496-Mark-Minervini-Trend-Template-A-Step-by-Step-Guide-for-Beginners). Some secondary sources use 25% instead of 30% for rule 6; the book's 30% is used.

**RS rank caveat:** IBD's RS Rating is proprietary. Here it is approximated as 0.4×3-month + 0.2×6-month + 0.2×9-month + 0.2×12-month return, then ranked as a percentile **within the scanned universe**, not the whole market.

### Near 52-week high, beating Nifty
Rules:
- Within 5% of the 52-week high.
- 6-month return beats NIFTY 50.
- Close > 50 SMA > 200 SMA.
- Turnover ≥ ₹5 cr.

Source: George & Hwang (2004). A later international-index study disputes part of their conclusion.

### Base breakout on volume (O'Neil / IBD)
Rules:
- Close above the 30-session base high (the pivot), but no more than 5% above it.
- Base depth ≤ 25%.
- Volume ≥ 1.4× the 50-day average.
- Close > 50 SMA > 200 SMA.

Plan: sell if price falls 8% below entry; target 3R.
Sources:
- IBD reprint ([inkl](https://inkl.com/news/how-finding-a-breakout-can-help-you-achieve-maximum-gains)): breakout volume 40–50% above the 50-day average; buy zone up to 5% above the pivot.
- [MarketSmith India](https://blog.marketsmithindia.com/?p=3317) (O'Neil's Indian affiliate): sell if 8% below the purchase price. Some IBD articles say 7%.

### 20-day breakout + ADX trend
Rules:
- Close above the prior 20-session high.
- ADX(14) ≥ 25.
- +DI above −DI.

Plan: stop 2N (2 × ATR20); exit on a close below the 10-session low (Turtle System 1).
Sources: [Turtle rules](https://www.turtletrader.com/turtle-trading/); [Varsity supplementary notes](https://zerodha.com/varsity/chapter/supplementary-notes-1/) (ADX > 25 is a strong trend, below 20 a weak one).

## Track record (replay of past signals)

`backtest.ts` adapts the Day Trader skill's [Time Machine](https://github.com/jakeschincariol/day-trader-skill/tree/main/trader-timemachine) ("every past time the setup fired") to daily bars. Its Monte Carlo replays are not ported.
- For each of the last 160 sessions, features are recomputed for every stock as of that day. RS is ranked across the universe that day and NIFTY's 6-month return is taken as of that day. Then every screen's rules run.
- Each signal's plan is walked forward bar by bar for its holding period: BTST 1 session, swing 10, positional 25.
  - A bar that touches both the stop and the target counts as the stop.
  - A gap through a level fills at the open, not at the level.
  - A buy-stop entry (NR7, bull flag) needs the next session to trade through it, or the signal is skipped.
  - Anything still open at the end is marked to the close.
- **Verdict.** For fixed-R plans the share of signals that hit the target first is compared with break-even, 1 / (1 + R): 40% at 1.5R, 33% at 2R, 25% at 3R.
  - Within 5 points of break-even: "Close to break-even". 5–15 points: "Leans toward". 15 or more: "Strongly toward".
  - If more than 40% of trades were still open at the horizon, or the plan trails (no fixed target), it judges by average R instead.
  - Fewer than 20 signals: "too few to judge".
- Results are cached per universe and last session (`/api/screener/track`). A replay of Nifty 200 takes about 5 s once.

## Position sizing (setup card)

From the Day Trader skill's `trader-budget` / `trader-risk`: the stop decides the size.
- Quantity = floor(capital × max-loss % ÷ (entry − stop)), capped by what the capital can buy.
- The card shows the loss at the stop and the gain at the target.
- R:R under 1.5 is flagged, following Varsity.

## Known limitations
- **Replay, not a backtest of a strategy.** No costs, slippage or overlapping-position limits. 160 sessions is one market regime. The universe is today's members.
- **Survivorship bias.** Universes are current constituents.
- **Long side only.** Short-side versions (e.g. STBT) only work for F&O stocks and are not built.
- **Circuit limits.** Price-band data isn't available, so stocks locked at upper circuit aren't excluded. That matters for BTST: Zerodha forum users report failed auctions on upper-circuit stocks.
- **Live volume.** During market hours, today's volume is still partial, so volume ratios read low before about 3 PM.
