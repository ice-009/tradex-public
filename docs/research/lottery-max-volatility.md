# Lottery stocks (MAX) and low volatility on NSE F&O (issue #26)

**Verdict: no edge in our data. The setup score is unchanged.** Stocks with the
biggest recent one-day jumps (MAX) and the most volatile stocks do a little worse
than the rest, as the papers say. But the gap is small (gross t-stats of 0.1 to 1.8),
a futures round trip costs more than it, it reverses when NIFTY is below its
200-day average and in the last 40% of the history, and no variant comes close to
the deflated-Sharpe bar (DSR 0.000 against 0.95). Penalising lottery-like stocks
in the score would add a factor that has no measured value.

## What was tested

Signals from the Signal Lab registry (`src/core/lab/signals.ts`):

| Variant | Signal | What it measures |
|---|---|---|
| 26a | `max-21d` window 21, top 1, **reversed** | MAX: the largest daily return of the last 21 sessions (Bali, Cakici & Whitelaw 2011) |
| 26b | `max-21d` window 21, top 5, **reversed** | MAX(5): the mean of the 5 largest, the paper's robustness check (new `top` parameter) |
| 26c | `volatility-20d` window 20, **reversed** | realised volatility of daily log returns over 20 sessions |
| 26d | `volatility-20d` window 60, **reversed** | the same over 60 sessions |

The expected sign is negative (high MAX or high volatility → lower returns), so
every variant was run **reversed** (`--reverse`, new in this change). Q5 holds the
*lowest* MAX or volatility, so the Q5 − Q1 spread is "low minus high", and Q1 is the
group a long-side penalty would hit. The plain (un-reversed) signals were not run.
They would only mirror these numbers, and each run would count as another trial.

Setup: F&O list point in time (former members included), daily bars from the
Market Data Hub's adjusted archive, futures-2026 costs (about 0.166% per round trip
per position, two round trips on the long–short spread), quintiles, horizons 1, 5,
10 and 21 sessions, Newey–West t with lag h − 1. Primary period 2010-01-04 to
2026-11-26 (4,193 formation days, 474 stocks, about 181 a day). Full period
2002-01-01 onward (6,191 days, 568 stocks).

Reproduce: `npm run lab -- --signal max-21d --param top=5 --reverse --from 2010-01-01`
(and `--from 2002-01-01`, `--signal volatility-20d --param window=60`, …).

## Trials

4 variants × 4 horizons = **16 trials**. The trial record keeps them under two
ideas: `max-21d` with 8 and `volatility-20d` with 8. The DSR below is taken against
all 16 together, which is stricter. Each variant was run three times: 2010+,
2002+, and 2010+ again so that the record's latest run is the primary period.
Re-runs replace a trial's result; they don't add trials. Luck benchmark for the
best of 16: annual Sharpe 3.45 (2010+) and 2.97 (2002+).

## Results, 2010–2026

Quintile columns are the mean forward return over h sessions per formation day,
gross. Q1 is the highest MAX or volatility and Q5 the lowest. "Net" is the spread
after two futures round trips. Regimes are NIFTY above or below its 200-day average
on the formation day. The 60/40 split is at 2020-02-24.

**26a MAX(1), reversed**

| h | Q1 (high MAX) | Q2 | Q3 | Q4 | Q5 (low MAX) | Q5−Q1 gross (t) | net | NW t (net) | up: net (t) | down: net (t) | first 60% | last 40% | DSR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | +0.041% | +0.040% | +0.037% | +0.042% | +0.043% | +0.002% (0.12) | −0.330% | −22.55 | −0.321% (−19.5) | −0.360% (−11.3) | −0.307% | −0.365% | 0.000 |
| 5 | +0.174% | +0.213% | +0.193% | +0.224% | +0.208% | +0.035% (0.60) | −0.297% | −5.12 | −0.241% (−3.8) | −0.477% (−3.7) | −0.195% | −0.450% | 0.000 |
| 10 | +0.322% | +0.420% | +0.401% | +0.463% | +0.419% | +0.097% (0.85) | −0.235% | −2.05 | −0.123% (−1.0) | −0.593% (−2.3) | −0.037% | −0.533% | 0.000 |
| 21 | +0.689% | +0.867% | +0.903% | +0.946% | +0.952% | +0.263% (1.08) | −0.069% | −0.28 | +0.129% (0.5) | −0.704% (−1.4) | +0.433% | −0.832% | 0.000 |

**26b MAX(5), reversed**

| h | Q1 | Q2 | Q3 | Q4 | Q5 | Q5−Q1 gross (t) | net | NW t (net) | up: net (t) | down: net (t) | first 60% | last 40% | DSR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | +0.038% | +0.038% | +0.039% | +0.041% | +0.048% | +0.011% (0.65) | −0.321% | −20.00 | −0.317% (−17.5) | −0.335% (−9.8) | −0.293% | −0.364% | 0.000 |
| 5 | +0.187% | +0.183% | +0.210% | +0.201% | +0.233% | +0.046% (0.73) | −0.286% | −4.52 | −0.247% (−3.4) | −0.412% (−3.2) | −0.170% | −0.460% | 0.000 |
| 10 | +0.356% | +0.374% | +0.421% | +0.424% | +0.451% | +0.095% (0.76) | −0.237% | −1.90 | −0.137% (−1.0) | −0.558% (−2.2) | −0.003% | −0.589% | 0.000 |
| 21 | +0.708% | +0.789% | +0.927% | +0.945% | +0.989% | +0.281% (1.03) | −0.051% | −0.19 | +0.157% (0.5) | −0.720% (−1.4) | +0.537% | −0.944% | 0.000 |

**26c Volatility 20d, reversed**

| h | Q1 (high vol) | Q2 | Q3 | Q4 | Q5 (low vol) | Q5−Q1 gross (t) | net | NW t (net) | up: net (t) | down: net (t) | first 60% | last 40% | DSR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | +0.024% | +0.040% | +0.044% | +0.046% | +0.049% | +0.025% (1.31) | −0.307% | −16.02 | −0.290% (−14.0) | −0.361% (−7.9) | −0.284% | −0.341% | 0.000 |
| 5 | +0.133% | +0.197% | +0.212% | +0.236% | +0.236% | +0.104% (1.32) | −0.228% | −2.90 | −0.126% (−1.5) | −0.558% (−3.1) | −0.107% | −0.411% | 0.000 |
| 10 | +0.270% | +0.367% | +0.451% | +0.452% | +0.487% | +0.217% (1.37) | −0.115% | −0.72 | +0.097% (0.6) | −0.792% (−2.2) | +0.157% | −0.524% | 0.000 |
| 21 | +0.569% | +0.772% | +0.997% | +0.994% | +1.024% | +0.455% (1.31) | +0.123% | 0.35 | +0.519% (1.4) | −1.151% (−1.5) | +0.832% | −0.955% | 0.000 |

**26d Volatility 60d, reversed**

| h | Q1 (high vol) | Q2 | Q3 | Q4 | Q5 (low vol) | Q5−Q1 gross (t) | net | NW t (net) | up: net (t) | down: net (t) | first 60% | last 40% | DSR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | +0.021% | +0.039% | +0.043% | +0.044% | +0.056% | +0.034% (1.64) | −0.298% | −14.19 | −0.281% (−12.2) | −0.352% (−7.2) | −0.259% | −0.355% | 0.000 |
| 5 | +0.110% | +0.200% | +0.220% | +0.219% | +0.267% | +0.158% (1.77) | −0.174% | −1.96 | −0.058% (−0.6) | −0.547% (−2.7) | +0.014% | −0.458% | 0.000 |
| 10 | +0.220% | +0.388% | +0.453% | +0.442% | +0.525% | +0.305% (1.69) | −0.027% | −0.15 | +0.208% (1.1) | −0.777% (−2.0) | +0.354% | −0.602% | 0.000 |
| 21 | +0.454% | +0.905% | +0.963% | +0.953% | +1.083% | +0.629% (1.59) | +0.297% | 0.75 | +0.792% (1.9) | −1.296% (−1.6) | +1.194% | −1.067% | 0.000 |

The best case is 60-day volatility at 21 sessions. Low-volatility stocks beat
high-volatility ones by 0.63% a month gross (t 1.59). That is below the bar of
t > 2 even before costs. The effect lives entirely in rising markets: when NIFTY is
below its 200-day average the spread is −1.30% a month, and it is negative in the
last 40% of the period (2020–26). Holding the legs and paying only on turnover
(25% of the long leg a month) would leave +0.55% a month net, at the same t
below 2, with the same regime flip.

## Results, full period 2002–2026 (robustness)

Spread Q5 − Q1 (low minus high), gross, and its t, by horizon. Net and DSR as
above. Split date 2016-12-01.

| Variant | 1d gross (t) | 5d gross (t) | 10d gross (t) | 21d gross (t) | 21d net (t) | 21d up / down net | 21d first / last 40% | DSR (best h) |
|---|---|---|---|---|---|---|---|---|
| 26a MAX(1) | −0.002% (−0.11) | +0.002% (0.05) | +0.045% (0.42) | +0.177% (0.74) | −0.155% (−0.65) | −0.014% / −0.643% | −0.129% / −0.194% | 0.000 |
| 26b MAX(5) | +0.005% (0.36) | +0.027% (0.46) | +0.047% (0.41) | +0.221% (0.86) | −0.111% (−0.43) | +0.035% / −0.619% | −0.067% / −0.179% | 0.000 |
| 26c vol 20d | +0.019% (1.03) | +0.058% (0.81) | +0.142% (1.01) | +0.319% (1.04) | −0.013% (−0.04) | +0.267% / −0.981% | +0.114% / −0.204% | 0.000 |
| 26d vol 60d | +0.021% (1.06) | +0.080% (0.98) | +0.147% (0.92) | +0.262% (0.75) | −0.070% (−0.20) | +0.274% / −1.263% | +0.019% / −0.205% | 0.000 |

The longer history is weaker, not stronger.

## Why it doesn't show up here (the likely reasons)

- **The universe.** The Indian MAX study and the NSE low-risk study cover the whole
  listed market, where most lottery stocks are small and illiquid. The F&O list is
  the ~180–230 largest and most liquid stocks, and SEBI's entry rules keep the
  smallest lottery-like names out. Among large caps the MAX premium is known to be
  weak.
- **Regime dependence.** When NIFTY is above its 200-day average, the calm stocks
  do better over the next month. When it is below, the volatile and lottery-like
  stocks do better. That is most likely the high-beta rebound out of sell-offs
  such as 2009 and 2020. Over a full cycle the two roughly cancel.
- **Costs.** The edge, where it exists (about +0.01–0.03% a day), is a tenth of a
  futures round trip.

## Decision

No score penalty. `src/core/screener/score.ts` is unchanged. The two signals stay
in the Lab: `max-21d` gains a `top` parameter (MAX(k)), and every signal can now be
run reversed. Re-test if the universe widens beyond F&O, or with a long-only,
monthly-rebalanced test, which the Lab doesn't do yet.

## Sources

- Bali, Cakici & Whitelaw (2011), "Maxing out: stocks as lotteries and the cross-section of expected returns", *Journal of Financial Economics* 99(2).
- The Indian evidence cited in issue #26: a 2022 lottery-factor (MAX) study of Indian stocks, 2001–21 (*Empirical Economics*, doi 10.1007/s00181-022-02355-w), and a 2020 low-risk study of the top 500 NSE stocks (*Investment Management and Financial Innovations*, 2020 no. 2).
