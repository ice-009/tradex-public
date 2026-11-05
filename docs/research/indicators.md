# Tradex Charts — indicator research notes

Implementation: `src/chart/indicators.ts` (31 indicators). Numerics follow TradingView's
built-ins (Pine `ta.*`) where platforms differ, because that is what Indian traders compare
against (Kite/TradingView charts). Every URL below was opened during this research. URLs I
could not open are listed under "Not verified" at the end.

Conventions used everywhere:
- **RMA** (Wilder smoothing) = `(prev·(n−1) + x)/n`, seeded with the SMA of the first n values (same as Wilder's running sum ÷ n).
- **EMA** α = 2/(n+1), seeded with an SMA.
- **True range** = max(H−L, |H−Cprev|, |L−Cprev|). The first bar uses H−L in ATR/Supertrend/Keltner (`ta.tr(true)`) and is NaN in DMI (`ta.tr`).
- **Session** = IST calendar day (UTC+5:30, no DST). Intraday is detected from the data: at least two bars share an IST day. Daily Fyers bars are stamped at UTC midnight (05:30 IST), so each one is its own day.

---

## Levels (session-based) — the Indian intraday toolkit

All of these take the **previous period's** H/L/C and hold the level flat for the whole current
period. On intraday charts that means the previous trading session in the data, so weekends and
holidays are skipped. On daily and higher charts it means the previous bar, per the layout
contract. The first period in the data is NaN. Rendering uses the `levels` style: one flat segment
per day, broken between days, with a small label at the left end.

Note: Zerodha/ChartIQ and StockCharts switch the reference period by timeframe:
1–15m uses the previous day, 30m–1h the previous week, daily the previous month, and weekly or
monthly the previous year. We use the previous day on every intraday timeframe, which is how most
Indian intraday traders use CPR and pivots, and the previous bar on daily and up (contract).
Weekly and monthly anchoring would be a possible future option.

### CPR — Central Pivot Range (`cpr {}`) — Popular in India
- P = (H + L + C)/3, BC = (H + L)/2, TC = (P − BC) + P = 2P − BC.
- TC comes out below BC when C < (H+L)/2. The chapter does not say what to do then; in the
  comments the author notes the two can sit either way. We output `tc = max`, `bc = min` so `tc` is
  always the top edge, the convention used by most CPR scripts.
- Usage (Varsity): price above TC is a bullish bias, so buy pullbacks to TC; price below BC is
  bearish, so short pullbacks to BC; inside the CPR is a range. Width matters: a narrow CPR (after a
  sideways day) suggests a trending day, a wide CPR (after a trending day) suggests a range. In
  Varsity's words, "higher the trend, wider is the CPR".
- Popularised by Frank Ochoa ("Secrets of a Pivot Boss"). That attribution is common knowledge; I
  did not open the book.
- Sources: https://zerodha.com/varsity/chapter/the-central-pivot-range/ ·
  https://support.zerodha.com/category/trading-and-markets/charts-and-orders/charts/articles/how-are-pivot-points-derived-while-using-the-cpr
  (the Zerodha support page also gives Kite's R1–R3/S1–S3 and a worked SBIN example showing the levels come from the previous day's candle).

### Classic / floor pivots (`pivots {}`) — Popular in India
- P = (H+L+C)/3; R1 = 2P − L; S1 = 2P − H; R2 = P + (H−L); S2 = P − (H−L);
  R3 = 2P + (H − 2L) (= H + 2(P−L)); S3 = 2P − (2H − L) (= L − 2(H−P)). These are TradingView's "Traditional" formulas.
- Note: Zerodha's support page gives R3 = P + 2(H−L) and S3 = P − 2(H−L), which differ slightly. We follow TradingView/StockCharts.
- R3 and S3 are excluded from price autoscale (`noAutoscale`) so they don't squash the candles on intraday charts.
- Sources: https://www.tradingview.com/support/solutions/43000521824-pivot-points-standard/ ·
  https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/pivot-points
  (StockCharts covers the origin with floor traders, the timeframe-to-period mapping, and Fibonacci/DeMark variants).

### Camarilla (`camarilla {}`) — Popular in India
- Levels are C ± 1.1·(H−L)/k with k = 12, 6, 4, 2 for levels 1 to 4. Outputs are `r4, r3, s3, s4`, labelled H4/H3/L3/L4 (the traditional names).
- Usage: H3/L3 are fade (reversal) levels and H4/L4 are breakout levels. This is practitioner lore, not from an opened source.
- Attributed to Nick Stott (1989). Not verified from a primary source.
- Source: https://www.tradingview.com/support/solutions/43000521824-pivot-points-standard/ (Camarilla section).

### Previous day high/low/close (`pdhl {}`) — Popular in India
- PDH, PDL and PDC are the previous session's high, low and close (on daily charts, the previous bar). PDC is drawn dashed.
- These come from the same previous-period data the pivot sources describe. There is no separate source because the definition is trivial.

### Opening range (`orb {minutes: 15}`) — Popular in India
- The range is the high/low of every bar whose open time is before session start + N minutes, where session start is the first bar of the IST day (09:15 on NSE). Values are NaN on the range bars themselves and while the range is still forming. They are plotted from the first bar after the range. On bars longer than N minutes, the first bar is the range. NaN on daily+ charts.
- Usage: a breakout above ORH or below ORL is the trigger, usually confirmed by a candle close.
  The most common windows on NSE are 15 and 30 minutes.
- Source: https://www.marketcalls.in/nifty-technicals/15-minute-opening-range-breakout.html
  (Rajandran R / Marketcalls, an Indian practitioner site). I found no Varsity chapter on ORB.

---

## Trend

### Supertrend (`supertrend {period: 10, factor: 3}`) — Popular in India
- Basic bands: hl2 ± factor·ATR, where ATR is the RMA.
- Final upper band = basic upper if (basic upper < previous final upper) or (previous close > previous final upper), otherwise the previous final upper. The lower band is the mirror image.
- Direction flips up on a close above the final upper band and down on a close below the final lower band.
- To match `ta.supertrend` exactly, the first bar with an ATR starts in a **downtrend**. The previous implementation started in an uptrend; that is fixed.
- Defaults: TradingView uses 10/3. **Kite's default is 7/3**, and Varsity suggests keeping the multiplier between 3 and 4. The contract key keeps 10/3.
- Usage (Varsity): green line under price means long, with the line as a trailing stop; red means the reverse. Works best in trending markets.
- Sources: https://www.tradingview.com/support/solutions/43000634738-supertrend/ · https://zerodha.com/varsity/chapter/supplementary-notes-1/

### Parabolic SAR (`psar {start: .02, increment: .02, max: .2}`)
- Wilder (1978). Rising SAR = prior SAR + AF·(EP − prior SAR). AF starts at 0.02, rises by 0.02 on each new extreme and is capped at 0.20. A rising SAR cannot sit above the prior two lows (a falling SAR cannot sit below the prior two highs). On penetration the SAR flips to the extreme point.
- Initialisation and reversal bookkeeping replicate Pine's `ta.sar` reference implementation (from memory of the Pine reference; the page itself is JS-rendered and didn't load).
- Test invariant: every dot is outside its bar's range.
- Drawn as dots.
- Source: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/parabolic-sar

### Ichimoku (`ichimoku {conversion: 9, base: 26, spanB: 52, displacement: 26}`)
- Goichi Hosoda, 1969.
- Lines: Tenkan = (HH9 + LL9)/2; Kijun = (HH26 + LL26)/2; Senkou A = (Tenkan + Kijun)/2; Senkou B = (HH52 + LL52)/2; Chikou = close.
- Shifts: StockCharts and TradingView describe the spans as plotted "26 periods ahead" and the Chikou "26 back". Like TradingView's built-in code (offset `displacement − 1`), we shift by **25 bars**, counting the current bar as the first of 26. This is the source of the classic off-by-one disagreement between platforms.
- Implemented through `OutputDef.offset`. Forward-shifted spans draw into the empty area right of the last bar, and the legend shows the value plotted at the crosshair bar.
- The cloud is green where Span A ≥ Span B and red otherwise, split exactly at crossovers.
- Sources: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/ichimoku-cloud ·
  https://www.tradingview.com/support/solutions/43000589152-ichimoku-cloud/ ·
  https://indie-script.github.io/indicators/trend/built-in/Ichimoku%20Cloud/ (a port of the TradingView built-in showing `offset=displacement - 1` for the spans, `-displacement + 1` for the lagging span, and defaults 9/26/52/26).

### ADX / DMI (`adx {length: 14}`) — Popular in India
- Wilder (1978).
- +DM = H − Hprev if that exceeds Lprev − L and is positive, else 0. −DM is the mirror image.
- TR, +DM and −DM are smoothed with the RMA (Wilder's running sum gives identical ratios). +DI = 100·+DM/TR and −DI = 100·−DM/TR.
- DX = 100·|+DI − −DI| / (+DI + −DI). ADX = RMA14(DX).
- Usage (Varsity): ADX above 25 is a strong trend, below 20 is weak (pane levels 20 and 25). Buy when +DI crosses above −DI with ADX above 25, and the reverse for sells.
- **Verified against StockCharts' worked spreadsheet** (QQQQ Jul–Aug 2010): +DI/−DI match to within ±0.12 on the 2-dp prices. ADX is 20.96 / 20.35 / 20.39 on 17, 18 and 19 Aug.
  The sheet prints its first ADX one bar early as the mean of only 13 DX values. From the next bar on, Wilder smoothing makes it identical to the 14-DX seed that TradingView and this code use.
- Sources: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/average-directional-index-adx · https://zerodha.com/varsity/chapter/supplementary-notes-1/

### Hull MA (`hma {length: 9}`)
- Alan Hull: WMA(2·WMA(n/2) − WMA(n), √n). Hull wraps both n/2 and √n in Integer(), so we floor them.
- TradingView's default length is 9.
- Sources: https://alanhull.com/hull-moving-average · https://www.tradingview.com/support/solutions/43000589149-hull-moving-average/

### VWMA (`vwma {length: 20}`)
- Σ(C·V)/ΣV over n (TradingView `ta.vwma`).
- Falls back to the SMA when the window has no volume (NSE indices).
- Source: https://www.tradingview.com/support/solutions/43000592293-volume-weighted-moving-average-vwma/ (its formula is an image; the text confirms close weighted by volume).

### Aroon (`aroon {length: 14}`, extra)
- Tushar Chande, 1995. Up = 100·(n − bars since the n-period high)/n, and Down likewise for the low. Window is n+1 bars (TradingView).
- Defaults: StockCharts uses 25; **Kite uses 14** (per Varsity), which is ours.
- Varsity rule: Up > 50 with Down < 30 is bullish.
- Sources: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/aroon · https://zerodha.com/varsity/chapter/supplementary-notes-1/

### SMA / EMA / WMA
These were unchanged, and their standard definitions were not separately re-sourced. EMA is SMA-seeded with α = 2/(n+1).

---

## Momentum

### RSI (`rsi {length: 14}`)
- Wilder (1978): 100 − 100/(1 + RMA(gain)/RMA(loss)). Levels 70/30.
- **Verified against StockCharts' RSI spreadsheet** (QQQQ Dec 2009 – Feb 2010, rows 15–33: 70.53 … 37.77).
  All 19 values match to within 0.1 using the 2-dp closes shown. The sheet uses unrounded prices (its 23-Dec change is 0.33; the 2-dp closes give 0.32), and that accounts for the ~0.07 residual.
- Source: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/relative-strength-index-rsi

### MACD (`macd {fast: 12, slow: 26, signal: 9}`)
- Gerald Appel, late 1970s: EMA12 − EMA26, signal = EMA9 of MACD, histogram = MACD − signal.
- Source: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/macd-moving-average-convergence-divergence-oscillator

### Stochastic (`stoch {k: 14, smooth: 3, d: 3}`)
- George Lane, late 1950s. Full stochastic: %K = SMA_smooth(100·(C − LL)/(HH − LL)), %D = SMA_d(%K). Defaults (14,3,3), levels 80/20.
- Source: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/stochastic-oscillator-fast-slow-and-full

### Stochastic RSI (`stochrsi {rsiLength: 14, stochLength: 14, k: 3, d: 3}`)
- Chande & Kroll, *The New Technical Trader* (1994): (RSI − LL_RSI)/(HH_RSI − LL_RSI).
- The original is scaled 0–1 with 0.8/0.2 levels. Like TradingView's built-in, we scale to 0–100 and smooth with SMA K=3 and D=3, giving levels 80/20.
- Sources: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/stochrsi · https://www.tradingview.com/support/solutions/43000502333-stochastic-rsi-stoch-rsi/ (K=3, D=3 defaults)

### CCI (`cci {length: 20}`)
- Donald Lambert, *Commodities* magazine, 1980: (TP − SMA20(TP)) / (0.015 · mean absolute deviation), where TP = hlc3.
- The 0.015 constant puts about 70–80% of readings inside ±100. Levels −100, 0, 100.
- Source: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/commodity-channel-index-cci

### Williams %R (`willr {length: 14}`)
- Larry Williams: (HH − C)/(HH − LL)·(−100). Range −100 to 0; −20 is overbought, −80 oversold.
- Written internally as 100·(C − HH)/(HH − LL) to avoid −0.
- Source: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/williams-r

### ROC (`roc {length: 12}`, extra)
- 100·(C − C[n])/C[n]. StockCharts default is 12 (TradingView uses 9).
- Source: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/rate-of-change-roc-and-momentum

---

## Volatility

### Bollinger Bands (`bb {length: 20, mult: 2}`)
- John Bollinger: SMA20 ± 2σ. We use population σ, matching TradingView's `ta.stdev`. StockCharts doesn't state which σ it uses.
- Source: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/bollinger-bands

### Keltner Channels (`keltner {length: 20, mult: 2, atrLength: 10}`)
- Modern version (Linda Raschke, 1980s): EMA20 ± 2·ATR10.
- Chester Keltner's 1960 original (*How to Make Money in Commodities*) used a 10-day SMA of the typical price, with a 10-day average of H−L for the band width.
- Source: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/keltner-channels

### Donchian Channels (`donchian {length: 20}`)
- Richard Donchian: upper = HH20, lower = LL20 (including the current bar), basis = the midpoint.
- Source: https://www.tradingview.com/support/solutions/43000502253-donchian-channels-dc/

### ATR (`atr {length: 14}`)
- Wilder (1978): first ATR = mean of the first 14 TRs, then (prev·13 + TR)/14.
- Wilder also often used 8. Varsity: use ATR to size volatility stops.
- Sources: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/average-true-range-atr · https://zerodha.com/varsity/chapter/supplementary-notes-1/

---

## Volume

### VWAP (`vwap {}`) — Popular in India
- Session-anchored (IST day): Σ(hlc3·V)/ΣV.
- Usage (Varsity): intraday only. Price above VWAP means bullish intraday bias, below means bearish. Ignore the jump at 9:15. A long below VWAP or a short above it is good execution.
- NSE indices have zero volume. The old code then plotted raw hlc3 per bar, which made a jagged line. It now falls back to the session's equal-weighted average of hlc3 (a TWAP).
- TradingView's optional σ bands were not added. The bands should be the std-dev of prices around VWAP since the anchor, and the exact formula wasn't confirmable from the help page.
- Sources: https://zerodha.com/varsity/chapter/supplementary-notes-1/ · https://www.tradingview.com/support/solutions/43000502018-volume-weighted-average-price-vwap/

### OBV (`obv {}`)
- Joe Granville (1963): add volume on an up close, subtract it on a down close, unchanged on a flat close.
- StockCharts starts the series at the first bar's volume; we start at 0 (as TradingView effectively does). The difference is a constant offset, and only the slope matters.
- Source: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/on-balance-volume-obv

### MFI (`mfi {length: 14}`)
- Quong & Soudack: raw money flow = TP·V. It is positive when TP rises, negative when it falls, and ignored when unchanged.
- MFI = 100 − 100/(1 + ΣPMF/ΣNMF). Levels 80/20 (90/10 for extremes). Bounded 0–100.
- NaN when the window has no volume (indices).
- Source: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/money-flow-index-mfi

### Chaikin Money Flow (`cmf {length: 20}`, extra)
- Marc Chaikin: Σ(((C−L) − (H−C))/(H−L)·V) / ΣV over 20. NaN without volume.
- Source: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/chaikin-money-flow-cmf

### Elder Force Index (`force {length: 13}`, extra)
- Alexander Elder (*Trading for a Living*): EMA13 of (C − Cprev)·V.
- Source: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/force-index

---

## Not verified / caveats
- **Pine Script reference pages** (`tradingview.com/pine-script-reference/v6/`) render client-side, and WebFetch got no content. The `ta.supertrend`, `ta.sar` and `ta.dmi` step-by-step semantics come from my knowledge of those reference implementations. They are cross-checked against the TradingView Help Center (Supertrend), StockCharts (PSAR rules) and StockCharts' ADX spreadsheet (matched).
- The StockCharts **Donchian** page returned 404, so I used TradingView's Donchian page instead.
- I found no **Varsity ORB chapter**. The ORB definition comes from the Indian practitioner site Marketcalls.
- **Camarilla's** attribution to Nick Stott and **CPR's** to Frank Ochoa come from general knowledge, not from opened primary sources.
- I could not download the StockCharts spreadsheet files (`/files/…` returned 404). The worked values above were transcribed from the spreadsheet screenshots embedded in the RSI and ADX ChartSchool articles.
