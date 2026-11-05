# Smart Money Concepts (SMC) indicator

Code: `src/chart/smc.ts` (detection), `src/chart/annotations.ts` (drawing), registered as `smc` in `src/chart/indicators.ts`. In-app lesson: `src/terminal/SmcGuide.tsx`. SMC layouts are `smc-*` in `src/terminal/presets.ts`.

**What it's modelled on.** INDmoney's charts are TradingView-based. The most widely used SMC overlay there is LuxAlgo's open-source *Smart Money Concepts* ([TradingView script page](https://www.tradingview.com/script/CnB3fSph-Smart-Money-Concepts-LUX/)). It shows:
- internal and swing BOS/CHoCH
- HH/HL/LH/LL swing labels
- bullish and bearish order blocks, which disappear once mitigated
- fair value gaps with an automatic threshold
- equal highs and lows
- premium, equilibrium and discount zones
- strong and weak highs and lows

That script is licensed CC BY-NC-SA, so **none of its code is used**. Tradex implements the concepts independently, using the rules below.

## Detection rules (Tradex implementation)

| Element | Rule | Default |
|---|---|---|
| Swing point | Bar `j` is a swing **high** when its high is above every high of the next `L` bars, which starts a down-leg. A swing **low** is the mirror. Confirmation therefore lags by `L` bars. | Swing structure L = 50, internal L = 5 |
| HH / LH / HL / LL | Each new swing high is compared with the previous one: higher → HH, lower → LH. Lows likewise give HL or LL. | Swing structure only |
| BOS | A **close** beyond the last unbroken swing point, in the same direction as the current structure trend. | |
| CHoCH | The first close beyond the last swing point **against** the current trend, which flips the trend. | |
| Internal vs swing | Internal = 5-bar swings, drawn dashed. Swing = 50-bar swings, drawn solid. An internal break at the same price as a swing level is drawn only once, as swing. | |
| Order block | On a bullish break, the candle with the lowest low between the broken swing high and the break bar. Bearish is the mirror (highest high). Candles with range ≥ 2 × ATR(200) use their high and low swapped, so one huge candle doesn't make an oversized block. | Nearest 2 unmitigated per side of price (swing + internal, overlaps merged) |
| Mitigation | A bullish OB is removed once any later low trades below its bottom. Bearish: any later high above its top. | |
| Fair value gap | Bullish: `low[i] > high[i-2]`, the middle candle closes above `high[i-2]`, and its body % exceeds 2 × the running mean body %. Bearish is the mirror. Removed once price trades through it. | Off by default; when on, nearest unfilled gap per side |
| EQH / EQL | Two consecutive 3-bar swing highs (or lows) within 0.1 × ATR(200) of each other. | Latest 2 |
| Display mode | Default **present** view: latest 3 swing + 3 internal breaks, latest 4 HH/HL labels, nearest zones. "Show full history" draws everything. | Present |
| Premium / discount | Range = trailing swing high to trailing swing low. Premium band = top 5% of the range, equilibrium = 47.5–52.5%, discount = bottom 5%. | |
| Strong / weak | In a bullish swing trend the trailing low is the **Strong Low** and the high is the **Weak High**, which is the likely target. A bearish trend flips this. | |

Checked on cached daily data for RELIANCE, BEL and TCS:
- No surviving bullish OB was ever traded through after it formed.
- Zones only appear once two 50-bar swing points exist.
- On 15m intraday data, overnight gap-ups also qualify as FVGs, which is why only the newest 6 are drawn.

## How the SMC layouts are read

The layouts below follow the top-down approach that the SMC literature and LuxAlgo describe: trade only blocks aligned with higher-timeframe structure and on the correct side of the range ([LuxAlgo library](https://www.luxalgo.com/library/indicator/SRsr9SLs-smart-money-concepts)).
- **SMC intraday:** 1h bias, 15m zone, 5m trigger.
- **SMC NIFTY & BANKNIFTY:** 15m on both indices, plus 5m triggers.
- **SMC swing:** daily, with a 1h trigger.
- **SMC positional:** weekly with 20-bar swings, plus daily.

Each layout shows a chart-by-chart checklist when you apply it.

## Caveats
- LuxAlgo's own script page says these concepts don't guarantee trading alongside institutional liquidity and that there's no supporting data for their validity.
- Many order blocks fail. Swing points confirm late (50 bars).
- [SEBI's FY22–FY24 study](https://www.sebi.gov.in/media-and-notifications/press-releases/sep-2024/updated-sebi-study-reveals-93-of-individual-traders-incurred-losses-in-equity-fando-between-fy22-and-fy24-aggregate-losses-exceed-1-8-lakh-crores-over-three-years_86906.html) found 93% of individual F&O traders lost money.
- Educational only.
