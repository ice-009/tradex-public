# Automatic chart patterns, support/resistance and plan levels

Code: `src/chart/patterns.ts` (detection + drawing), the `patterns` indicator in `src/chart/indicators.ts`, the `Patterns` legend toggle (`src/terminal/ChartCell.tsx`). The screener uses the same detector through `computeFeatures` (`src/lib/screener/features.ts`), the "Near pattern breakout" / "Chart-pattern breakout" screens (`screens.ts`) and `chartPlan()`.

**Source status.** Several primary sites (thepatternsite.com, Stockbee, huggingface.co) were blocked from the development environment. Sources marked *(search)* were read through search-result summaries only, not opened. Treat their numbers as approximate.

## What the evidence says
- **Patterns carry some information, not certainty.** Lo, Mamaysky & Wang (2000), *Foundations of Technical Analysis*, J. Finance 55(4) 1705–1765 ([NBER WP 7613](https://www.nber.org/system/files/working_papers/w7613/w7613.pdf), *(search)*), detected patterns automatically with kernel regression on US stocks, 1962–96. Several patterns appeared to add incremental information. Double tops/bottoms and head-and-shoulders were the most common.
- **Support/resistance levels matter.** Osler, *Support for Resistance* (FRBNY Economic Policy Review, July 2000, [PDF](https://resources.newyorkfed.org/medialibrary/media/research/epr/00v06n2/0007osle.pdf), *(search)*), found that published S/R levels helped predict where intraday FX trends stopped. The data is FX, not Indian stocks. We use the idea, not her numbers.
- **Random walks make patterns too.** Checking this detector against 400 simulated random walks (geometric, ±1.5% daily), it first found a "pattern" in ~60% of them. After the tightening below, it finds one in ~16%, and 3.8% reach quality ≥ 80. Real NSE data hasn't been measured; the screener's track record replay is the real test.

## How the detector works
1. **Swings:** an ATR-scaled ZigZag. A new swing needs a reversal of `swingAtr` × ATR(14), default 2, so pivots adapt to each stock's volatility.
2. **S/R zones:** pivot prices clustered within 0.5 ATR (min 0.4% of price). Two or more touches make a level. The chart shows the nearest two above and below.
3. **Patterns** are judged on the most recent pivots. Every pattern has a **breakout**, a **stop** under the structure (minus 0.25 ATR) and a **measured-move target**: the pattern height added to the breakout. That's the measure rule described by ChartSchool and Bulkowski *(search)*.

| Pattern | Rule used here | Notes / source |
|---|---|---|
| Ascending triangle | ≥ 2 pivot highs flat (within ~0.9 ATR), ≥ 2 rising pivot lows | Target = widest part added to the breakout ([S&C article](https://technical.traders.com/tradersonline/display.asp?art=1096), *(search)*) |
| Symmetrical triangle | Falling highs and rising lows | Direction comes from the break; only an upside close counts here |
| Descending triangle | Flat lows, falling highs | Reported as **bearish**: a −5 penalty in the score, never a long setup |
| Rectangle / box | Flat highs and flat lows, 3–20% deep | Darvas: buy above the box top, stop at the box bottom ([summary](https://www.sharescope.co.uk/sharescope_tutorial33.jsp), *(search)*) |
| Double bottom | Two lows within 3%, ≥ 10 bars apart; a ≥ 8% (and ≥ 2.5 ATR) rally between; ≥ 15% decline into the first low over the 60 bars before | [ChartSchool](https://chartschool.stockcharts.com/table-of-contents/chart-analysis/chart-patterns/double-bottom-reversal) *(search)*: completes on a close above the peak between the troughs, needs a prior downtrend. The 3% tolerance is a practitioner convention I couldn't source. |
| Bull flag | Pole ≥ 3.5 ATR in ≤ 15 bars; 4–15 bar pullback giving back 10–50%; flag volume < 90% of pole volume | Target = pole height added to the breakout |
| VCP | ≥ 2 pullbacks, each ≤ 0.75× the previous; the first ≥ 8%, the last ≤ 10%; last-contraction volume < 85% of the first; uptrend (close > rising 50 SMA) | Minervini, *Trade Like a Stock Market Wizard*. The thresholds come from community write-ups ([LuxAlgo](https://www.luxalgo.com/library/concept/volatility-contraction-pattern.md), *(search)*), which call them guidelines, not rules. |
| Cup with handle | Rims within 5%, 12–35% deep, 30–150 bars, bottom in the middle half, ≥ 15% of the bars in the lowest third (rounded, not a V), handle ≤ ⅓ of the cup depth | Bulkowski *(search)*: handles shorter than the median ~22 days did better. Target = cup height added to the rim. |

**Tightening against false positives.** Each of these rules cut detections on random walks while every synthetic test pattern still passed:
- the double bottom's prior-decline and rally rules
- VCP volume dry-up made mandatory
- cup rounding and handle required
- flag volume made mandatory

**Quality (0–100)** comes from:
- number of touches, and tightness
- volume behaviour: lighter in the base, ≥ 1.4× the 50-day average on the breakout
- trend alignment
- −25 when the price is already more than one pattern height past the breakout

**Status** is *forming* (below the breakout), *breakout* (closed above it in the last 5 bars), or *extended*, which isn't drawn and isn't a setup.

## Plan levels
- **Stop:** under the pattern, capped at 8% below entry. That's the O'Neil/MarketSmith sell rule already used by the positional screens. Generic plans use at least 1 ATR, since a tighter stop sits inside daily noise, and at most 3 ATR.
- **Target:** the measured move, at least 1.5R. Generic plans target the next resistance if it pays ≥ 1.5R, else 2R.
- **Resistance in the way:** if an S/R zone sits between entry and target, the setup card says so, and the score uses R:R to that resistance.
- **Trailing stop:** the chandelier exit, the 22-day high minus 3 × ATR(22) ([StockCharts ChartSchool](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/chandelier-exit), *(search)*). It's Chuck LeBeau's exit, popularised by Alexander Elder. This uses the rolling 22-bar version, not the since-entry version.

## Screens
- **Near pattern breakout** (Swing): a forming bullish pattern with quality ≥ 70, the close within 3% below the breakout, and the close above the 50 SMA. The plan is a buy-stop at the breakout, so the replay skips signals that never trigger.
- **Chart-pattern breakout** (15–30 days): broke out today or yesterday, quality ≥ 65, still within 5% of the breakout, volume ≥ 1.3× its 20-day average, close above the 50 SMA.

Both get the track-record replay like every other screen. On the synthetic development data their results mean nothing. Judge them on the replay once real Fyers history is cached.
