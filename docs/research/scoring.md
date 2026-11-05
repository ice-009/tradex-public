# Setup score and the Compare view ("pick 1 of 5–10")

Code: `src/lib/screener/score.ts` (pure scoring), `factsFrom()` (server), `scorePlan()` / `scoreHit()` in `src/terminal/screenerData.ts`, the Score column (`ScreenerPanel.tsx`), the setup card breakdown (`SetupCard.tsx`), the Compare tab (`ComparePanel.tsx`, data from `/api/analyze`).

**What it is.** A checklist with points. It ranks a shortlist on one scale and shows *why* one candidate beats another. It is not a fitted model, and nothing here has been optimised on past returns. The weights are deliberately round. The only performance evidence in the score is the setup's own track record (factor 8).

## Factors (100 points)

| Factor | Max | How the points are given | Why it's in |
|---|---|---|---|
| Trend | 15 | Close > 50 SMA (4), 50 > 200 SMA (4), 200 SMA rising over 22 sessions (3), close > 20 EMA (4) | Minervini's Trend Template, used by the positional screens |
| Relative strength | 15 | RS rank (1–99) × 15/99. IBD-style weighted 12-month return, ranked in the universe (Compare: against all cached Nifty 500 + F&O stocks) | George & Hwang (2004) and the momentum literature cited in screeners.md |
| Accumulation | 10 | Up-day ÷ down-day volume over 20 sessions: 0.8× → 0, 1.8× → 6. Delivery % ÷ its 20-day average: 0.8× → 0, 1.5× → 4 (2 when unknown) | Delivery-based buying (Zerodha / Upstox notes in screeners.md); up/down volume is the classic accumulation measure |
| Chart pattern | 15 | Pattern quality × (15 on a fresh breakout, 12 while forming, 4 if extended) | patterns.md |
| Reward : risk | 15 | 1R → 0, 3R → 15, measured to the **nearer of the target and the next resistance** | Varsity: R:R ≥ 1.5. Resistance in the way caps the realistic reward |
| Stop distance | 10 | 2–6% below entry → 10; 1–2% → 7; < 1% → 3 (inside noise); 6–8% → 6; > 8% → 2 | O'Neil / MarketSmith 7–8% maximum loss; very tight stops get hit by noise |
| Not extended | 10 | Close vs 20 EMA in ATRs: ≤ 1.5 → 10, ≤ 2.5 → 6, ≤ 3.5 → 3, else 0 | Chasing an extended move worsens R:R and raises pullback risk |
| Track record | 10 | Replay avg R of the setup's rules: ≥ +0.3 → 10, ≥ +0.1 → 7.5, > −0.1 → 4, else 0. Neutral 5 with < 20 signals or no setup | The only outcome-based factor (see the Track record section of screeners.md) |

**Penalties:**
- Results inside the holding period: −10, or −15 within a day (BTST).
- A heavy gap-down in the last 10 sessions: −8. This is the bad-news drift from the BSE 500 study.
- A descending triangle forming: −5.
- Turnover under ₹5 cr/day: −5.

**Grades:** A ≥ 75, B ≥ 60, C ≥ 45, D below.

## Which plan gets scored
- **Screener rows:** each (stock, setup) pair is scored with that setup's plan.
- **Compare:** every stock in the chosen list (up to 20) gets a plan read off its own chart (`chartPlan()`: pattern levels, else support/resistance), plus one plan per screener setup it matches. The **best-scoring** plan represents the stock.
- The columns are then ranked. The top one is marked, and a one-line verdict names its two strongest factors and any penalties.
- Qty uses your capital and max-loss setting from the setup card. It's the smaller of (capital × max loss %) ÷ (entry − stop) and capital ÷ entry.

## Limits
- Weights are judgement calls; change them in `score.ts` if your own trading suggests otherwise.
- Factors overlap (trend and RS are correlated), so a strong trend counts more than its 15 points suggest.
- A high score means "fits the checklist", not "will go up". Check the chart and the results date before you trade.
