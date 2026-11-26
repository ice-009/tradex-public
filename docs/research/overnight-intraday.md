# Overnight vs intraday returns for BTST (issue #28)

**Verdict: the effect is very strong before costs, but it fails the Lab's gate as a
long–short strategy. The BTST ranking is unchanged.**

Lou, Polk & Skouras (2019) describe a "tug of war" between overnight and intraday
returns, and it is clearly present on NSE F&O. Stocks that rose overnight over the
last month keep rising overnight. Stocks that rose intraday give it back overnight.
Sold at the next open, the top-minus-bottom quintile earns 0.155% a night gross,
with a Newey–West t of 33.6 (2010–26). It holds in both market regimes and in both
parts of the 60/40 split.

A long–short book has to pay two futures round trips every night (0.33%), so net
it loses 0.18% a night. Its deflated Sharpe ratio is 0.000 against the 0.95 bar.
By the promotion rule (#24: only a variant that clears the DSR bar feeds the
score), it can't go into the score as tested.

Inside the BTST screens' own matches the picture is different. Their cost is paid
either way, and there the same signal sorts trades far better than the screens'
scores do (see "BTST ranking check" below). Wiring it in is left as a decision for
review, for two reasons:

1. The gate it would need, one for cost-neutral ranking inside a screen, doesn't
   exist yet.
2. Part of the effect may come from NSE's closing price being a 30-minute VWAP
   rather than a price a BTST buyer actually pays. Only intraday bars can rule
   that out.

## What was added

- `forward: "close-open"` in the Lab (`LabRequest.forward`, `npm run lab -- --forward close-open`).
  The forward return is open(t + k) / close(t) − 1: bought at the formation close
  and sold at the open k sessions later. k = 1 is the BTST trade. The default stays
  close → close. An open that gaps more than ±50% from the previous close (an
  unadjusted open, a bad print) counts as a data error, as closes already do. The
  "net at turnover" figure is not reported in this mode, because these positions
  are sold at every open and each rebalance is a full round trip.
- `reverse` (`--reverse`): rank by minus the signal.
- Signals `overnight-return` (sum of the last N sessions' log(open / previous
  close)) and `intraday-return` (sum of log(close / open)). Each is null over a
  window that contains a session whose open can't be split (gap beyond ±50%).

**Are the opens adjusted?** Yes. The hub's split and bonus factors apply to opens
too. Across a split or bonus, the open lines up with the adjusted previous close:
RELIANCE's 1:1 bonus (ex 2017-09-07) shows a +0.03% gap that morning. Across all
F&O bars 2000–2026 (2.46 million), none lacks an open. 1,575 sessions show the
sign of a bad open print: a gap beyond ±15% undone in the same session by an
opposite move beyond ±15%. Most of them come before 2014:

| Years | Sessions with a "bad open" | Per 100,000 bars |
|---|---|---|
| 2000–2009 | 1,293 | 174 |
| 2010–2013 | 193 | 44 |
| 2014–2026 | 89 | 7 |

NSE's pre-open call auction (from October 2010, widened later) is the likely
reason. The primary period starts in 2010, and the 2020–26 part of the split is
almost free of them.

## Trials

4 variants × 1 horizon (h = 1, the BTST trade, pre-registered) = **4 trials**:

| Variant | Signal | Hypothesis |
|---|---|---|
| 28a | `overnight-return` lookback 21, forward close-open | overnight momentum, 1 month |
| 28b | `overnight-return` lookback 252, forward close-open | overnight momentum, 12 months (LPS's horizon) |
| 28c | `intraday-return` lookback 21, forward close-open | intraday momentum carried overnight |
| 28d | `intraday-return` lookback 21, **reversed**, forward close-open | the cross-period reversal (high past intraday → low overnight) |

28c and 28d mirror each other, and both were run because the issue asked for
both. Each variant was run on 2010+, on 2002+, and on 2010+ again (re-runs don't
add trials), and 28a once more from the CLI. Luck benchmark for the best of 4:
annual Sharpe 5.37 net and 6.42 gross (2010+).

Not a Lab trial, but a fifth look at the data: the BTST ranking check below.

## Results

h = 1 (close → next open), quintiles by signal (Q5 = highest), gross mean per
night. Net = the spread after two round trips (0.332%). The gross split and regime
columns add the two legs' cost back to the net figures.

**2010-01-04 – 2026-11-26** (4,193 nights, 474 stocks, ~181 a night; split at 2020-02-24)

| Variant | Q1 | Q2 | Q3 | Q4 | Q5 | Q5−Q1 gross (NW t) | IC | net (NW t) | DSR net | gross: up / down | gross: first 60% / last 40% | DSR gross |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 28a overnight 21d | +0.088% | +0.132% | +0.162% | +0.192% | +0.243% | **+0.155% (33.6)** | 0.102 | −0.177% (−38.5) | 0.000 | +0.152% / +0.163% | +0.164% / +0.141% | 1.000 |
| 28b overnight 252d | +0.084% | +0.136% | +0.161% | +0.192% | +0.241% | **+0.157% (36.0)** | 0.104 | −0.175% (−40.2) | 0.000 | +0.149% / +0.182% | +0.163% / +0.147% | 1.000 |
| 28c intraday 21d | +0.219% | +0.174% | +0.155% | +0.138% | +0.127% | −0.091% (−17.9) | −0.062 | −0.423% (−82.8) | 0.000 | −0.075% / −0.145% | −0.105% / −0.071% | 0.000 |
| 28d intraday 21d reversed | +0.127% | +0.140% | +0.156% | +0.175% | +0.219% | **+0.092% (17.9)** | 0.062 | −0.240% (−46.7) | 0.000 | +0.075% / +0.146% | +0.106% / +0.071% | 0.000 |

**2002-01-01 – 2026-11-26** (6,191 nights, 568 stocks; split at 2016-12-01)

| Variant | Q1 | Q5 | Q5−Q1 gross (NW t) | net (NW t) | DSR net | gross: up / down | gross: first 60% / last 40% | DSR gross |
|---|---|---|---|---|---|---|---|---|
| 28a overnight 21d | +0.106% | +0.320% | +0.214% (36.9) | −0.118% (−20.3) | 0.000 | +0.211% / +0.224% | +0.267% / +0.135% | 0.9995 |
| 28b overnight 252d | +0.108% | +0.317% | +0.209% (38.3) | −0.123% (−22.6) | 0.000 | +0.201% / +0.237% | +0.256% / +0.139% | 1.000 |
| 28c intraday 21d | +0.305% | +0.126% | −0.179% (−27.9) | −0.511% (−79.6) | 0.000 | −0.159% / −0.250% | −0.255% / −0.066% | 0.000 |
| 28d intraday 21d reversed | +0.126% | +0.305% | +0.179% (28.0) | −0.153% (−23.9) | 0.000 | +0.159% / +0.250% | +0.254% / +0.066% | 0.000 |

The gross DSR is the deflated Sharpe ratio of the gross spread against the 4
gross trials. It is not the promotion rule. It is shown because a ranking among
trades already taken pays no extra cost. 28d's gross DSR is 0 because its annual
Sharpe (4.4) is below the 6.4 that the best of four trials would reach by luck,
given how far apart the four are.

**It lasts one night.** In decay, 28a's spread is +0.155% at the first open. After
that, each further session's open-to-open part is negative (−0.02% a day, t about
−1.5), so by 10 sessions the gross spread is gone. Overnight winners give it back
during the day, which is the tug of war. Holding the trade longer only adds cost.

**The overnight drift.** Every quintile earns about +0.09% to +0.24% a night.
Close to open, the average F&O stock rose about 0.16% a night in 2010–26, and it
gave that back intraday. So the long leg alone, Q5 of 28a, nets +0.077% a night
after one round trip. But that is a bet on the market's overnight drift, not on
the signal. Some of the drift is probably measurement: NSE's official close is the
volume-weighted price of the last 30 minutes, while the open is the pre-open
auction price.

## BTST ranking check (plan evidence, before and after)

Both BTST screens were replayed with the plan's evidence rules
(`src/core/plan/evidence.ts`): F&O point in time, 2010+, entry at the signal close,
stop at the day's low (at most 1 ATR), out at the next open, futures costs, net R.
Each screen's matches were then sorted into thirds two ways: by the screen's own
score ("before") and by 28a's past 21-session overnight return ("after").

| Screen | Regime | Trades | Mean net R (t over days) | Score: top / bottom third (t) | Overnight 21d: top / mid / bottom third (t) | Top third by overnight: mean R (t), first / last 40%, passes? |
|---|---|---|---|---|---|---|
| Closing-strength breakout | all | 11,540 | +0.064 (11.1) | +0.075 / +0.056 (2.5) | **+0.107 / +0.061 / +0.024 (11.4)** | +0.107 (14.7), +0.105 / +0.111, yes |
| | NIFTY up | 10,177 | +0.069 (11.6) | +0.081 / +0.058 (2.8) | +0.114 / +0.061 / +0.033 (10.5) | +0.114 (14.4), yes |
| | NIFTY down | 1,363 | +0.026 (1.75), fails | +0.030 / +0.046 (−0.7) | +0.056 / +0.042 / −0.020 (3.2) | +0.056 (3.5), +0.070 / +0.035, **yes** |
| 20-day high into the close | all | 8,256 | +0.061 (9.0) | +0.081 / +0.044 (4.0) | **+0.100 / +0.052 / +0.030 (7.7)** | +0.100 (11.7), +0.105 / +0.092, yes |
| | NIFTY up | 7,134 | +0.067 (9.8) | +0.091 / +0.046 (4.4) | +0.107 / +0.061 / +0.033 (7.7) | +0.107 (12.0), yes |
| | NIFTY down | 1,122 | +0.020 (0.5), fails | +0.015 / +0.027 (−0.4) | +0.029 / +0.027 / +0.004 (1.0) | +0.029 (1.0), fails |

Ranked by past overnight return, the top third of each screen's matches earns
about 1.6× the screen's average. Its top-minus-bottom gap has a t of 7.7–11.4,
against 2.5–4.0 for the screens' own scores. For closing strength it would also
turn the down-market bucket from failing to passing.

This is the strongest result in this round, and it is **not wired in** for these
reasons:

1. It didn't pass the promotion gate the score is bound to (#24). The Lab gate
   tests a stand-alone long–short trade net of costs. Using the signal to rank
   trades the plan takes anyway is a different claim, and it needs its own
   pre-registered test, such as a cost-neutral "screen-score" gate in the Lab.
   Changing the rule after seeing the result would defeat the point of the guard.
2. The close in these bars is NSE's 30-minute VWAP, but a BTST buyer pays the
   price at 3:15–3:25 PM. If a stock's late-session drift persists, it would
   inflate both the past overnight return and the next one. Checking this needs
   the 15-minute bars, whose download is paused.

**Suggested follow-up** (not done here): (a) re-measure 28a with entries at the
15:15–15:25 price from 15-minute bars; (b) if it survives, add
`overnight-return(21)` as a ranking term for the two BTST screens. That means
re-running this before/after table as the pre-registered test, checking it
through a cost-neutral ranking gate, and recording it as one more trial of the
`overnight-return` idea.

## Sources

- Lou, Polk & Skouras (2019), "A tug of war: overnight versus intraday expected returns", *Journal of Financial Economics* 134(1). <https://researchonline.lse.ac.uk/id/eprint/87481>
- NSE closing price: the volume-weighted average of the last 30 minutes of trade (cited in the BTST screens, `src/core/screener/screens.ts`).
