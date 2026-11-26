# IIMA factor check: is our history sound?

Issue [#25](https://github.com/ice-009/tradex-public/issues/25). We rebuild the momentum factor (WML) and the
market factor from the Market Data Hub's NSE archive and compare them with the Indian Fama-French and momentum
factors that IIM Ahmedabad publishes
([data library](https://faculty.iima.ac.in/iffm/Indian-Fama-French-Momentum/), release 2025-12, October 1993 →
December 2025). If the two track each other closely, our split/bonus-adjusted, survivorship-free daily closes
are sound. The months where they don't are where to look for data bugs.

```
npm run research -- iima-check                  # tables to stdout and .cache/research/iima/report.md
npm run research -- iima-check --json out.json  # plus every month's numbers, the jumps and the missed factors
npm run research -- iima-check --weights ew     # equal weights for the headline and the investigated months
```

Code: `src/core/research/iima.ts` (pure: IIMA file parsers, monthly panel, portfolios, statistics, missed-split
detectors; unit-tested), `scripts/research/iimaData.ts` (downloads and caches), `scripts/research/iimaCheck.ts` (the
study). The first run downloads about 400 files and needs HUB_URL/HUB_KEY. Later runs read `.cache/research/iima/`
and take about a minute.

## Data and licence

- **IIMA's files** (monthly and daily factors, the four size-momentum portfolios, the momentum breakpoints).
  The site says how to cite the data (Agarwalla, Jacob & Varma 2013, IIMA W.P. 2013-09-05) but gives no licence
  for redistributing it. So **no copy is committed**: the check downloads the files at run time from the URLs
  above (one request for the page, four for the files, then cached) and the unit tests use made-up rows.
- **The universe.** The hub serves any ticker's archive but cannot list them
  ([market-data-hub#60](https://github.com/ice-009/market-data-hub/issues/60)). The check therefore reads NSE's cash
  bhavcopy for the last session of each month (384 files, one request every 1.5 s) and takes every EQ/BE ticker
  in them: 5,156 tickers once 397 ETFs/funds are dropped (ISIN `INF…` or fund-like tickers). After the hub joins
  renamed tickers that is **4,482 listings**, delisted companies included.
- **Prices.** As-traded daily bars from `GET /v1/candles/batch?adjust=none` (40 symbols a request) × the hub's
  split/bonus factors from `GET /v1/adjustments/batch`. This is exactly how the hub builds its archive's
  `adjust=split` series. Reading as traded keeps the run off the broker: `adjust=split` would queue a Fyers
  download for each of the ~4,000 stocks the hub doesn't hold. The broker's 5-year window, which the hub
  scales to its own adjustments, is not used; the archive is used throughout. All requests are GET-only.

## Method: IIMA's and ours

| | IIMA | here |
|---|---|---|
| universe | BSE + NSE (CMIE Prowess) | NSE cash bhavcopy, EQ and BE series, delisted included |
| liquidity | traded on ≥ 50 days in the past 12 months | the same |
| penny filter | median price over the past year < ₹1 out | the same (median month-end close as traded) |
| micro-cap filter | market cap < 10% of the median out (~26% of stocks) | bottom 25% by traded value out |
| size | big = top 10% by market cap | top 10% by median daily traded value over 12 months |
| momentum | return over months t−11..t−1 (12-1), top/bottom 30%, breakpoints over all stocks | the same |
| WML | ½(WB − LB) + ½(WS − LS), value-weighted, a leg with < 5 stocks dropped | the same, weighted by traded value or equally |
| returns | total returns (dividends in), daily, compounded to months | price returns, month-end to month-end, buy and hold |
| market | value-weighted, every stock in the factor portfolios, minus the 91-day T-bill | the filtered universe, weighted as above, minus IIMA's own RF |
| vanishing firms | −100% when the last price was < 50% of face value | not modelled (no face value) |

**Market cap is the gap that matters.** The hub stores no shares outstanding (see
[market-data-hub#27](https://github.com/ice-009/market-data-hub/issues/27)), so traded value stands in for size
and for the weights. It ranks stocks reasonably well (big is big either way), but as a weight it concentrates
on whatever is traded hardest that year: RELCAPITAL, YESBANK, IBULHSGFIN, HIMACHLFUT. IIMA's portfolios hold
the same names at their (smaller) market-cap weight. Equal weights avoid that, but they are further from
IIMA's method in another way. We report both. Comparability is therefore best for correlations and month
patterns, and weakest for mean returns. Our market return also lacks dividends (about 1–1.5% a year).

NSE opened in November 1994, and the hub serves its archive only from 7 September 1995
([market-data-hub#59](https://github.com/ice-009/market-data-hub/issues/59)). The first full 12-1 momentum
window therefore ends in September 1996, so WML is compared from October 1996 (351 months) and the market
from January 1996 (360 months), both to December 2025.

## Results (run 2026-11-26)

### Correlations, tracking error, means and volatility

Monthly; means × 12, volatilities and tracking error × √12; beta = slope of ours on IIMA's.

| Series | Weights | Period | Months | Corr. | Tracking error | Mean ours | Mean IIMA | Vol ours | Vol IIMA | Beta |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **WML** | traded value | 1996–2025 | 351 | **0.84** | 14.8% | 13.3% | 13.8% | 26.8% | 25.0% | 0.90 |
| **WML** | equal | 1996–2025 | 351 | **0.86** | 13.0% | 16.3% | 13.8% | 23.2% | 25.0% | 0.79 |
| WML | traded value | 1996–2000 | 51 | 0.86 | 19.6% | 30.3% | 3.0% | 34.6% | 38.7% | 0.77 |
| WML | traded value | 2001–2010 | 120 | 0.87 | 14.7% | 7.7% | 17.4% | 30.2% | 28.0% | 0.94 |
| WML | traded value | 2011–2020 | 120 | 0.84 | 13.4% | 13.1% | 16.3% | 24.4% | 19.1% | 1.08 |
| WML | traded value | 2021–2025 | 60 | 0.66 | 10.1% | 10.5% | 11.1% | 13.0% | 11.2% | 0.77 |
| WML | equal | 2021–2025 | 60 | 0.73 | 8.7% | 13.8% | 11.1% | 12.1% | 11.2% | 0.79 |
| **Market − Rf** | traded value | 1996–2025 | 360 | **0.91** | 15.0% | 6.1% | 9.7% | 33.4% | 24.2% | 1.26 |
| **Market − Rf** | equal | 1996–2025 | 360 | **0.87** | 16.2% | 10.5% | 9.7% | 32.3% | 24.2% | 1.16 |
| Market − Rf | traded value | 2011–2020 | 120 | 0.95 | 10.3% | −1.2% | 4.0% | 24.7% | 16.7% | 1.40 |
| Market − Rf | traded value | 2021–2025 | 60 | 0.96 | 4.4% | 12.6% | 12.4% | 16.2% | 14.5% | 1.08 |
| WB (big winners) | traded value | all | 348 | 0.85 | | 17.2% | 22.9% | | | 0.98 |
| WS (small winners) | traded value | all | 351 | 0.94 | | 23.9% | 24.6% | | | 0.85 |
| LB (big losers) | traded value | all | 343 | 0.88 | | 5.0% | 13.1% | | | 1.00 |
| LS (small losers) | traded value | all | 351 | 0.95 | | 9.6% | 13.7% | | | 0.94 |
| WS / LS | equal | all | 351 | 0.96 / 0.98 | | | | | | |

**Momentum breakpoints.** The 12-1 return of the 30th and 70th percentile stock at each formation month is a
direct test of our price history, independent of weights. It correlates **0.96 / 0.95** with IIMA's published
breakpoints. Our averages are −9.3% / +37.3% against IIMA's −14.1% / +38.5%: our losers lose a little less,
consistent with a universe that leaves out BSE-only small caps and IIMA's −100% for vanishing firms.

**Rolling 36-month correlation.** For WML it is 0.85–0.93 almost throughout. It falls to 0.62–0.73 in 2004–2007,
with a low of **0.46 in the 36 months to September 2007**, and to 0.62–0.69 in 2019 and 2023–2025: quiet momentum
years, in which a few heavily traded names move our traded-value weights more than IIMA's market-cap ones. For
the market it is 0.86–0.92 before 2005 and **0.91–0.98 since**.

(As a consistency check, IIMA's monthly WML equals its daily WML compounded: correlation 1.0000.)

### The months that differ most

| Holding month | Ours | IIMA | Gap | Universe | WB/WS/LB/LS stocks |
|---|---:|---:|---:|---:|---|
| 2009-05 | −43.6% | −25.0% | −18.6% | 937 | 43/229/25/247 |
| 1997-01 | 2.8% | −13.9% | 16.6% | 931 | 60/204/10/254 |
| 2019-09 | 13.4% | −2.5% | 16.0% | 1,156 | 57/283/18/322 |
| 2020-06 | −21.6% | −5.8% | −15.8% | 1,146 | 52/277/18/311 |
| 2001-02 | 2.6% | 16.4% | −13.8% | 712 | 20/178/26/172 |
| 2000-04 | −7.5% | −21.1% | 13.7% | 799 | 45/187/13/219 |
| 1998-01 | 0.6% | −11.9% | 12.5% | 930 | 61/210/6/265 |
| 1999-09 | 21.2% | 8.9% | 12.2% | 850 | 45/203/14/234 |

We broke each month down stock by stock (the check prints each stock's weight in its leg, its return and its
share of our WML, and flags any unexplained price jump in the momentum window or the holding month):

- **2009-05** (the election-result rally): both factors crash. Ours crashes harder because the big-loser leg is
  18% RELCAPITAL, 12% DLF, 9% TATASTEEL, 6% HDIL and 6% UNITECH by traded value, each up 70–94% that month. These
  are real moves. The difference is weighting.
- **1997-01**: RELIANCE and SBIN (+30%, +17%) are a third each of our big-winner leg, and the big-loser leg has
  only 10 stocks. The difference is weighting and the thin 1997 NSE universe; no bad prices.
- **2019-09**: YESBANK (−31%) and IBULHSGFIN (−44%) are 28% and 17% of our big-loser leg (very heavily traded,
  much smaller by market cap). Real prices.
- **2020-06**: IBULHSGFIN +70% at 19% of the big-loser leg. Real.
- **2001-02** and **2000-04** (the dot-com bust): HIMACHLFUT is 63% of our big-winner leg in February 2001 and
  ITC 58% of the big-loser leg in April 2000. Concentration again. One small-loser stock (COMPUTECH) has an
  unexplained −67% jump in its window (a likely missed bonus, see below), but its share of the gap is under 1 point.
- **2021-02** and **2024-01** (the largest gaps since 2021, −8.5 and +6.7 points): SBIN, INDUSINDBK, RVNL, IRFC
  and HDFCBANK. Real moves at traded-value weights.

None of the large gaps traces back to a bad price, a missing day or a wrong adjustment. They come from the size
and weight proxy, and from the narrower NSE-only universe in the 1990s.

### Data bugs found

1. **Splits and bonuses without a factor**
   ([market-data-hub#58](https://github.com/ice-009/market-data-hub/issues/58)). In 48 listings, NSE's
   corporate-actions file lists a split or bonus, the price falls by that ratio on the ex-date, and the hub has
   no factor. Among them: TITAN 2011 (÷20), ONGC 2011 (÷4), INFY 2015 (bonus), TECHM 2015 (÷4), HINDZINC 2011
   (÷10), BAJFINANCE 2016 (÷10), NATIONALUM 2011 (÷4), CONCOR 2018 (÷2). The causes are combined bonus + split
   purposes, `FV SPL` spellings, truncated purposes and bonuses without a ratio. Before 2010, with no
   corporate-actions file, the same check finds 476 split-like gaps (a session-to-session fall to a standard
   ratio that stays) in 254 stocks, mostly in 1996–2001. Some are real crashes or demergers; candidates include
   SUZLON 2008 (1:5), MASTEK 2003, DIVISLAB 2009 and KECINFRA 2006. In all, 1,328 adjusted one-day falls beyond
   −45% remain in 474 stocks; about 40% of them recover within days (bad prints, or sub-₹1 stocks ticking 0.10 → 0.05).
2. **History before 7 Sep 1995 is stored but never served**
   ([market-data-hub#59](https://github.com/ice-009/market-data-hub/issues/59)). NSE answers 6 Sep 1995 with an
   empty file, and the hub's coverage walk stops there.
3. **No list of the archive's tickers** ([market-data-hub#60](https://github.com/ice-009/market-data-hub/issues/60)):
   the reason this check reads NSE's month-end files itself.

Also checked: on 12 days BSE traded in 1996–1998, NSE has no cash file (404). The hub holds no bars for those
days. No other session is missing, and only 4 are thin (fewer than 60% of the neighbouring sessions' stocks:
1997-02-28, 1998-03-23, 2001-07-23, and 2009-05-18, the election-result day the market closed at its upper
circuit). The 77 missing index-file days of
[market-data-hub#57](https://github.com/ice-009/market-data-hub/issues/57) don't touch this check, which reads
only the cash archive.

**Do the bugs move the factors?** Barely. With the 48 listed splits fixed, the WML correlation stays at 0.84
(value) and 0.86 (equal) for 2011–2025 and the means move by under 1 point a year. With *every* split-like gap
treated as a missed split (an upper bound, since it also "fixes" real crashes), the full-period WML correlation
is 0.84 / 0.85 and the market's 0.91 / 0.87. The 1996–2000 WML mean stays near 30% against IIMA's 3%. A few
hundred mis-adjusted small caps among ~1,000 stocks a month are diluted at the portfolio level, so the factor
check can't see them, while single-stock tools (charts, screeners, backtests) can. #58 matters for those.

## Verdict

**The archive is sound at the portfolio level.** From NSE files alone and with traded value standing in for
market cap, the rebuilt factors track IIMA's closely:

- WML correlation 0.84 (traded value) / 0.86 (equal weights), 1996–2025, about 0.9 in most 36-month windows;
- the market 0.91 / 0.87 overall and 0.95–0.96 since 2011;
- the four momentum portfolios 0.85–0.98;
- IIMA's momentum breakpoints 0.95–0.96.

The long-run WML premium matches too (13.3–16.3% a year against IIMA's 13.8%). The largest monthly gaps are
explained by weights (heavily traded names) and the NSE-only 1990s universe, not by bad prices.

Remaining issues are real but local: 48 listed splits/bonuses without a factor (hub #58, several in F&O blue
chips) and likely more before 2010, and ten months of 1994–95 that aren't served (hub #59). Fix #58 before
trusting single-stock results across those ex-dates. With market caps from the hub (#27) and a ticker list
(#60), this check could value-weight like IIMA. The correlation should then rise further, and the remaining
gaps would point more sharply at data.

No new Signal Lab signal: the Lab already ships `momentum-12-1` (the same 12-1 ranking on the F&O universe).
This study's universe (every NSE stock, delisted included) and its monthly portfolios don't fit the Lab's
daily, F&O-universe engine.
