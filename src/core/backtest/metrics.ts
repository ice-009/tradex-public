// Performance statistics for a backtest: trade statistics (from the trade list)
// and equity statistics (from the daily equity curve). Pure functions.
//
// Assumptions, so the numbers can be read correctly:
// - Daily returns are close-to-close changes of the marked-to-market equity,
//   one per trading session (the first against the starting capital).
// - Sharpe = mean(daily return) / stdev(daily return) × √252, risk-free rate 0.
//   A futures account's margin cash usually earns nothing, so 0 is the honest
//   baseline; against a ~6.5% T-bill rate the ratio would be lower.
// - Sortino = mean(daily return) / downside deviation × √252, where downside
//   deviation = √(mean of min(r, 0)²) over all days (target return 0).
// - CAGR annualises the total return over the calendar length of the period.
//   Over less than a year that is an extrapolation — read it with care.
// - Max drawdown = largest fall from a running peak of equity; its duration is
//   the longest run of sessions spent below a previous peak (to recovery, or to
//   the end if never recovered).

export const TRADING_DAYS = 252;

export interface EquityPoint {
  /** Session (UTC midnight of the IST date). */
  t: number;
  equity: number;
  /** NIFTY buy-and-hold on the same starting capital. */
  bench: number | null;
  /** Fall from the running peak, as a fraction (0 or negative). */
  drawdown: number;
  /** Positions open at this session's close. */
  open: number;
}

export interface TradeStatsInput {
  pnl: number;
  r: number;
  holdDays: number;
}

export interface TradeStats {
  trades: number;
  wins: number;
  losses: number;
  /** Share of trades with net P&L > 0. */
  winRate: number | null;
  avgR: number | null;
  /** Mean net P&L per trade, ₹. */
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  /** Gross profit / gross loss; null when there are no losing trades. */
  profitFactor: number | null;
  netPnl: number;
  avgHoldDays: number | null;
  longestLosingStreak: number;
}

export interface EquityStats {
  sessions: number;
  startEquity: number;
  endEquity: number;
  totalReturn: number;
  cagr: number | null;
  /** Calendar years the period covers (CAGR is extrapolated when < 1). */
  years: number;
  maxDrawdown: number;
  /** Longest stretch below a previous peak, in sessions. */
  maxDrawdownSessions: number;
  maxDrawdownPeak: number | null;
  maxDrawdownTrough: number | null;
  sharpe: number | null;
  sortino: number | null;
  /** Share of sessions with at least one position open. */
  exposure: number;
  benchReturn: number | null;
}

export const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN);

/** Sample standard deviation (n − 1). */
export function stdev(values: number[]): number {
  if (values.length < 2) return NaN;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

const orNull = (value: number) => (Number.isFinite(value) ? value : null);

export function tradeStats(trades: TradeStatsInput[]): TradeStats {
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl <= 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = -losses.reduce((sum, trade) => sum + trade.pnl, 0);
  let streak = 0;
  let longest = 0;
  for (const trade of trades) {
    streak = trade.pnl <= 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : null,
    avgR: orNull(mean(trades.map((trade) => trade.r))),
    expectancy: orNull(mean(trades.map((trade) => trade.pnl))),
    avgWin: orNull(mean(wins.map((trade) => trade.pnl))),
    avgLoss: orNull(mean(losses.map((trade) => trade.pnl))),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    netPnl: grossWin - grossLoss,
    avgHoldDays: orNull(mean(trades.map((trade) => trade.holdDays))),
    longestLosingStreak: longest,
  };
}

/** Running-peak drawdown of a series, as fractions (0 or negative). */
export function drawdowns(values: number[]): number[] {
  let peak = -Infinity;
  return values.map((value) => {
    peak = Math.max(peak, value);
    return peak > 0 ? value / peak - 1 : 0;
  });
}

/** Max drawdown and the longest time under water (in points of the series). */
export function maxDrawdown(values: number[], times?: number[]) {
  let peak = -Infinity;
  let peakAt = -1;
  let worst = 0;
  let worstPeak = -1;
  let worstTrough = -1;
  let longest = 0;
  let underSince = -1;
  values.forEach((value, i) => {
    if (value >= peak) {
      if (underSince >= 0) longest = Math.max(longest, i - underSince);
      underSince = -1;
      peak = value;
      peakAt = i;
      return;
    }
    if (underSince < 0) underSince = peakAt;
    const dd = value / peak - 1;
    if (dd < worst) {
      worst = dd;
      worstPeak = peakAt;
      worstTrough = i;
    }
  });
  if (underSince >= 0) longest = Math.max(longest, values.length - 1 - underSince);
  return {
    maxDrawdown: worst,
    sessions: longest,
    peak: times && worstPeak >= 0 ? times[worstPeak] : null,
    trough: times && worstTrough >= 0 ? times[worstTrough] : null,
  };
}

/** Daily simple returns of a curve, the first one against `base`. */
export function dailyReturns(values: number[], base: number): number[] {
  const out: number[] = [];
  let previous = base;
  for (const value of values) {
    out.push(previous > 0 ? value / previous - 1 : 0);
    previous = value;
  }
  return out;
}

export function sharpe(returns: number[]): number | null {
  const sd = stdev(returns);
  return sd > 0 ? (mean(returns) / sd) * Math.sqrt(TRADING_DAYS) : null;
}

export function sortino(returns: number[]): number | null {
  if (returns.length < 2) return null;
  const downside = Math.sqrt(mean(returns.map((r) => Math.min(r, 0) ** 2)));
  return downside > 0 ? (mean(returns) / downside) * Math.sqrt(TRADING_DAYS) : null;
}

const YEAR_MS = 365.25 * 86_400_000;

/**
 * Equity statistics for a stretch of the curve. `base` is the equity just before the first
 * point and `baseTime` its date (the period start), so a split segment is measured on its own.
 */
export function equityStats(curve: EquityPoint[], base: number, baseTime: number, baseBench: number | null): EquityStats {
  const values = curve.map((point) => point.equity);
  const end = values.at(-1) ?? base;
  const totalReturn = base > 0 ? end / base - 1 : 0;
  const lastTime = curve.at(-1)?.t ?? baseTime;
  const years = Math.max(0, (lastTime - baseTime) / YEAR_MS);
  const dd = maxDrawdown([base, ...values], [baseTime, ...curve.map((point) => point.t)]);
  const returns = dailyReturns(values, base);
  const lastBench = curve.at(-1)?.bench ?? null;
  return {
    sessions: curve.length,
    startEquity: base,
    endEquity: end,
    totalReturn,
    cagr: years > 0 && end > 0 && base > 0 ? (end / base) ** (1 / years) - 1 : null,
    years,
    maxDrawdown: dd.maxDrawdown,
    maxDrawdownSessions: dd.sessions,
    maxDrawdownPeak: dd.peak,
    maxDrawdownTrough: dd.trough,
    sharpe: sharpe(returns),
    sortino: sortino(returns),
    exposure: curve.length ? curve.filter((point) => point.open > 0).length / curve.length : 0,
    benchReturn: baseBench && lastBench ? lastBench / baseBench - 1 : null,
  };
}

export interface MonthReturn {
  year: number;
  /** 0-based month. */
  month: number;
  ret: number;
  bench: number | null;
}

/** Month-by-month return of the curve (each month against the previous month's last close, the first against `base`). */
export function monthlyReturns(curve: EquityPoint[], base: number, baseBench: number | null): MonthReturn[] {
  const out: MonthReturn[] = [];
  let previous = base;
  let previousBench = baseBench;
  for (let i = 0; i < curve.length; i += 1) {
    const date = new Date(curve[i].t);
    const next = curve[i + 1] ? new Date(curve[i + 1].t) : null;
    if (next && next.getUTCMonth() === date.getUTCMonth() && next.getUTCFullYear() === date.getUTCFullYear()) continue;
    const point = curve[i];
    out.push({
      year: date.getUTCFullYear(),
      month: date.getUTCMonth(),
      ret: previous > 0 ? point.equity / previous - 1 : 0,
      bench: previousBench && point.bench ? point.bench / previousBench - 1 : null,
    });
    previous = point.equity;
    previousBench = point.bench;
  }
  return out;
}
