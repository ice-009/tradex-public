# Residual and volatility-managed momentum (issue #27)

**Question.** Should the setup score's relative-strength factor be replaced by
residual momentum (Blitz, Huij & Martens 2011) or by a volatility-managed
momentum book (Barroso & Santa-Clara 2015)? The rule is that a replacement must
beat the current factor in the Signal Lab and pass the multiple-testing guard
(#24, deflated Sharpe ≥ 0.95).

**Verdict: no score change.** Residual momentum does not beat the score's RS
factor. It loses about half as much in falling markets, but it also earns less,
and no variant gets near the guard. Volatility management roughly doubles the
Sharpe ratio of the monthly momentum book, as the paper found, and it cuts the
2009 crash by about 40%. Its best variant still misses the guard by a little
(deflated Sharpe 0.931 against 0.95), and it is a portfolio-level overlay that
the per-stock score can't use as it stands. It is the result worth following up
(see "What next").

*Sources:* Blitz, Huij & Martens, "Residual momentum", *Journal of Empirical
Finance* 18(3), 2011; Barroso & Santa-Clara, "Momentum has its moments",
*Journal of Financial Economics* 116(1), 2015; Bailey & López de Prado, "The
deflated Sharpe ratio", *Journal of Portfolio Management* 40(5), 2014 (the #24
guard).

## What was built

| Piece | Where | What it does |
|---|---|---|
| `score-rs` signal | `src/core/lab/momentumSignals.ts` | The score's RS factor exactly as `score.ts` awards it (15 points). That is the day's 1–99 rank of volatility-adjusted 6/12-month momentum × 10/99, plus 0–5 points for closing near the 52-week high. Ranked among the day's F&O members. A unit test checks it against `scoreSetup` and `volAdjustedMomentum`. |
| `residual-momentum` signal | `src/core/lab/residual.ts`, `momentumSignals.ts` | A rolling OLS of daily returns over 756 sessions (≈ 36 months), on the market or on the market plus the stock's sector. The value is the residual sum over months t−12…t−2, divided by the residuals' standard deviation (`scale=1`, the paper's version) or not divided (`scale=0`). The math uses window sums, so each bar costs O(1). It is checked against a brute-force regression on a synthetic fixture. |
| Market factor | `ctx.benchmark` | NIFTY 50 from NSE's index file (from Feb 2012), and the hub's equal-weight NIFTY 50 basket before that. The basket is built from today's members, so it carries survivorship bias. |
| Sector factor | `peerFactor` | The equal-weighted daily return of the stock's industry peers in the loaded F&O universe, with the stock itself left out, on days with ≥ 3 peers. Industries are today's NSE classification (`asOf().industries`). They are known for 308 of the 569 stocks; the rest (mostly former members) fall back to the market-only regression. NSE's sector indices aren't used: they start in 2012 (some only in 2026), they hold the stock itself (often at a large weight), and the hub's sector baskets before 2012 are built from today's members. |
| Size factor | — | Not used. Market cap isn't stored, and the issue asked to keep this simple. |
| Extra warm-up | `LabSignal.warmupDays`, `researchData({ warmupDays })` | The 3-year regression needs ~3 years of bars before the first formation day. These are read on top of the backtester's 440-day warm-up, so runs are still reproducible. |
| Overlay evaluator | `src/core/lab/overlay.ts` | A monthly Q5−Q1 book formed on each month's last close and held to the next. Costs are a futures round trip on stocks entering a leg. `volManaged` scales the book each month by σ_target / σ̂, with σ̂² = 21·Σr²/126 over the book's last 126 daily returns (known at formation, so no look-ahead). The target only sets size: it is chosen ex post so that the managed book's volatility equals the plain one's. Sharpe ratios don't depend on it. Resizing kept positions pays half a round trip on the change. |
| Overlay runner | `src/server/services/labOverlay.ts`, `npm run lab -- overlay …` | Same data as a Lab run. Records the plain and the managed book as two trials of the idea `vol-managed-momentum` (horizon 21, 12 observations a year). |

## Setup

* **Data:** the hub's adjusted daily bars (1998→ with warm-up; the adjustment
  fix is hub #55). F&O list point-in-time with former members included (532–566
  stocks, ~150–180 ranked a day). Futures costs at 2026 rates, ~0.17% a round
  trip.
* **Periods:** the full period (formation days 2002-01-01 → 2026-11-26) is the
  primary test and was fixed before any run. 2010+ is the robustness check. The
  2010+ runs were recorded first, so the trial record's latest run for each
  variant is the full period's.
* **Lab metric:** Q5 − Q1 spread from every formation day at 1/5/10/21 sessions.
  Net figures charge two round trips; NW t uses lag h − 1. Momentum is a monthly
  signal, so the tables show 21 sessions.
* Residual momentum ranks only stocks with ~3 years of history (≥ 80% of 756
  sessions). RS needs 6 months. Its daily cross-section is therefore a little
  smaller (152 vs 161 stocks a day) and older.

## Results: residual momentum vs the score's RS factor

### Full period (2002–2026), 21-session forward returns

| Signal | Days | Stocks/day | Gross | Net | NW t | Sharpe/yr | IC (t) | Net @ turnover |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Score RS (current factor)** | 6191 | 161 | +0.69% | **+0.36%** | 1.15 | **0.18** | 0.041 (3.93) | +0.59% |
| Momentum 12−1 | 6191 | 160 | +0.72% | +0.39% | 1.14 | 0.16 | 0.043 (4.09) | +0.64% |
| Residual, market, scaled | 5965 | 152 | +0.54% | +0.20% | 0.81 | 0.11 | 0.029 (3.56) | +0.43% |
| Residual, market + sector, scaled | 5965 | 152 | +0.58% | +0.25% | 1.09 | 0.18 | 0.028 (3.92) | +0.48% |
| Residual, market, unscaled | 5965 | 152 | +0.58% | +0.25% | 0.96 | 0.16 | 0.031 (3.75) | +0.48% |

Quintile returns, 21 sessions gross (NW t):

| Signal | Q1 | Q2 | Q3 | Q4 | Q5 |
|---|---:|---:|---:|---:|---:|
| Score RS | +1.11% (2.25) | +1.14% (2.60) | +1.37% (3.33) | +1.51% (4.10) | +1.80% (5.20) |
| Momentum 12−1 | +0.97% (1.86) | +1.30% (3.02) | +1.37% (3.60) | +1.61% (4.50) | +1.69% (4.50) |
| Residual, market | +1.27% (2.75) | +1.20% (2.86) | +1.47% (3.73) | +1.57% (3.96) | +1.80% (4.62) |
| Residual, market + sector | +1.24% (2.69) | +1.26% (3.03) | +1.46% (3.73) | +1.53% (3.92) | +1.82% (4.61) |
| Residual, unscaled | +1.18% (2.42) | +1.25% (3.07) | +1.53% (4.02) | +1.60% (4.15) | +1.76% (4.34) |

Regimes (NIFTY vs its 200-day average on the formation day) and the 60/40 split, 21-session net (NW t):

| Signal | NIFTY up | NIFTY down | First 60% | Last 40% | Evidence PASS rule |
|---|---:|---:|---:|---:|---|
| Score RS | +0.90% (2.74) | −1.50% (−2.28) | +0.35% (0.78) | +0.37% (0.97) | no |
| Momentum 12−1 | +0.86% (2.42) | −1.25% (−1.67) | +0.27% (0.53) | +0.58% (1.41) | no |
| Residual, market | +0.44% (1.67) | −0.73% (−1.29) | +0.08% (0.22) | +0.39% (1.47) | no |
| Residual, market + sector | +0.48% (1.99) | −0.64% (−1.18) | +0.14% (0.40) | +0.42% (1.90) | no |
| Residual, unscaled | +0.52% (1.89) | −0.80% (−1.38) | +0.05% (0.14) | +0.55% (1.82) | no |

The split falls on 2016-12-01 for RS and momentum and on 2017-04-12 for the
residual signals, which have fewer ranked days.

### Since 2010, 21-session forward returns

| Signal | Days | Net | NW t | Sharpe/yr | NIFTY up | NIFTY down | First 60% | Last 40% | PASS rule |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Score RS | 4193 | +0.55% | 1.58 | 0.28 | +1.17% (3.23) | −1.46% (−2.12) | +0.97% (1.91) | −0.09% (−0.21) | no |
| Momentum 12−1 | 4193 | +0.51% | 1.41 | 0.29 | +1.07% (2.82) | −1.30% (−1.80) | +0.85% (1.65) | −0.01% (−0.03) | no |
| Residual, market | 3967 | +0.30% | 1.44 | 0.32 | +0.55% (2.52) | −0.62% (−1.42) | +0.24% (0.81) | +0.40% (1.41) | no |
| Residual, market + sector | 3967 | +0.37% | **2.07** | **0.41** | +0.60% (3.18) | −0.47% (−1.26) | +0.33% (1.30) | +0.44% (1.84) | **pass** |
| Residual, unscaled | 3967 | +0.42% | 1.82 | 0.37 | +0.71% (2.93) | −0.65% (−1.35) | +0.44% (1.34) | +0.40% (1.30) | no |

### What it says

* **Residual momentum earns less than the score's RS factor** over the full
  period: 21-day net spread +0.20% to +0.25% against +0.36%, with Sharpe ratios
  0.11–0.18 against 0.18. Its rank IC is about a third lower (0.028–0.031
  against 0.041). Taking out the market and sector removes part of what
  momentum is paid for in Indian F&O stocks.
* **It is steadier, as the paper says.** It loses about half as much when
  NIFTY is below its 200-day average (−0.64% to −0.80% against −1.50%). Its
  21-day spread has thinner tails than raw 12−1 (kurtosis 5.6–7.3 against 9.7;
  RS has 5.8). Its last 40% is
  better than its first 60%, while RS fades after 2020. Since 2010 the
  market + sector version is the only signal here that meets the evidence's
  PASS rule (t 2.07, positive in both parts).
* **The 2010+ result was not the test.** The full period was. It is one of 12
  residual-momentum trials, and the full period doesn't confirm it. Under the
  guard it has a deflated Sharpe of 0.000 (and 0.405 even in the 21-day-only
  sensitivity below). Choosing it from the 2010+ table would be the selection
  the guard is there to stop.
* At 1, 5 and 10 sessions, every momentum signal here loses money after costs:
  the short-term reversal dominates. It is a monthly signal.

## Results: volatility-managed momentum (portfolio overlay)

The monthly Q5 − Q1 book, plain and scaled by inverse 126-day realised
volatility. The managed book's volatility is set equal to the plain one's over
the full period. Formation runs from July 2002 to October 2026, giving 291
months (280 for residual momentum, which needs more history).

### Full period

| Book | Mean/mo | NW t (lag 3) | Sd/mo | Sharpe/yr | Max drawdown | Worst month | Weight avg [min–max] | Managed − plain t |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Momentum 12−1, plain | +0.45% | 1.08 | 7.04% | 0.22 | −69.9% | −49.8% (May 2009) | 1 | |
| Momentum 12−1, **vol-managed** | +1.00% | 2.38 | 7.04% | **0.49** | −50.5% | −25.4% (May 2009) | 1.23 [0.48–2.20] | **3.39** |
| Score RS, plain | +0.47% | 1.23 | 6.51% | 0.25 | −59.8% | −33.8% (May 2009) | 1 | |
| Score RS, **vol-managed** | +0.81% | 2.14 | 6.51% | **0.43** | −46.8% | −24.2% (Jan 2012) | 1.14 [0.57–2.00] | **3.29** |
| Residual (market), plain | +0.31% | 0.97 | 5.33% | 0.20 | −52.0% | −35.8% (May 2009) | 1 | |
| Residual (market), vol-managed | +0.56% | 1.76 | 5.33% | 0.36 | −47.0% | −21.8% (May 2009) | 1.18 [0.52–1.95] | 2.43 |

### Crash periods (compounded net return of the months whose holding ended in the window)

| Window | 12−1 plain | 12−1 managed | RS plain | RS managed | Residual plain | Residual managed |
|---|---:|---:|---:|---:|---:|---:|
| 2008 (crash), 12 months | −23.7% | −18.2% | −17.1% | −11.3% | −11.6% | −8.7% |
| Mar–Jun 2009 (rebound), 4 months | **−60.9%** | **−35.3%** | −51.4% | −40.5% | −46.9% | −32.1% |
| Mar–Apr 2020 (COVID), 2 months | −4.7% | −3.6% | +0.3% | +0.6% | −2.8% | −3.3% |

### Regimes and 60/40 (monthly net, NW t)

| Book | NIFTY up | NIFTY down | First 60% | Last 40% |
|---|---:|---:|---:|---:|
| 12−1 plain | +0.85% (1.76) | −0.89% (−1.26) | +0.22% | +0.81% |
| 12−1 managed | +1.47% (3.03) | −0.56% (−0.78) | +0.78% | +1.33% |
| RS plain | +0.95% (2.22) | −1.14% (−1.60) | +0.40% | +0.57% |
| RS managed | +1.31% (2.99) | −0.84% (−1.25) | +0.73% | +0.94% |
| Residual plain | +0.56% (1.64) | −0.63% (−1.22) | +0.12% | +0.60% |
| Residual managed | +0.89% (2.71) | −0.68% (−1.22) | +0.37% | +0.85% |

### Since 2010

| Book | Months | Mean/mo | NW t | Sharpe/yr | Max drawdown | Managed − plain t |
|---|---:|---:|---:|---:|---:|---:|
| 12−1 plain → managed | 201 | +0.67% → +1.19% | 1.52 → 2.32 | 0.37 → 0.59 | −49.6% → −44.4% | 3.15 |
| RS plain → managed | 201 | +0.69% → +0.98% | 1.70 → 2.35 | 0.39 → 0.53 | −41.2% → −34.6% | 2.50 |
| Residual plain → managed | 190 | +0.51% → +0.73% | 1.82 → 2.02 | 0.45 → 0.50 | −39.2% → −47.0% | 1.94 |

### What it says

* **The Barroso–Santa-Clara result holds in Indian F&O stocks.** Scaling the
  12−1 book by its recent volatility raises its Sharpe ratio from 0.22 to 0.49
  at the same overall volatility (paired t 3.4). It cuts the May 2009 momentum
  crash from −49.8% to −25.4% in the month and from −60.9% to −35.3% over
  Mar–Jun 2009. Skewness improves from −1.96 to −0.60, and kurtosis falls from
  13.1 to 4.6. The same holds for the score's own RS factor (0.25 → 0.43,
  paired t 3.3) and since 2010.
* The gain comes from both ends. The book is cut after volatile spells, which
  precede the crashes, and levered up to ~2× in calm ones. A real book would
  need that leverage (futures margin allows it), and the gain is smaller if
  leverage is capped at 1×. That is not tested here, to keep the variants few.
* It does less for residual momentum, which already has less crash risk; since
  2010 its drawdown gets worse.
* **Not a per-stock factor.** Scaling the whole book leaves every stock's rank
  unchanged, so the Lab's quintile spreads can't show it, and the setup score
  can't use it as a factor. It belongs in position sizing: how much momentum
  risk to carry this month.

## The multiple-testing guard (#24)

Every run was recorded in the trial record: 17 runs, 59 trial rows, 27
distinct trials. The guard compares each idea's best variant with the best
Sharpe ratio its trials would show by luck.

| Idea | Distinct trials | Luck benchmark SR₀/yr | Best variant | Its Sharpe/yr | Deflated Sharpe | ≥ 0.95? |
|---|---:|---:|---|---:|---:|---|
| `score-rs` | 4 | 2.27 | 21d | 0.18 | 0.000 | no |
| `momentum-12-1` | 4 | 2.08 | 21d | 0.16 | 0.000 | no |
| `residual-momentum` | 12 | 3.84 | market + sector, 21d | 0.18 | 0.000 | no |
| `vol-managed-momentum` | 7 | 0.18 | 12−1 managed | 0.49 | **0.931** | **no** |

* The Lab ideas' luck benchmarks are high because each run records 1-, 5- and
  10-session horizons, whose net Sharpe ratios are strongly negative (−4 to
  −5.6 a year at 1 day). That makes the spread of Sharpe ratios across trials
  wide. **Sensitivity:** with only the 12 monthly (21-session) trials of all
  ideas pooled, SR₀ is 0.23/yr. The best deflated Sharpe ratios are then 0.892
  (12−1 managed), 0.835 (RS managed), 0.739 (residual managed), 0.413 (score RS)
  and 0.405 (residual, market + sector). Nothing passes on either count.
* Vol-managed 12−1 is the closest. One of its 7 trials is the same book recorded
  under a mislabelled key: a first run put the overlay's `lookback` over the
  signal's own `lookback` (fixed: it is now `volLookback`). Without that
  duplicate the count is 6 and the deflated Sharpe is 0.942, which still fails.
  The official count keeps it, because the record counts every run.
* The #22 PR's earlier `momentum-12-1` 2010+ runs on the main server's record
  are the same variants and horizons, so they add no distinct trials. This
  study's record lives in the worktree's `.cache/market.db`.

### Every run (all recorded)

| # | Run | Period | Trials | Note |
|---:|---|---|---:|---|
| 1 | `npm run lab -- --signal momentum-12-1 --from 2002-01-01` | full | 4 | probe: timing; same result as #11 |
| 2–3 | `--signal residual-momentum --param factors=2 --from 2002-01-01` (twice) | full | 4 + 4 | smoke tests; same variant and result as #13 |
| 4 | `npm run lab -- overlay --signal momentum-12-1 --from 2002-01-01` | full | 2 | first overlay run; managed book stored under the mislabelled key |
| 5 | `--signal score-rs --from 2010-01-01` | 2010+ | 4 | |
| 6 | `--signal momentum-12-1 --from 2010-01-01` | 2010+ | 4 | |
| 7 | `--signal residual-momentum --param factors=1 --param scale=1 --from 2010-01-01` | 2010+ | 4 | |
| 8 | `--signal residual-momentum --param factors=2 --param scale=1 --from 2010-01-01` | 2010+ | 4 | |
| 9 | `--signal residual-momentum --param factors=1 --param scale=0 --from 2010-01-01` | 2010+ | 4 | |
| 10 | `--signal score-rs --from 2002-01-01` | full | 4 | |
| 11 | `--signal momentum-12-1 --from 2002-01-01` | full | 4 | |
| 12 | `--signal residual-momentum --param factors=1 --param scale=1 --from 2002-01-01` | full | 4 | |
| 13 | `--signal residual-momentum --param factors=2 --param scale=1 --from 2002-01-01` | full | 4 | |
| 14 | `--signal residual-momentum --param factors=1 --param scale=0 --from 2002-01-01` | full | 4 | |
| 15 | `overlay --signal momentum-12-1 --from 2002-01-01 --sub-from 2010-01-01` | full | 2 | plain book identical to #4 (stored once) |
| 16 | `overlay --signal score-rs --from 2002-01-01 --sub-from 2010-01-01` | full | 2 | |
| 17 | `overlay --signal residual-momentum --param factors=1 --from 2002-01-01 --sub-from 2010-01-01` | full | 2 | |

All runs were on 2026-11-26. Each used the F&O universe, futures-2026 costs,
quintiles and horizons 1, 5, 10, 21.

## Caveats

* Before February 2012 the market factor is the hub's equal-weight NIFTY 50
  basket of *today's* members, which carries survivorship bias. The
  NIFTY-200-day regime has the same bias for those years.
* Industries are today's classification and cover 308 of 569 stocks. Former
  members mostly have none, so the market + sector version is partly a
  market-only one.
* In the overlay, the managed book's daily re-weighting inside a month isn't
  charged, and the plain book isn't either. Leverage of up to 2.2× is assumed
  available.
* During the study runs the hub flagged every symbol's archive as "not
  complete" (143 symbols in the probe run). The data hash changed between the
  probe and run 11, but `momentum-12-1`'s report was identical to every digit
  shown, so the flag doesn't appear to have changed any bars.

## What next

* **No change to the score.** Its RS factor stays, and nothing in
  `src/core/plan/evidence` or `scoring.md` changed.
* Volatility management is the result worth keeping an eye on. It is a sizing
  rule, not a stock-selection rule: carry less momentum exposure (fewer or
  smaller RS-led positions) when the momentum book's 126-day volatility is
  high. A follow-up could test it as a position-size scale in the plan or the
  backtester, as one pre-registered trial, with leverage capped at 1×. It
  should be accepted only if it clears the guard there.
* Residual momentum could be retried if market-cap data arrives (a real size
  factor) or a point-in-time industry history (a complete sector factor).
  Neither is planned.
