import { roundToTick } from "@/core/market/ticks";
import { FAR_ATR } from "@/core/screener/planStatus";
import type { Features } from "@/core/screener/features";
import type { StockFacts } from "@/core/screener/score";

// Screen definitions for BTST, swing (3–10 sessions) and positional
// (15–30 sessions) trades. Each rule is a named check so the UI can show
// exactly which conditions a stock met. Thresholds come from the sources
// listed per screen; where a source gives a range, the stricter end is used.
// Each screen cites its sources (`sources`). Educational, not advice.

export type ScreenGroup = "btst" | "swing" | "positional" | "results";

export interface ScreenContext {
  /** NIFTY 50's 126-session (≈6-month) return, for relative-performance checks. */
  niftyRet126: number;
}

export interface Rule {
  label: string;
  test(f: Features, ctx: ScreenContext): boolean;
}

export interface TradePlan {
  entry: number;
  stop: number;
  target: number | null;
  exit: string;
}

/** One matching stock, as returned by /api/screener. */
export interface ScreenerRow {
  symbol: string;
  name: string;
  industry: string;
  date: number;
  live: boolean;
  close: number;
  changePct: number;
  volRatio: number;
  deliveryPct: number | null;
  rsi14: number;
  rsRank: number;
  score: number;
  tags: string[];
  plan: TradePlan;
  /** Cautions that don't block the setup (e.g. a recent heavy gap-down). */
  warnings?: string[];
  /** Inputs for the setup score (src/core/screener/score.ts). */
  facts?: StockFacts;
  /** When this setup first matched today (epoch ms), from the screener's live re-runs. */
  firstSeenAt?: number;
}

/** One stock in the market overview (movers / sectors), whether or not it matched a screen. */
export interface MarketRow {
  symbol: string;
  name: string;
  industry: string;
  close: number;
  changePct: number;
  volRatio: number;
  ret5: number;
  ret21: number;
  /** Close as % of the 52-week high (100 = at the high). */
  ofHigh52: number;
}

export interface SectorStat {
  sector: string;
  count: number;
  /** Median % change today / 5 sessions / 21 sessions. */
  change: number;
  ret5: number;
  ret21: number;
  /** Share of the sector up today, 0–1. */
  breadth: number;
  symbols: string[];
}

export interface MarketOverview {
  gainers: MarketRow[];
  losers: MarketRow[];
  active: MarketRow[];
  highs: MarketRow[];
  sectors: SectorStat[];
}

export interface Source {
  label: string;
  url?: string;
}

export interface ScreenDef {
  id: string;
  group: ScreenGroup;
  name: string;
  horizon: string;
  /** "eod" screens need completed-session data (delivery %), so they ignore today's live bar. */
  basis: "live" | "eod";
  summary: string;
  rules: Rule[];
  score(f: Features): number;
  plan(f: Features): TradePlan;
  tags?(f: Features): string[];
  sources: Source[];
  /** Mean-reversion setup that buys weakness on purpose (a red day is the signal, not a warning). */
  buysWeakness?: boolean;
}

export const SCREEN_GROUPS: Array<{ id: ScreenGroup; label: string; horizon: string; note: string }> = [
  {
    id: "btst",
    label: "BTST",
    horizon: "Overnight",
    note: "Run 3:00–3:25 PM IST: NSE's official close is the volume-weighted price of the last 30 minutes. In stock futures (NRML) there's no delivery or auction risk — unlike a cash BTST — but the overnight gap risk is the same, and one lot is a large position: size it on the setup card.",
  },
  { id: "swing", label: "Swing", horizon: "3–10 sessions", note: "Daily-chart setups for trades held a few days to two weeks." },
  { id: "positional", label: "15–30 days", horizon: "3–6 weeks", note: "Trend and breakout setups for holds of roughly 15–30 trading sessions." },
  {
    id: "results",
    label: "Results",
    horizon: "After a news gap",
    note: "Reactions to results and other news: a big gap on heavy volume. Evidence for post-results drift in India is mixed (IIM-B found drift; a 2014–18 NSE study found the market efficient; a BSE-500 study found drift mainly after bad news), so check each screen's track record.",
  },
];

const S = {
  zerodhaBtst: { label: "Zerodha Support — BTST risk (short delivery, auction penalty up to 20%)", url: "https://support.zerodha.com/category/trading-and-markets/trading-faqs/articles/btst-risk" },
  lps: { label: "Lou, Polk & Skouras (2019), A Tug of War: Overnight vs Intraday Expected Returns, J. Financial Economics", url: "https://personal.lse.ac.uk/polk/research/TugOfWar.pdf" },
  georgeHwang: { label: "George & Hwang (2004), The 52-Week High and Momentum Investing, J. Finance 59(5)", url: "https://doi.org/10.1111/j.1540-6261.2004.00695.x" },
  nseClose: { label: "Upstox — LTP vs closing price (NSE close = VWAP of last 30 min)", url: "https://upstox.com/learning-center/demat-account/difference-between-ltp-and-closing-price/article-1565/" },
  varsityMa: { label: "Zerodha Varsity — Moving Averages (9/21 few sessions, 25/50 few weeks)", url: "https://zerodha.com/varsity/chapter/moving-averages/" },
  varsityRsi: { label: "Zerodha Varsity — Indicators Part 1 (RSI)", url: "https://zerodha.com/varsity/chapter/indicators-part-1/" },
  varsityFinale: { label: "Zerodha Varsity — The Finale (volume ≥ average, R:R ≥ 1.5)", url: "https://zerodha.com/varsity/chapter/finale-helping-get-started/" },
  varsityAdx: { label: "Zerodha Varsity — Supplementary notes (ADX > 25 = strong trend)", url: "https://zerodha.com/varsity/chapter/supplementary-notes-1/" },
  rsi2: { label: "StockCharts ChartSchool — RSI(2) (Connors & Alvarez)", url: "https://chartschool.stockcharts.com/table-of-contents/trading-strategies-and-models/trading-strategies/rsi-2" },
  crabel: { label: "Toby Crabel (1990), Day Trading with Short Term Price Patterns and Opening Range Breakout (NR7)" },
  kiteDelivery: { label: "Zerodha Support — Delivery volume % on Kite", url: "https://support.zerodha.com/category/trading-and-markets/general-kite/kite-mw/articles/delivery-volume-percentage-on-kite" },
  upstoxDelivery: { label: "Upstox — Trade volume vs delivery volume", url: "https://upstox.com/learning-center/online-trading/trade-volume-vs-delivery-volume/article-1714/" },
  nseReports: { label: "NSE — Security-wise delivery data (sec_bhavdata_full)", url: "https://www.nseindia.com/all-reports" },
  minervini: { label: "Mark Minervini (2013), Trade Like a Stock Market Wizard — Trend Template" },
  chartmill: { label: "ChartMill — Minervini Trend Template, step by step", url: "https://www.chartmill.com/documentation/stock-screener/technical-analysis-trading-strategies/496-Mark-Minervini-Trend-Template-A-Step-by-Step-Guide-for-Beginners" },
  ibdBreakout: { label: "IBD (via inkl) — breakout volume 40–50% above 50-day average, buy zone ≤ 5%", url: "https://inkl.com/news/how-finding-a-breakout-can-help-you-achieve-maximum-gains" },
  marketsmith: { label: "MarketSmith India — sell if 8% below purchase price", url: "https://blog.marketsmithindia.com/?p=3317" },
  dayTraderScanner: { label: "Day Trader skill — trader-scanner daily setups (bull flag, reclaim 20-day average, oversold bounce), MIT", url: "https://github.com/jakeschincariol/day-trader-skill/tree/main/trader-scanner" },
  bernardThomas: { label: "Bernard & Thomas (1989), Post-Earnings-Announcement Drift: Delayed Price Response or Risk Premium?, J. Accounting Research 27 (supplement)" },
  iimbPead: { label: "IIM Bangalore repository — post-earnings drift in NSE share prices over 120 days", url: "https://repository.iimb.ac.in/handle/2074/17935" },
  nsePeadEfficient: { label: "Post-Earning Announcement Drift and Value-Glamour Anomalies in NSE Listed Firms (2014–2018 sample)", url: "https://journals.vutbr.cz/index.php/trends/article/view/541" },
  bse500Pead: { label: "Earnings Announcements and Stock Price Behaviour: an event study on India (BSE 500, FY2007–12) — drift after bad news", url: "https://eprints.nottingham.ac.uk/26569" },
  episodicPivot: { label: "Episodic Pivot (Pradeep Bonde / Stockbee): big gap on a catalyst, volume a multiple of average, close near the high, stop under the day's low", url: "https://tradingsim.com/blog/episodic-pivot-power-earnings-gap-buyable-gap-up-explained/" },
  chartPatterns: { label: "ChartSchool — chart patterns (double bottom: close above the peak between the troughs; measure rule = pattern height added to the breakout)", url: "https://chartschool.stockcharts.com/table-of-contents/chart-analysis/chart-patterns/double-bottom-reversal" },
  loMamayskyWang: { label: "Lo, Mamaysky & Wang (2000), Foundations of Technical Analysis, J. Finance 55(4) — automatic pattern detection; some patterns carry incremental information", url: "https://www.nber.org/system/files/working_papers/w7613/w7613.pdf" },
  darvas: { label: "Darvas box — buy above the box top, stop at the box bottom (summary)", url: "https://www.sharescope.co.uk/sharescope_tutorial33.jsp" },
  turtle: { label: "The Original Turtle Trading Rules — 20-day breakout, 2N stop, 10-day exit", url: "https://www.turtletrader.com/turtle-trading/" },
} satisfies Record<string, Source>;

const liquid = (crore: number): Rule => ({
  label: `Liquid: 20-day avg turnover ≥ ₹${crore} cr`,
  test: (f) => f.turnoverCr20 >= crore,
});

const capped = (value: number, max: number) => Math.min(Number.isFinite(value) ? value : 0, max);

function rPlan(entry: number, stop: number, multiple: number | null, exit: string): TradePlan {
  const risk = entry - stop;
  return { entry, stop, target: multiple && risk > 0 ? entry + risk * multiple : null, exit };
}

/**
 * Entry for setups that describe a healthy trend rather than an event (Trend
 * Template, near the 52-week high). They qualify on any day, including a day the
 * stock is falling, so buying "now" would often mean buying into selling. Buy at
 * the close only when today shows strength (up, closing in the top 40% of its
 * range, at the top of its last 5 sessions); otherwise the entry is a buy-stop
 * just above the 5-day high — the order fills only if the stock turns back up
 * (Minervini buys on strength through a pivot, not anywhere in the uptrend).
 */
export function confirmedEntry(f: Features): { entry: number; confirmed: boolean } {
  const strongToday = f.changePct > 0 && f.clv >= 0.6 && f.close >= f.maxHigh5 * 0.99;
  if (strongToday || !(f.maxHigh5 > 0)) return { entry: f.close, confirmed: true };
  return { entry: roundToTick(Math.max(f.maxHigh5, f.close) * 1.001, "up"), confirmed: false };
}

const WAIT_FOR_STRENGTH = "Today isn't showing strength, so this is a buy-stop just above the 5-day high: it fills only if the stock turns back up. ";

/** Plan from the chart pattern: stop under the structure (capped at 8% — O'Neil), target = measured move (at least 1.5R). */
function patternPlan(f: Features, entry: number, exit: string): TradePlan {
  const pattern = f.pattern!;
  const stop = Math.max(pattern.stop, entry * 0.92);
  const risk = entry - stop;
  const target = Math.max(pattern.target, entry + 1.5 * risk);
  return { entry, stop, target, exit };
}

/**
 * A plan for any stock, setup or not (the Compare view): the pattern's levels
 * when there is one, else a structural stop under support / the 10-day low and
 * a target at resistance (if it pays ≥ 1.5R) or 2R.
 */
export function chartPlan(f: Features): TradePlan {
  if (f.pattern && f.pattern.status !== "extended") {
    const entry = f.pattern.status === "forming" ? Math.max(f.close, f.pattern.breakout) : f.close;
    return patternPlan(f, entry, `${f.pattern.name}: ${f.pattern.status === "forming" ? "buy-stop at the breakout" : "entry on the breakout"}, stop under the pattern, target = measured move.`);
  }
  const structural = Math.max(Number.isFinite(f.support) ? f.support : -Infinity, f.low10Prev) - 0.25 * f.atr14;
  // At least 1 ATR away (a tighter stop sits inside normal daily noise), at most 3 ATR / 8%.
  const stop = Math.min(f.close - f.atr14, Math.max(structural, f.close - 3 * f.atr14, f.close * 0.92));
  const risk = f.close - stop;
  const atResistance = Number.isFinite(f.resistance) && f.resistance - f.close >= 1.5 * risk;
  return rPlan(f.close, stop, atResistance ? (f.resistance - f.close) / risk : 2, atResistance ? "Stop under support / the 10-day low; target at the next resistance." : "Stop under support / the 10-day low (max 3 ATR, 8%); target 2R.");
}

export const SCREENS: ScreenDef[] = [
  // ------------------------------------------------------------------ BTST
  {
    id: "btst-closing-strength",
    group: "btst",
    name: "Closing-strength breakout",
    horizon: "Overnight",
    basis: "live",
    summary: "Strong up-day closing near its high on heavy volume, above yesterday's high, in an uptrend — the kind of momentum that tends to carry overnight.",
    rules: [
      { label: "Up ≥ 2% on the day", test: (f) => f.changePct >= 2 },
      { label: "Closing in top 25% of day's range (CLV ≥ 0.75)", test: (f) => f.clv >= 0.75 },
      { label: "Volume ≥ 1.5× 20-day average", test: (f) => f.volRatio20 >= 1.5 },
      { label: "Above previous day's high", test: (f) => f.close > f.prevHigh },
      { label: "Uptrend: close > 20 EMA > 50 EMA", test: (f) => f.close > f.ema20 && f.ema20 > f.ema50 },
      { label: "RSI(14) 55–80: strong, not exhausted", test: (f) => f.rsi14 >= 55 && f.rsi14 <= 80 },
      liquid(10),
    ],
    score: (f) => f.clv * 40 + capped(f.volRatio20, 5) * 10 + capped(f.changePct, 8) * 3,
    plan: (f) =>
      rPlan(f.close, Math.max(f.low, f.close - f.atr14), 1.5, "Next session: book at target, else exit by the close. Stop = day's low (max 1 ATR)."),
    tags: (f) => [`CLV ${f.clv.toFixed(2)}`, `Vol ${f.volRatio20.toFixed(1)}×`],
    sources: [S.zerodhaBtst, S.lps, S.nseClose, S.varsityFinale],
  },
  {
    id: "btst-20d-high",
    group: "btst",
    name: "20-day high into the close",
    horizon: "Overnight",
    basis: "live",
    summary: "Fresh 20-session high made late and held into the close on volume, without being stretched far above the 20 EMA.",
    rules: [
      { label: "Close above the prior 20-session high", test: (f) => f.close > f.high20Prev },
      { label: "Up ≥ 1% on the day", test: (f) => f.changePct >= 1 },
      { label: "Closing in top 30% of range (CLV ≥ 0.7)", test: (f) => f.clv >= 0.7 },
      { label: "Volume ≥ 1.5× 20-day average", test: (f) => f.volRatio20 >= 1.5 },
      { label: "Above 50-day SMA", test: (f) => f.close > f.sma50 },
      { label: "Not extended: ≤ 8% above 20 EMA", test: (f) => f.close <= f.ema20 * 1.08 },
      liquid(10),
    ],
    score: (f) => f.clv * 30 + capped(f.volRatio20, 5) * 10 + capped((f.close / f.high20Prev - 1) * 100, 5) * 4,
    plan: (f) => rPlan(f.close, Math.max(f.low, f.close - f.atr14), 1.5, "Next session: book at target, else exit by the close. Stop = day's low (max 1 ATR)."),
    tags: (f) => [`+${((f.close / f.high20Prev - 1) * 100).toFixed(1)}% over 20D high`, `Vol ${f.volRatio20.toFixed(1)}×`],
    sources: [S.turtle, S.georgeHwang, S.zerodhaBtst, S.nseClose],
  },

  // ------------------------------------------------------------------ Swing
  {
    id: "swing-ema-pullback",
    buysWeakness: true,
    group: "swing",
    name: "Pullback to 25 EMA in uptrend",
    horizon: "3–10 sessions",
    basis: "live",
    summary: "Medium-term uptrend (25 EMA over 50 EMA, above 200 SMA) that dipped to the 25 EMA with RSI cooling off, and bounced today.",
    rules: [
      { label: "Trend: 25 EMA > 50 EMA", test: (f) => f.ema25 > f.ema50 },
      { label: "Long-term uptrend: close > 200 SMA", test: (f) => f.close > f.sma200 },
      { label: "Touched the 25 EMA in the last 3 sessions", test: (f) => f.minLow3 <= f.ema25 * 1.01 },
      { label: "Held it: close > 25 EMA", test: (f) => f.close > f.ema25 },
      { label: "RSI(14) cooled to 40–60", test: (f) => f.rsi14 >= 40 && f.rsi14 <= 60 },
      { label: "Bounce today: green candle, up on the day", test: (f) => f.close > f.open && f.close > f.prevClose },
      liquid(5),
    ],
    score: (f) => 60 - Math.abs(f.rsi14 - 50) + (f.clv * 20) + capped(f.volRatio20, 3) * 5,
    plan: (f) =>
      rPlan(f.close, Math.max(f.minLow5 - 0.1 * f.atr14, f.close - 2 * f.atr14), 2, "Target 2R; stop under the pullback low (max 2 ATR). Exit early on a close below the 50 EMA."),
    tags: (f) => [`RSI ${f.rsi14.toFixed(0)}`, `${(((f.close - f.ema25) / f.ema25) * 100).toFixed(1)}% over 25 EMA`],
    sources: [S.varsityMa, S.varsityRsi, S.varsityFinale],
  },
  {
    id: "swing-rsi2",
    buysWeakness: true,
    group: "swing",
    name: "Connors RSI(2) oversold",
    horizon: "2–7 sessions",
    basis: "live",
    summary: "Short, sharp dip (2-period RSI ≤ 10) inside a long-term uptrend (above 200 SMA). Mean-reversion: exit on the first close back above the 5-day SMA.",
    rules: [
      { label: "Above 200-day SMA", test: (f) => f.close > f.sma200 },
      { label: "RSI(2) ≤ 10 (≤ 5 = stronger signal)", test: (f) => f.rsi2 <= 10 },
      liquid(5),
    ],
    score: (f) => 100 - f.rsi2 * 5 + (f.rsi2 <= 5 ? 20 : 0),
    plan: (f) => ({
      entry: f.close,
      stop: f.close - 2 * f.atr14,
      target: f.sma5 > f.close ? f.sma5 : null,
      exit: "Exit on a close above the 5-day SMA (target shown = today's 5-SMA). Connors uses no stop; 2 ATR shown as a risk reference.",
    }),
    tags: (f) => [`RSI(2) ${f.rsi2.toFixed(1)}`, ...(f.rsi2 <= 5 ? ["≤ 5"] : [])],
    sources: [S.rsi2],
  },
  {
    id: "swing-nr7",
    group: "swing",
    name: "NR7 squeeze in uptrend",
    horizon: "2–10 sessions",
    basis: "live",
    summary: "Today's range is the narrowest of the last 7 sessions in a rising trend — volatility contraction that often precedes expansion. Trade the break of today's high.",
    rules: [
      { label: "NR7: narrowest range of last 7 sessions", test: (f) => f.nr7 },
      { label: "Above a rising 50 EMA", test: (f) => f.close > f.ema50 && f.ema50 > f.ema50Prev5 },
      liquid(5),
    ],
    score: (f) => 50 + (f.insideDay ? 20 : 0) + (f.close > f.ema20 ? 10 : 0) - capped(f.rangePct, 5) * 4,
    plan: (f) =>
      rPlan(f.high, f.low, 2, "Buy only on a break above today's high next session; stop at today's low; target 2R."),
    tags: (f) => [`Range ${f.rangePct.toFixed(1)}%`, ...(f.insideDay ? ["Inside day"] : [])],
    sources: [S.crabel],
  },
  {
    id: "swing-delivery",
    group: "swing",
    name: "Delivery-backed up-move",
    horizon: "3–10 sessions",
    basis: "eod",
    summary: "Up-day where far more shares were taken into delivery than usual (NSE delivery % ≥ 1.5× its 20-day average) on high volume — buying that isn't just intraday churn. Uses the last completed session.",
    rules: [
      { label: "Delivery % ≥ 1.5× its 20-day average", test: (f) => f.deliveryPct >= 1.5 * f.deliveryAvg20 },
      { label: "Up ≥ 1.5% on the day", test: (f) => f.changePct >= 1.5 },
      { label: "Volume ≥ 1.5× 20-day average", test: (f) => f.volRatio20 >= 1.5 },
      { label: "Closed in upper 40% of range", test: (f) => f.clv >= 0.6 },
      { label: "Above 50 EMA", test: (f) => f.close > f.ema50 },
      liquid(5),
    ],
    score: (f) => capped(f.deliveryPct / f.deliveryAvg20, 4) * 20 + capped(f.volRatio20, 4) * 8 + f.clv * 10,
    plan: (f) => rPlan(f.close, Math.max(f.low, f.close - 1.5 * f.atr14), 2, "Target 2R; stop under the delivery day's low (max 1.5 ATR)."),
    tags: (f) => [`Deliv ${f.deliveryPct.toFixed(0)}% vs ${f.deliveryAvg20.toFixed(0)}%`, `Vol ${f.volRatio20.toFixed(1)}×`],
    sources: [S.kiteDelivery, S.upstoxDelivery, S.nseReports],
  },

  {
    id: "swing-bull-flag",
    group: "swing",
    name: "Bull flag",
    horizon: "3–10 sessions",
    basis: "live",
    summary: "A sharp pole (up > 10% over the 10 sessions before the last 5), then a tight 5-session flag (closes within 5%) above the 20-day average. Buy the break of the flag high.",
    rules: [
      { label: "Pole: up > 10% over the 10 sessions before the last 5", test: (f) => f.flagPolePct > 10 },
      { label: "Flag: last 5 closes inside a 5% range", test: (f) => f.flagRangePct <= 5 },
      { label: "Flag holds above the 20-day SMA", test: (f) => f.close > f.sma20 },
      liquid(5),
    ],
    score: (f) => capped(f.flagPolePct, 30) * 2 + (5 - capped(f.flagRangePct, 5)) * 8 + (f.close > f.ema50 ? 10 : 0),
    plan: (f) =>
      rPlan(f.maxHigh5, Math.max(f.minLow5, f.maxHigh5 - 2 * f.atr14), 2, "Buy only on a break above the flag high; stop under the flag low (max 2 ATR); target 2R."),
    tags: (f) => [`Pole +${f.flagPolePct.toFixed(0)}%`, `Flag ${f.flagRangePct.toFixed(1)}%`],
    sources: [S.dayTraderScanner],
  },
  {
    id: "swing-reclaim-ma20",
    group: "swing",
    name: "Reclaimed the 20-day average",
    horizon: "3–10 sessions",
    basis: "live",
    summary: "Closed back above its 20-day SMA after closing below it yesterday, while the long-term trend (200 SMA) is still up — a dip that has just been bought.",
    rules: [
      { label: "Yesterday closed below its 20-day SMA", test: (f) => f.prevClose < f.sma20Prev },
      { label: "Today closed above its 20-day SMA", test: (f) => f.close > f.sma20 },
      { label: "Long-term uptrend: close > 200 SMA", test: (f) => f.close > f.sma200 },
      liquid(5),
    ],
    score: (f) => f.clv * 30 + capped(f.volRatio20, 3) * 10 + capped(f.changePct, 5) * 4,
    plan: (f) =>
      rPlan(f.close, Math.max(f.minLow5 - 0.1 * f.atr14, f.close - 2 * f.atr14), 2, "Target 2R; stop under the 5-session low (max 2 ATR). Exit early on a close back below the 20-day SMA."),
    tags: (f) => [`${(((f.close - f.sma20) / f.sma20) * 100).toFixed(1)}% over 20 SMA`, `Vol ${f.volRatio20.toFixed(1)}×`],
    sources: [S.dayTraderScanner, S.varsityMa],
  },
  {
    id: "swing-oversold-bounce",
    buysWeakness: true,
    group: "swing",
    name: "Oversold bounce",
    horizon: "2–7 sessions",
    basis: "live",
    summary: "RSI(14) was below 30 yesterday and today closed up — the first green day out of an oversold flush. Counter-trend: keep it short and respect the stop.",
    rules: [
      { label: "Yesterday's RSI(14) < 30 (oversold)", test: (f) => f.rsi14Prev < 30 },
      { label: "Closed up today", test: (f) => f.close > f.prevClose },
      liquid(5),
    ],
    score: (f) => (30 - capped(f.rsi14Prev, 30)) * 2 + f.clv * 20 + (f.close > f.sma200 ? 15 : 0),
    plan: (f) =>
      rPlan(f.close, Math.max(f.minLow3 - 0.1 * f.atr14, f.close - 1.5 * f.atr14), 1.5, "Target 1.5R; stop under the 3-session low (max 1.5 ATR). Counter-trend — don't hold for more."),
    tags: (f) => [`RSI ${f.rsi14Prev.toFixed(0)} → ${f.rsi14.toFixed(0)}`, ...(f.close > f.sma200 ? ["> 200 SMA"] : [])],
    sources: [S.dayTraderScanner, S.varsityRsi],
  },

  // ------------------------------------------------------------------ Chart patterns
  {
    id: "pat-near",
    group: "swing",
    name: "Near pattern breakout",
    horizon: "Buy-stop · 5–20 sessions",
    basis: "live",
    summary: "A good-quality bullish chart pattern (triangle, box, double bottom, flag, VCP, cup & handle) still forming, with the close within 3% of its breakout level, in an uptrend. Buy only if it breaks out — the plan is a buy-stop at the breakout.",
    rules: [
      { label: "Bullish pattern forming, quality ≥ 70", test: (f) => f.pattern?.status === "forming" && f.pattern.quality >= 70 },
      { label: "Close within 3% below the breakout", test: (f) => Boolean(f.pattern) && f.close >= f.pattern!.breakout * 0.97 && f.close <= f.pattern!.breakout },
      { label: "Uptrend: close > 50 SMA", test: (f) => f.close > f.sma50 },
      liquid(5),
    ],
    score: (f) => (f.pattern?.quality ?? 0) + (1 - (f.pattern!.breakout - f.close) / f.pattern!.breakout) * 20,
    plan: (f) => patternPlan(f, f.pattern!.breakout, "Buy-stop at the breakout; stop under the pattern (max 8%); target = the pattern's measured move. Cancel the order if it closes below the stop first."),
    tags: (f) => [f.pattern!.name, `${(((f.pattern!.breakout - f.close) / f.close) * 100).toFixed(1)}% to breakout`, `Q${f.pattern!.quality}`],
    sources: [S.chartPatterns, S.loMamayskyWang, S.minervini, S.darvas],
  },
  {
    id: "pat-breakout",
    group: "positional",
    name: "Chart-pattern breakout",
    horizon: "15–20 sessions",
    basis: "live",
    summary: "Closed above a good-quality bullish pattern's breakout level today or yesterday and isn't stretched past it — the classic entry, with a structural stop and a measured-move target.",
    rules: [
      { label: "Pattern breakout in the last 2 sessions, quality ≥ 65", test: (f) => f.pattern?.status === "breakout" && (f.pattern.breakoutAgo ?? 9) <= 1 && f.pattern.quality >= 65 },
      { label: "Within 5% of the breakout (don't chase)", test: (f) => Boolean(f.pattern) && f.close <= f.pattern!.breakout * 1.05 },
      { label: "Volume ≥ 1.3× 20-day average", test: (f) => f.volRatio20 >= 1.3 },
      { label: "Uptrend: close > 50 SMA", test: (f) => f.close > f.sma50 },
      liquid(5),
    ],
    score: (f) => (f.pattern?.quality ?? 0) + capped(f.volRatio20, 4) * 5,
    plan: (f) => patternPlan(f, f.close, "Stop under the pattern (max 8%); target = measured move. Trail with the chandelier stop once it's 1R in profit; exit on a close back inside the pattern."),
    tags: (f) => [f.pattern!.name, `Q${f.pattern!.quality}`, `Vol ${f.volRatio20.toFixed(1)}×`],
    sources: [S.chartPatterns, S.loMamayskyWang, S.ibdBreakout, S.marketsmith],
  },

  // ------------------------------------------------------------------ Results / news reactions
  {
    id: "res-gap-up",
    group: "results",
    name: "Results gap-up (episodic pivot)",
    horizon: "Day of the gap → 2 weeks",
    basis: "live",
    summary: "Opened ≥ 4% above yesterday's close on ≥ 3× its 50-day volume and held it into the close (top half of the range) — the market re-pricing a stock on results or news. Stop under the gap day's low.",
    rules: [
      { label: "Gap up ≥ 4% at the open", test: (f) => f.gapPct >= 4 },
      { label: "Volume ≥ 3× 50-day average", test: (f) => f.volRatio50 >= 3 },
      { label: "Held the gap: closed in the top half of the range, above yesterday's high", test: (f) => f.clv >= 0.5 && f.close > f.prevHigh },
      { label: "Not a collapse back: close ≥ open − 1%", test: (f) => f.close >= f.open * 0.99 },
      liquid(10),
    ],
    score: (f) => capped(f.gapPct, 15) * 4 + capped(f.volRatio50, 10) * 4 + f.clv * 20 + (f.close > f.sma200 ? 10 : 0),
    plan: (f) =>
      rPlan(f.close, Math.max(f.low, f.close - 2 * f.atr14), 2, "Target 2R; stop under the gap day's low (max 2 ATR). A close back below the day's low means the gap failed — get out."),
    tags: (f) => [`Gap +${f.gapPct.toFixed(1)}%`, `Vol ${f.volRatio50.toFixed(1)}× 50D`],
    sources: [S.episodicPivot, S.bernardThomas, S.iimbPead, S.nsePeadEfficient],
  },
  {
    id: "res-drift",
    group: "results",
    name: "Post-results drift",
    horizon: "2–10 sessions after the gap",
    basis: "live",
    summary: "A gap-up of ≥ 4% on ≥ 3× volume happened 2–10 sessions ago and the stock has held above that day's low and its close since — the re-pricing is sticking. Entry on the hold, stop under the gap day's low.",
    rules: [
      { label: "Gap-up event 2–10 sessions ago (≥ 4% gap, ≥ 3× volume)", test: (f) => f.eventGapPct >= 4 && f.eventAgo >= 2 && f.eventAgo <= 10 },
      { label: "Never broke the gap day's low since", test: (f) => f.lowSinceEvent >= f.eventLow },
      { label: "Holding above the gap day's close", test: (f) => f.close >= f.eventClose },
      { label: "Above the 50-day EMA", test: (f) => f.close > f.ema50 },
      liquid(10),
    ],
    score: (f) => capped(f.eventGapPct, 15) * 3 + ((f.close / f.eventClose - 1) * 100) * 2 + (11 - f.eventAgo) * 2,
    plan: (f) =>
      rPlan(f.close, Math.max(f.eventLow, f.close - 2.5 * f.atr14), 2, "Target 2R; stop under the gap day's low (max 2.5 ATR). Exit early on a close back below the gap day's close."),
    tags: (f) => [`Gap +${f.eventGapPct.toFixed(1)}% ${f.eventAgo}d ago`, `${(((f.close - f.eventClose) / f.eventClose) * 100).toFixed(1)}% above gap close`],
    sources: [S.bernardThomas, S.iimbPead, S.bse500Pead, S.episodicPivot],
  },

  // ------------------------------------------------------------------ 15–30 days
  {
    id: "pos-trend-template",
    group: "positional",
    name: "Minervini Trend Template",
    horizon: "3–6 weeks",
    basis: "live",
    summary: "All eight Stage-2 uptrend conditions: stacked 50/150/200-day averages, rising 200-day, well off the lows, near the highs, and top-30% relative strength in this universe.",
    rules: [
      { label: "Close above 150- and 200-day SMA", test: (f) => f.close > f.sma150 && f.close > f.sma200 },
      { label: "150-day SMA above 200-day SMA", test: (f) => f.sma150 > f.sma200 },
      { label: "200-day SMA rising for ≥ 1 month", test: (f) => f.sma200 > f.sma200Prev22 },
      { label: "50-day SMA above 150- and 200-day", test: (f) => f.sma50 > f.sma150 && f.sma50 > f.sma200 },
      { label: "Close above 50-day SMA", test: (f) => f.close > f.sma50 },
      { label: "≥ 30% above 52-week low", test: (f) => f.close >= 1.3 * f.low52 },
      { label: "Within 25% of 52-week high", test: (f) => f.close >= 0.75 * f.high52 },
      { label: "Relative strength rank ≥ 70 (in universe)", test: (f) => f.rsRank >= 70 },
      { label: `Buy point within ${FAR_ATR} ATR of the close (can fill next session)`, test: (f) => confirmedEntry(f).entry - f.close <= FAR_ATR * f.atr14 },
    ],
    score: (f) => f.rsRank + (f.close / f.high52) * 20,
    plan: (f) => {
      const { entry, confirmed } = confirmedEntry(f);
      return rPlan(entry, Math.max(entry * 0.92, entry - 2.5 * f.atr14), 3, `${confirmed ? "" : WAIT_FOR_STRENGTH}Target 3R; hard stop ≤ 8%. Trail under the 50-day SMA for the rest of the move.`);
    },
    tags: (f) => [`RS ${f.rsRank}`, `${((1 - f.close / f.high52) * 100).toFixed(1)}% off high`],
    sources: [S.minervini, S.chartmill],
  },
  {
    id: "pos-52w-high",
    group: "positional",
    name: "Near 52-week high, beating Nifty",
    horizon: "3–6 weeks",
    basis: "live",
    summary: "Within 5% of its 52-week high and outperforming NIFTY 50 over 6 months, in an uptrend. Nearness to the 52-week high is one of the best-documented momentum predictors.",
    rules: [
      { label: "Within 5% of 52-week high", test: (f) => f.close >= 0.95 * f.high52 },
      { label: "6-month return beats NIFTY 50", test: (f, ctx) => f.ret126 > ctx.niftyRet126 },
      { label: "Uptrend: close > 50 SMA > 200 SMA", test: (f) => f.close > f.sma50 && f.sma50 > f.sma200 },
      { label: `Buy point within ${FAR_ATR} ATR of the close (can fill next session)`, test: (f) => confirmedEntry(f).entry - f.close <= FAR_ATR * f.atr14 },
      liquid(5),
    ],
    score: (f) => (f.close / f.high52) * 60 + capped(f.ret126, 80) * 0.5,
    plan: (f) => {
      const { entry, confirmed } = confirmedEntry(f);
      return rPlan(entry, Math.max(entry * 0.92, entry - 2.5 * f.atr14), 3, `${confirmed ? "" : WAIT_FOR_STRENGTH}Target 3R; stop ≤ 8% (or 2.5 ATR). Exit on a close below the 50-day SMA.`);
    },
    tags: (f) => [`${((1 - f.close / f.high52) * 100).toFixed(1)}% off high`, `6M ${f.ret126.toFixed(0)}%`],
    sources: [S.georgeHwang, S.varsityMa],
  },
  {
    id: "pos-base-breakout",
    group: "positional",
    name: "Base breakout on volume",
    horizon: "3–6 weeks",
    basis: "live",
    summary: "Breaks above a ≤ 25%-deep, 30-session base on volume ≥ 1.4× the 50-day average, still within 5% of the pivot, in an established uptrend (O'Neil/IBD breakout rules).",
    rules: [
      { label: "Close above the 30-session base high (pivot)", test: (f) => f.close > f.baseHigh },
      { label: "Within 5% of the pivot (don't chase)", test: (f) => f.close <= f.baseHigh * 1.05 },
      { label: "Base depth ≤ 25%", test: (f) => (f.baseHigh - f.baseLow) / f.baseHigh <= 0.25 },
      { label: "Volume ≥ 1.4× 50-day average", test: (f) => f.volRatio50 >= 1.4 },
      { label: "Uptrend: close > 50 SMA > 200 SMA", test: (f) => f.close > f.sma50 && f.sma50 > f.sma200 },
      liquid(5),
    ],
    score: (f) => capped(f.volRatio50, 5) * 15 + (1 - (f.baseHigh - f.baseLow) / f.baseHigh) * 30,
    plan: (f) => rPlan(f.close, f.close * 0.92, 3, "Target 3R; sell if it falls 8% below entry (O'Neil/MarketSmith rule) or closes back inside the base."),
    tags: (f) => [`Vol ${f.volRatio50.toFixed(1)}× 50D`, `Base ${(((f.baseHigh - f.baseLow) / f.baseHigh) * 100).toFixed(0)}% deep`],
    sources: [S.ibdBreakout, S.marketsmith],
  },
  {
    id: "pos-turtle-adx",
    group: "positional",
    name: "20-day breakout + ADX trend",
    horizon: "2–6 weeks",
    basis: "live",
    summary: "Turtle System-1 entry (new 20-session high) filtered for a strong, bullish trend (ADX ≥ 25, +DI above −DI). Trail out on a close below the 10-session low.",
    rules: [
      { label: "Close above prior 20-session high", test: (f) => f.close > f.high20Prev },
      { label: "Strong trend: ADX(14) ≥ 25", test: (f) => f.adx14 >= 25 },
      { label: "Bullish: +DI above −DI", test: (f) => f.plusDI > f.minusDI },
      liquid(5),
    ],
    score: (f) => capped(f.adx14, 60) + capped(f.plusDI - f.minusDI, 40),
    plan: (f) => ({
      entry: f.close,
      stop: f.close - 2 * f.atr20,
      target: null,
      exit: `Stop 2N (2 × ATR20). Trail: exit on a close below the 10-session low (now ${f.low10Prev.toFixed(2)}).`,
    }),
    tags: (f) => [`ADX ${f.adx14.toFixed(0)}`, `+DI ${f.plusDI.toFixed(0)} / −DI ${f.minusDI.toFixed(0)}`],
    sources: [S.turtle, S.varsityAdx],
  },
];

export const SCREEN_MAP: Record<string, ScreenDef> = Object.fromEntries(SCREENS.map((screen) => [screen.id, screen]));
