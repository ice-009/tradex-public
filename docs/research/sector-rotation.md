# Sector rotation on NSE F&O: RRG quadrants, sector momentum and reversal (issue #30)

**Verdict: no edge after costs. The setup score is unchanged.** I tested 10
variants × 4 horizons = 40 trials on the point-in-time F&O list from 2003 to 2026.
None of them clears the deflated-Sharpe bar: the best DSR is 0.000, and promotion
needs 0.95. The one robust finding is the opposite of the earlier hypothesis.
Over one month, Indian sectors show **momentum**, not reversal. Stocks in the
month's strongest sectors beat stocks in the weakest by about 0.25% per 5 sessions
before costs (t 3.8; information-coefficient t 3.7). That holds in the index era
(2013–2026) and in the basket era (2003–2012). It is smaller than two futures round
trips (≈ 0.33%), so it isn't tradable as a standalone long–short. The RRG quadrants
add nothing. "Rotation-in" (buying sectors entering Improving) is flat before costs
and reliably negative after them. "Laggard catch-up" (sector reversal) loses
everywhere (net −0.78% per 21 sessions, t −2.9). Both match the earlier 5-year
result. The new Sectors-panel rotation graph and the screener's "Strong sectors"
sort are context, not a signal.

## What was built

- **RRG maths** (`src/core/sector/rrg.ts`, pure, unit-tested on synthetic series).
  Relative Rotation Graphs were created by Julius de Kempenaer (RRG Research), and
  the exact JdK RS-Ratio / RS-Momentum formulas are **proprietary and unpublished**.
  This is a transparent approximation in the same spirit, not the original, and its
  readings won't match RRG Research's charts. For a sector series S and benchmark
  B (NIFTY 500; its synthetic equal-weight basket before 2012), on the sessions
  both have:

  ```
  RS_t          = 100 · S_t / B_t
  X_t           = EMA_s(RS)_t                       (α = 2/(s+1), seeded with RS_0; first s−1 values dropped)
  RS-Ratio_t    = 100 + (X_t − mean_w(X)_t) / sd_w(X)_t
  D_t           = RS-Ratio_t − RS-Ratio_{t−k}
  RS-Momentum_t = 100 + (D_t − mean_w(D)_t) / sd_w(D)_t
  ```

  `mean_w` and `sd_w` (the sample standard deviation) are taken over the last w
  values, the current one included. Nothing after t is used; a test checks that
  values on a truncated series are identical. The defaults are s = 10, w = 63 and
  k = 10 sessions. The first value comes on session s + 2w + k − 2 (the 147th).
  Quadrants are split at 100:

  | Quadrant | RS-Ratio | RS-Momentum |
  |---|---|---|
  | Leading | ≥ 100 | ≥ 100 |
  | Weakening | ≥ 100 | < 100 |
  | Lagging | < 100 | < 100 |
  | Improving | < 100 | ≥ 100 |

  A sector whose relative strength cycles moves clockwise:
  Improving → Leading → Weakening → Lagging. The unit test checks this on a
  sinusoid: every quadrant is visited and no step goes counter-clockwise. The
  per-sector timeline is one point every 5 sessions (`rrgTrail`, `sectorRrg`).
- **Long sector series** (`src/core/sector/series.ts`). For each industry, the series
  is the first NSE index whose history starts with NSE's index file (February
  2012), with the hub's equal-weight basket spliced in front. Industries with no
  such index use the basket throughout. In the hub's current catalogue those are
  Capital Goods, Chemicals, Consumer Services, Consumer Durables, Construction
  Materials, Telecom and Textiles, whose NSE indices start in 2016–2026. An index
  added later isn't spliced on, because the series would change meaning part-way
  through. Power and Oil & Gas both map to NIFTY ENERGY.
- **Lab signals** (`src/core/lab/sectorSignals.ts`, a new "Sector rotation" group
  in the registry). Each stock gets its sector's value:
  - `sector-momentum`: ln(RS_t / RS_{t−N}), the sector's relative strength against
    NIFTY 500 over N sessions. On a given day this ranks stocks exactly as the
    sector's own N-session return does.
  - `sector-reversal`: −(S_t / S_{t−N} − 1), minus the sector's own return.
  - `sector-rrg` (binary): 1 when the sector is in the chosen quadrant (1 Leading,
    2 Weakening, 3 Lagging, 4 Improving, 5 Improving or Leading).
  - Every signal takes `synthetic` (1 by default). With 0, a session has no value
    when its look-back touches a basket, for the sector or for NIFTY 500.

  The service (`src/server/services/labSectors.ts`) reads the indices and
  baskets from the hub over the run's span. Their content hashes, the source plan
  and every stock's industry join the run's data stamp.
- **UI.** The Sectors panel gets a **Rotation** view: a scatter of RS-Ratio
  against RS-Momentum with 5-week tails, coloured by quadrant from the theme
  tokens. Clicking a sector highlights it and opens its row. Every sector row
  shows a quadrant tag and an **RS** sort, and an open row shows the sector's
  26-week quadrant timeline. The screener gets a **Strong sectors** sort: stocks
  ranked by their sector index's 1-month strength rank, then by setup score. It
  already had a sector filter. The plan is unchanged. The score is unchanged (see
  the verdict).

## Setup

- Universe: the F&O list as it stood on each day (NSE F&O bhavcopy), with former
  members included where the hub holds their history. Bars come from the hub's
  adjusted archive.
- Costs: futures-2026, about 0.166% per round trip per position. The long–short
  spread pays two round trips. "Net @ turnover" pays costs only on the stocks
  replaced at each h-session rebalance. It is reported for context; the verdict
  uses the plain net spread.
- Ranking: quintiles (sectors give few distinct values, and tied stocks share a
  bucket). Binary RRG signals are measured as matched stocks minus the rest.
  Horizons are 1, 5, 10 and 21 sessions. t-stats are Newey–West with lag h − 1.
- Windows, each run separately:
  - **2013-01-01 → 2026-11-26: primary.** Every look-back sits inside NSE index
    history, for the 12 sectors that have one.
  - 2002-01-01 → 2012-12-31: the basket era.
  - 2002-01-01 → 2026-11-26: the full span.

  The first formation day is actually 2003-08-28; before it, fewer than 20 F&O
  stocks a day had a sector value.

### Biases, stated

1. **Survivorship in the baskets.** Before 2012, and for the 7 basket-only sectors
   throughout, a sector's history is an equal-weight basket of *today's* members.
   Pre-2012 numbers are therefore optimistic. They are reported apart, and the
   `synthetic = 0` variants re-run the primary window on NSE index data only.
2. **Today's industry map.** Industries come from today's NSE index lists, because
   the history of the classification isn't stored. Former F&O members missing
   from today's lists have no sector and drop out: 154 of 456 stocks over the
   full span. The cross-section is therefore tilted towards survivors, on both
   legs alike. In the primary window this is milder, with about 150 stocks a day
   ranked.
3. **A stock in its own sector.** A stock's own move is part of its sector's move.
   This matters most for small baskets such as Media (4 members) or Textiles (5).
   Sector momentum therefore carries a little of the stock's own momentum.

## Trials

Every run is a recorded trial (#24), and re-running a variant replaces its result.

| Idea | Variants | Trials (variant × horizon) | Runs recorded | Luck benchmark (annual Sharpe of the best) |
|---|---|---|---|---|
| `sector-momentum` | lookback 21, 63, 126; 126 with synthetic = 0 | 16 | 40 | 3.29 |
| `sector-reversal` | lookback 21; 21 with synthetic = 0 | 8 | 16 | 3.34 |
| `sector-rrg` | quadrant 5, 4, 1; 5 with synthetic = 0 (s 10, w 63, k 10) | 16 | 45 | 5.28 |
| **Total** | **10** | **40** | **101** | |

The 101 runs are 24 runs × 4 horizons, plus two checks. One is a smoke run of
`sector-rrg` (quadrant 5, horizon 5, 2025-06 onward) that checked the plumbing.
The other re-ran the NSE-only RRG variant after merging main: 4 runs, with the
same result to three decimals. Both checks repeat variants and horizons that were
already planned, so they replaced results and didn't add trials. The three `synthetic = 1` sets were each run three times,
in this order: full span, basket era, then the primary window last. So the record
and the report cards hold the 2013+ run. No other variants were tried: no other
RRG parameters, no other quadrants, and no reversed runs. The trial record lives
in this checkout's `.cache/market.db`.

Reproduce, for example: `npm run lab -- --signal sector-momentum --param lookback=21 --from 2013-01-01`,
`npm run lab -- --signal sector-rrg --param quadrant=4 --from 2002-01-01 --to 2012-12-31`.

## Results, 2013–2026 (primary)

3,372 formation days, 294 stocks, about 150 a day. The regime columns use NIFTY
above or below its 200-day average. The 60/40 split falls in mid-2021. DSR is
each variant's deflated Sharpe ratio against all trials of its idea.

| Variant | h | Gross (t) | Net (t) | IC (t) | Up: net (t) | Down: net (t) | First 60% | Last 40% | Net @ turnover | DSR |
|---|---|---|---|---|---|---|---|---|---|---|
| sector-momentum 21 | 1 | +0.073% (4.14) | −0.259% (−14.80) | 0.96% (3.39) | −0.251% (−13.48) | −0.286% (−6.69) | −0.237% | −0.292% | +0.015% | 0.000 |
|  | 5 | +0.253% (3.76) | −0.079% (−1.18) | 1.90% (3.66) | −0.008% (−0.11) | −0.299% (−2.15) | +0.024% | −0.234% | +0.127% | 0.000 |
|  | 10 | +0.396% (3.07) | +0.064% (0.50) | 2.18% (3.06) | +0.179% (1.27) | −0.287% (−1.02) | +0.272% | −0.250% | +0.221% | 0.000 |
|  | 21 | +0.425% (1.56) | +0.093% (0.34) | 1.66% (1.64) | +0.302% (1.04) | −0.551% (−0.95) | +0.424% | −0.412% | +0.176% | 0.000 |
| sector-momentum 63 | 1 | +0.035% (1.99) | −0.297% (−16.76) | 0.80% (2.84) | −0.278% (−14.86) | −0.354% (−8.14) | −0.291% | −0.305% | +0.003% | 0.000 |
|  | 5 | +0.166% (2.27) | −0.166% (−2.27) | 1.42% (2.71) | −0.046% (−0.59) | −0.534% (−3.25) | −0.122% | −0.232% | +0.095% | 0.000 |
|  | 10 | +0.300% (2.07) | −0.032% (−0.22) | 1.55% (2.07) | +0.234% (1.48) | −0.849% (−2.78) | +0.039% | −0.139% | +0.201% | 0.000 |
|  | 21 | +0.426% (1.44) | +0.094% (0.32) | 1.23% (1.15) | +0.570% (1.72) | −1.372% (−2.49) | +0.187% | −0.047% | +0.287% | 0.000 |
| sector-momentum 126 | 1 | +0.027% (1.56) | −0.304% (−17.27) | 0.68% (2.41) | −0.281% (−14.92) | −0.378% (−8.89) | −0.287% | −0.330% | +0.006% | 0.000 |
|  | 5 | +0.093% (1.34) | −0.239% (−3.43) | 1.07% (2.08) | −0.105% (−1.39) | −0.649% (−4.23) | −0.170% | −0.343% | +0.045% | 0.000 |
|  | 10 | +0.184% (1.38) | −0.148% (−1.11) | 1.17% (1.65) | +0.091% (0.63) | −0.881% (−3.20) | +0.020% | −0.403% | +0.116% | 0.000 |
|  | 21 | +0.287% (1.06) | −0.045% (−0.17) | 1.32% (1.31) | +0.389% (1.35) | −1.387% (−2.56) | +0.338% | −0.629% | +0.187% | 0.000 |
| sector-reversal 21 | 1 | −0.070% (−3.98) | −0.402% (−22.77) | −0.97% (−3.41) | −0.410% (−21.74) | −0.379% (−8.88) | −0.421% | −0.375% | −0.129% | 0.000 |
|  | 5 | −0.246% (−3.65) | −0.578% (−8.56) | −1.86% (−3.58) | −0.654% (−8.62) | −0.344% (−2.49) | −0.669% | −0.441% | −0.373% | 0.000 |
|  | 10 | −0.395% (−3.06) | −0.727% (−5.63) | −2.14% (−3.00) | −0.840% (−5.96) | −0.380% (−1.35) | −0.930% | −0.420% | −0.571% | 0.000 |
|  | 21 | −0.451% (−1.66) | −0.783% (−2.89) | −1.69% (−1.68) | −0.998% (−3.46) | −0.116% (−0.20) | −1.118% | −0.271% | −0.700% | 0.000 |
| sector-rrg Improving or Leading | 1 | +0.015% (1.36) | −0.317% (−29.43) | −0.03% (−0.12) | −0.317% (−26.85) | −0.317% (−12.85) | −0.306% | −0.334% | −0.003% | 0.000 |
|  | 5 | +0.075% (1.74) | −0.257% (−5.99) | 0.71% (1.46) | −0.275% (−5.55) | −0.204% (−2.45) | −0.213% | −0.324% | −0.001% | 0.000 |
|  | 10 | +0.176% (1.99) | −0.156% (−1.77) | 1.47% (2.18) | −0.230% (−2.19) | +0.070% (0.47) | −0.065% | −0.294% | +0.046% | 0.000 |
|  | 21 | +0.222% (1.29) | −0.109% (−0.63) | 1.46% (1.67) | −0.224% (−1.10) | +0.244% (0.87) | +0.095% | −0.421% | +0.053% | 0.000 |
| sector-rrg Improving | 1 | −0.005% (−0.43) | −0.337% (−26.23) | −0.17% (−0.64) | −0.351% (−24.82) | −0.294% (−10.05) | −0.331% | −0.347% | −0.021% | 0.000 |
|  | 5 | −0.004% (−0.07) | −0.336% (−6.37) | 0.13% (0.26) | −0.400% (−6.69) | −0.135% (−1.29) | −0.317% | −0.364% | −0.063% | 0.000 |
|  | 10 | −0.009% (−0.09) | −0.341% (−3.29) | 0.60% (0.90) | −0.486% (−3.99) | +0.110% (0.64) | −0.332% | −0.353% | −0.102% | 0.000 |
|  | 21 | −0.131% (−0.62) | −0.462% (−2.20) | 0.07% (0.08) | −0.765% (−3.01) | +0.484% (1.82) | −0.513% | −0.386% | −0.261% | 0.000 |
| sector-rrg Leading | 1 | +0.035% (2.56) | −0.297% (−21.69) | 0.21% (0.82) | −0.284% (−18.63) | −0.338% (−11.16) | −0.292% | −0.304% | +0.017% | 0.000 |
|  | 5 | +0.137% (2.67) | −0.195% (−3.81) | 0.76% (1.67) | −0.156% (−2.63) | −0.317% (−3.23) | −0.154% | −0.257% | +0.058% | 0.000 |
|  | 10 | +0.257% (2.66) | −0.075% (−0.78) | 1.11% (1.86) | −0.024% (−0.21) | −0.234% (−1.26) | +0.014% | −0.209% | +0.121% | 0.000 |
|  | 21 | +0.454% (2.52) | +0.122% (0.68) | 1.53% (2.00) | +0.308% (1.51) | −0.457% (−1.35) | +0.393% | −0.292% | +0.282% | 0.000 |
| sector-momentum 126, NSE only | 1 | +0.043% (1.99) | −0.289% (−13.43) | 0.84% (2.46) | −0.251% (−10.99) | −0.407% (−7.77) | −0.274% | −0.312% | +0.021% | 0.000 |
|  | 5 | +0.147% (1.73) | −0.185% (−2.18) | 1.37% (2.20) | +0.029% (0.32) | −0.846% (−4.48) | −0.088% | −0.332% | +0.095% | 0.000 |
|  | 10 | +0.241% (1.47) | −0.091% (−0.55) | 1.61% (1.85) | +0.274% (1.57) | −1.210% (−3.44) | +0.117% | −0.405% | +0.168% | 0.000 |
|  | 21 | +0.442% (1.29) | +0.111% (0.32) | 1.82% (1.47) | +0.678% (1.82) | −1.641% (−2.63) | +0.590% | −0.621% | +0.338% | 0.000 |
| sector-reversal 21, NSE only | 1 | −0.087% (−4.17) | −0.419% (−20.01) | −0.94% (−2.80) | −0.431% (−19.37) | −0.383% (−7.50) | −0.447% | −0.378% | −0.146% | 0.000 |
|  | 5 | −0.295% (−3.59) | −0.627% (−7.62) | −1.74% (−2.87) | −0.718% (−7.97) | −0.349% (−1.89) | −0.715% | −0.495% | −0.421% | 0.000 |
|  | 10 | −0.407% (−2.59) | −0.739% (−4.71) | −2.08% (−2.48) | −0.867% (−5.19) | −0.345% (−0.92) | −0.928% | −0.453% | −0.579% | 0.000 |
|  | 21 | −0.404% (−1.28) | −0.736% (−2.34) | −1.84% (−1.56) | −0.920% (−2.73) | −0.167% (−0.24) | −1.115% | −0.156% | −0.646% | 0.000 |
| sector-rrg Improving or Leading, NSE only | 1 | +0.018% (1.38) | −0.314% (−23.80) | −0.04% (−0.11) | −0.311% (−21.87) | −0.324% (−10.34) | −0.297% | −0.340% | +0.001% | 0.000 |
|  | 5 | +0.097% (1.90) | −0.234% (−4.57) | 0.75% (1.30) | −0.237% (−4.11) | −0.228% (−2.14) | −0.166% | −0.337% | +0.023% | 0.000 |
|  | 10 | +0.235% (2.22) | −0.096% (−0.91) | 1.64% (2.03) | −0.157% (−1.26) | +0.091% (0.48) | +0.025% | −0.280% | +0.107% | 0.000 |
|  | 21 | +0.270% (1.30) | −0.062% (−0.30) | 1.43% (1.35) | −0.150% (−0.61) | +0.210% (0.64) | +0.212% | −0.481% | +0.101% | 0.000 |


Quintiles of `sector-momentum 21` at 5 sessions (gross, mean per formation day),
weakest sectors to strongest: Q1 +0.205%, Q2 +0.246%, Q3 +0.279%, Q4 +0.389%,
Q5 +0.457%. They rise steadily from Q1 to Q5. `sector-reversal 21` is the same
ranking turned upside down.

## All windows: 5 and 21 sessions

The basket era (2003–2012) is survivorship-biased and is read as a check, not as
evidence.

| Variant | Window | Days | Stocks/day | 5d gross (t) | 5d net (t) | 21d gross (t) | 21d net (t) | 5d IC t |
|---|---|---|---|---|---|---|---|---|
| sector-momentum 21 | 2013–2026 | 3372 | 150 | +0.253% (3.76) | −0.079% (−1.18) | +0.425% (1.56) | +0.093% (0.34) | 3.66 |
|  | 2003–2012 | 2332 | 86 | +0.281% (2.61) | −0.051% (−0.47) | +0.588% (1.51) | +0.256% (0.66) | 3.31 |
|  | 2003–2026 | 5704 | 124 | +0.265% (4.47) | −0.067% (−1.13) | +0.492% (2.18) | +0.160% (0.71) | 4.97 |
| sector-momentum 63 | 2013–2026 | 3372 | 150 | +0.166% (2.27) | −0.166% (−2.27) | +0.426% (1.44) | +0.094% (0.32) | 2.71 |
|  | 2003–2012 | 2332 | 85 | +0.322% (2.93) | −0.010% (−0.09) | +1.195% (2.65) | +0.863% (1.92) | 3.04 |
|  | 2003–2026 | 5704 | 123 | +0.229% (3.67) | −0.103% (−1.65) | +0.730% (2.87) | +0.398% (1.56) | 4.05 |
| sector-momentum 126 | 2013–2026 | 3372 | 150 | +0.093% (1.34) | −0.239% (−3.43) | +0.287% (1.06) | −0.045% (−0.17) | 2.08 |
|  | 2003–2012 | 2332 | 85 | +0.201% (1.64) | −0.131% (−1.07) | +0.580% (1.16) | +0.249% (0.50) | 2.22 |
|  | 2003–2026 | 5704 | 123 | +0.136% (2.11) | −0.196% (−3.02) | +0.387% (1.49) | +0.055% (0.21) | 3.04 |
| sector-reversal 21 | 2013–2026 | 3386 | 149 | −0.246% (−3.65) | −0.578% (−8.56) | −0.451% (−1.66) | −0.783% (−2.89) | −3.58 |
|  | 2003–2012 | 2332 | 86 | −0.297% (−2.77) | −0.629% (−5.87) | −0.631% (−1.64) | −0.963% (−2.50) | −3.32 |
|  | 2003–2026 | 5718 | 123 | −0.268% (−4.52) | −0.599% (−10.13) | −0.524% (−2.34) | −0.856% (−3.82) | −4.92 |
| sector-rrg Improving or Leading | 2013–2026 | 3372 | 150 | +0.075% (1.74) | −0.257% (−5.99) | +0.222% (1.29) | −0.109% (−0.63) | 1.46 |
|  | 2003–2012 | 2332 | 85 | +0.033% (0.45) | −0.299% (−4.05) | −0.059% (−0.23) | −0.391% (−1.53) | 0.48 |
|  | 2003–2026 | 5704 | 123 | +0.057% (1.45) | −0.275% (−6.98) | +0.112% (0.77) | −0.220% (−1.51) | 1.36 |
| sector-rrg Improving | 2013–2026 | 3358 | 150 | −0.004% (−0.07) | −0.336% (−6.37) | −0.131% (−0.62) | −0.462% (−2.20) | 0.26 |
|  | 2003–2012 | 2318 | 85 | −0.101% (−1.19) | −0.433% (−5.10) | −0.301% (−0.92) | −0.633% (−1.93) | −1.70 |
|  | 2003–2026 | 5676 | 124 | −0.044% (−0.94) | −0.376% (−8.07) | −0.196% (−1.07) | −0.528% (−2.89) | −1.04 |
| sector-rrg Leading | 2013–2026 | 3344 | 150 | +0.137% (2.67) | −0.195% (−3.81) | +0.454% (2.52) | +0.122% (0.68) | 1.67 |
|  | 2003–2012 | 2253 | 86 | +0.202% (2.12) | −0.130% (−1.37) | +0.550% (1.83) | +0.218% (0.72) | 2.90 |
|  | 2003–2026 | 5597 | 124 | +0.163% (3.32) | −0.169% (−3.46) | +0.492% (3.04) | +0.160% (0.99) | 3.21 |

## Reading it

- **1-month sector momentum is real but small.** The gross spread is positive with
  t ≥ 2.2 at 1–10 sessions in all three windows, and the IC t is 3.3–5.0. The
  quintiles rise steadily. But the gross 5-session spread (≈ 0.25%) is below the
  cost of a long–short round trip on both legs (≈ 0.33%). The net spread never
  reaches t 2, is negative in the last 40% of the primary window, and has
  DSR 0.000. Holding for 10–21 sessions and paying only on turnover leaves about
  +0.2% per hold. That needs a portfolio test with real position sizing, not a
  promotion.
- **Longer sector momentum (3 and 6 months) is weaker** and turns sharply negative
  when NIFTY is below its 200-day average (6 months, 21 sessions: −1.39%, t −2.6).
  The pre-deflation "works in uptrends only" label for 3-month momentum on the
  full span comes from the basket era: +1.31% in uptrends at 21 sessions before
  2013, against +0.57% (t 1.7) after. The luck check rejects it.
- **No short-term industry reversal.** The South Asian study linked from the issue
  found reversal. In this data the sign is the other way round: laggard sectors
  keep lagging. Net −0.78% per 21 sessions (t −2.9), and −0.74% (t −2.3) on NSE
  indices only.
- **RRG quadrants add nothing beyond the momentum they encode.** "Leading" is a
  weaker version of 1-month momentum (gross 21 sessions +0.45%, t 2.5; net
  +0.12%, t 0.7). "Improving", the rotation-in trade, is flat before costs and
  negative after: −0.46% per 21 sessions, t −2.2. "Improving or Leading", which
  means RS-Momentum ≥ 100, is flat.
- **Synthetic baskets don't drive the primary results.** The NSE-only re-runs of
  6-month momentum, reversal and RRG 5 give the same signs and similar sizes as the
  runs that allow baskets.

## Score

No sector signal passed the guard, so `src/core/screener/score.ts` is left alone.
One thing for the score's owner (#29): the score already applies a −4 "Weak sector
(bottom third over 1 month)" penalty and a "leading sector" note. Both predate the
Lab. The direction is consistent with the gross 1-month sector momentum found
here, but the Lab doesn't promote it as an edge after costs. Whether to keep it is
a question for the receipts work, not this change.

## References

- Moskowitz, T. & Grinblatt, M. (1999), "Do Industries Explain Momentum?",
  *Journal of Finance* 54(4): the industry-momentum effect tested here.
- De Kempenaer, J. (RRG Research): the Relative Rotation Graph and its quadrant
  terms. The original JdK RS-Ratio and RS-Momentum formulas are proprietary; the
  formulas above are this project's own documented approximation.
- The South Asian industry-reversal study linked from issue #30
  (ojs.umt.edu.pk, *search*: not re-opened for this note).
