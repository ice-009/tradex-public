# Tradex Charts — layout presets: research notes

Code: `src/terminal/presets.ts`. There used to be 14 presets; they were cut to **two**, for **stock futures held at least overnight** (NRML, no options, no intraday): BTST (1–3 sessions) and swing (15–20 sessions).

**The rule:** every indicator has one job, and no two indicators on a chart do the same job.
- Chart patterns and support/resistance zones are drawn automatically on every chart (the Patterns toggle; see patterns.md), so no layout adds channels, pivots or extra level indicators.
- Volume bars are on by default on every chart.

Sources marked *(search)* were read through search-result summaries only. The remaining links were opened during the original preset research.

## 1. Swing · 15–20 days  (2 charts: Daily | Weekly)

| Chart | Indicator | Its one job | Source |
|---|---|---|---|
| Weekly | 30-week SMA (purple) | **Whether to trade at all.** Weinstein's stage analysis: buy only in stage 2, price above a *rising* 30-week MA (≈ the 150-day). Flat or falling = no long swing. | [Weinstein stage analysis summary](https://www.luxalgo.com/library/concept/weinstein-stage-analysis.md) *(search)*; Stan Weinstein, *Secrets for Profiting in Bull and Bear Markets* (1988) |
| Weekly | 10-week SMA | Shows the weekly pullback rhythm (≈ the 50-day): weekly closes holding above it keep the trend intact | Same |
| Daily | 50 SMA (amber) | **The trend you trade:** stay long above a rising 50-day. It's the Minervini Trend Template line (rule 5) and O'Neil's line | [ChartMill — Minervini Trend Template](https://www.chartmill.com/documentation/stock-screener/technical-analysis-trading-strategies/496-Mark-Minervini-Trend-Template-A-Step-by-Step-Guide-for-Beginners) |
| Daily | 20 EMA (blue) | **Entry and trail:** where 2–4 week pullbacks find buyers, and the line to trail the stop under | [Varsity — Moving Averages](https://zerodha.com/varsity/chapter/moving-averages/) (short-term EMAs for trades of a few sessions to weeks) |
| Daily | RSI 14 | **Regime check:** holding 40–80 confirms an up-trend; a break below 40 is the early warning. It isn't used as overbought/oversold, since RSI stays high in strong trends (Varsity). | [Varsity — Indicators Part 1](https://zerodha.com/varsity/chapter/indicators-part-1/) |
| Daily | Volume | **Proof:** breakouts on volume above the average (Varsity checklist: volume ≥ average) | [Varsity — The Finale](https://zerodha.com/varsity/chapter/finale-helping-get-started/) |

Dropped from the old swing presets: MACD and Stochastic. Both restate momentum the RSI and the MAs already show.

## 2. BTST · overnight  (3 charts: Daily large | stock 15m | NIFTY 15m)

| Chart | Indicator | Its one job | Source |
|---|---|---|---|
| Daily | 20 EMA + volume | **The setup:** an up-day closing near its high, above the 20 EMA, on volume clearly above average | Varsity MA + Finale |
| Stock 15m | VWAP | **Who controls the day:** above VWAP into the close = buyers in charge | [ChartSchool — VWAP](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/volume-weighted-average-price-vwap) |
| Stock 15m | Previous day's high/low | **The breakout level:** a close above yesterday's high is the BTST trigger the screener's closing-strength screen also uses | screeners.md (BTST screens) |
| NIFTY 15m | VWAP | **Don't fight the market overnight:** skip BTST longs when NIFTY is below its VWAP into the close | Same VWAP reasoning, applied to the index |

**Timing:** NSE's official close is the VWAP of the last 30 minutes, so decide between 3:00 and 3:25 PM ([Upstox](https://upstox.com/learning-center/demat-account/difference-between-ltp-and-closing-price/article-1565/)).

Dropped: MACD on 1h and the 9/21 EMA pair. The 20 EMA alone carries the short trend.

## Removed presets
Scalping, intraday, top-down intraday, index options, Elder triple screen, positional, long-term investing, trend following, momentum breakout, mean reversion and the SMC presets were all removed. No intraday layout is kept, because positions are carried overnight. Their indicators are still in the Indicators menu, and saved layouts are untouched.
