import { HOLD_BARS } from "@/core/screener/backtest";
import { SCREENS, type ScreenGroup } from "@/core/screener/screens";
import { addCosts, emptyCosts, legCosts, slipped, type CostBreakdown, type CostModel } from "./costs";
import { drawdowns, equityStats, monthlyReturns, tradeStats, type EquityPoint, type EquityStats, type MonthReturn, type TradeStats } from "./metrics";
import type { Signal, SignalScan } from "./signals";

// Step 2 of a backtest: trade the scanned signals as one account, session by
// session, with a fixed number of slots, position sizing from the stop, and
// costs. Long only (the screens are long setups), stock futures as the
// instrument, with the stock's cash prices standing in for the futures price.
//
// Each session, in this order:
//   1. Orders placed at yesterday's close fill (next-open entries and buy-stops).
//   2. Open positions are checked against the day's bar — same rules as the
//      screener's track record (simulatePlan in src/core/screener/backtest.ts):
//        - a bar that touches both the stop and the target counts as the stop;
//        - a gap through a level fills at the open (worse than the level);
//        - on a buy-stop's fill bar there is no gap logic (it filled inside the bar);
//        - at the holding horizon the position is closed at the close — or, for
//          overnight (BTST) screens, at that session's open.
//   3. Equity is marked to the close.
//   4. Today's signals are ranked by the screen's score (highest first) and
//      take the free slots; one position per stock across all screens. Scores
//      of different screens are on different scales, so with several screens
//      the ranking interleaves them: each screen's best signal first (highest
//      score among those), then each screen's second best, and so on.
//
// Entries never use information from after the signal: a signal on day i is
// decided on day i's close and filled at the next session's open (default), or
// at day i's close itself ("signal-close", as the screens are meant to be run
// at 3:15–3:25 PM — slightly optimistic, since the real close isn't known yet).
// Overnight (BTST) screens always enter at the signal close: a next-open entry
// with a next-open exit would hold nothing.
// A plan whose entry is above the signal close is a buy-stop: it must trade
// through on the next session or the signal is dropped.

export type EntryMode = "next-open" | "signal-close";

export interface BacktestConfig {
  screenIds: string[];
  /** First and last session of the period (signals are taken within it; anything open at the end is closed). Null = all history. */
  from: number | null;
  to: number | null;
  /** Sessions to hold before a time exit; null = each screen's HOLD_BARS. */
  holdBars: number | null;
  capital: number;
  /** % of current equity risked per trade (entry − stop distance × quantity). */
  riskPct: number;
  maxPositions: number;
  /** Total open notional may not exceed equity × this (futures margin is ~20–25% of notional). */
  maxLeverage: number;
  entry: EntryMode;
  costs: CostModel;
  /** Lot size per symbol; when given, quantity is whole lots. Missing symbols are sized in shares. */
  lots: Record<string, number> | null;
  /** Share of the period held out at the end as out-of-sample (0.3 = last 30%). */
  oosFraction: number;
}

export type ExitReason = "target" | "stop" | "time" | "end";

export interface BacktestTrade {
  id: number;
  symbol: string;
  screenId: string;
  signalDate: number;
  entryDate: number;
  /** Fill after slippage. */
  entryPrice: number;
  exitDate: number;
  exitPrice: number;
  exitReason: ExitReason;
  stop: number;
  target: number | null;
  qty: number;
  /** Lots when sized in lots, else null (whole shares). */
  lots: number | null;
  /** ₹ the trade was sized to risk: quantity × (planned entry − stop). */
  riskAmount: number;
  /** Net P&L ÷ riskAmount. */
  r: number;
  /** Net of charges and slippage, ₹. */
  pnl: number;
  /** Net P&L as % of the position's value at entry. */
  pnlPct: number;
  /** Charges (both legs), ₹. */
  costs: number;
  /** What slippage cost on both legs, ₹. */
  slippage: number;
  /** Sessions from the entry session to the exit session. */
  holdDays: number;
  sample: "in" | "out";
}

export interface SampleStats {
  from: number;
  to: number;
  trades: TradeStats;
  equity: EquityStats;
}

export interface ScreenBreakdown {
  screenId: string;
  name: string;
  group: ScreenGroup;
  holdBars: number;
  /** First session the screen fired anywhere in the stored history (null = never). */
  firstSignal: number | null;
  /** Signals the screen gave inside the period. */
  signals: number;
  stats: TradeStats;
}

export interface SkipCounts {
  /** All slots were taken (by higher-scoring signals or open positions). */
  noSlot: number;
  /** Already holding (or about to buy) that stock. */
  held: number;
  /** A buy-stop entry didn't trade through on the next session. */
  notTriggered: number;
  /** The next session opened beyond the stop or the target. */
  gapped: number;
  /** Size rounded to zero (one lot risks more than the budget) or no room under the leverage cap. */
  tooSmall: number;
}

export interface BacktestResult {
  period: {
    from: number;
    to: number;
    sessions: number;
    /** The stored history this ran on. */
    historyFrom: number;
    historyTo: number;
    historySessions: number;
    /** First session with enough warm-up for a signal. */
    firstSignalDate: number | null;
  };
  config: Omit<BacktestConfig, "lots"> & { sizing: "lots" | "shares" };
  /** Signals of the chosen screens inside the period. */
  signals: number;
  trades: BacktestTrade[];
  curve: EquityPoint[];
  trade: TradeStats;
  equity: EquityStats;
  best: BacktestTrade | null;
  worst: BacktestTrade | null;
  costs: CostBreakdown & { slippage: number };
  monthly: MonthReturn[];
  byScreen: ScreenBreakdown[];
  split: { date: number; fraction: number; inSample: SampleStats; outOfSample: SampleStats };
  skipped: SkipCounts;
  /** Trades sized in shares because no lot size was known (lots mode only). */
  unlotted: number;
  warnings: string[];
}

interface Position {
  signal: Signal;
  qty: number;
  lots: number | null;
  entryIndex: number;
  entryDate: number;
  entryFill: number;
  entryRaw: number;
  /** Bar index of a buy-stop fill (no gap logic on it), else -1. */
  fillBar: number;
  lastIndex: number;
  entryCosts: CostBreakdown;
  lastClose: number;
}

interface Pending {
  signal: Signal;
  qty: number;
  lots: number | null;
  buyStop: boolean;
}

const screenById = new Map(SCREENS.map((screen) => [screen.id, screen]));

export function holdFor(screenId: string, override: number | null): number {
  if (override && override > 0) return Math.round(override);
  const screen = screenById.get(screenId);
  return screen ? HOLD_BARS[screen.group] : 10;
}

/** Overnight screens (BTST) are bought at the signal close and sold at an open — see ScreenDef.exit. */
export const exitsAtOpen = (screenId: string) => screenById.get(screenId)?.exit === "next-open";

/** A plan entry above the signal close is a buy-stop for the next session (same threshold as simulatePlan). */
export const isBuyStop = (signal: Pick<Signal, "entry" | "close">) => signal.entry > signal.close * 1.0005;

/** Quantity for a risk budget: whole lots when a lot size is known, else whole shares. */
export function sizePosition(budget: number, riskPerShare: number, lot: number | null): { qty: number; lots: number | null } {
  if (!(riskPerShare > 0) || !(budget > 0)) return { qty: 0, lots: lot ? 0 : null };
  if (lot && lot > 0) {
    const lots = Math.floor(budget / (riskPerShare * lot));
    return { qty: lots * lot, lots };
  }
  return { qty: Math.floor(budget / riskPerShare), lots: null };
}

/** Order a session's signals for the free slots: by rank within their own screen, then by score. */
export function rankSignals(signals: Signal[]): Signal[] {
  const byScreen = new Map<string, Signal[]>();
  for (const signal of signals) byScreen.set(signal.screenId, [...(byScreen.get(signal.screenId) ?? []), signal]);
  const rank = new Map<Signal, number>();
  for (const list of byScreen.values()) list.sort((a, b) => b.score - a.score).forEach((signal, i) => rank.set(signal, i));
  return [...signals].sort((a, b) => rank.get(a)! - rank.get(b)! || b.score - a.score);
}

/** A request the data can't answer (e.g. a period with no usable sessions). */
export class BacktestInputError extends Error {}

export function runPortfolio(scan: SignalScan, config: BacktestConfig): BacktestResult {
  const selected = new Set(config.screenIds);
  // "All history" starts where the chosen screens can first fire: before that the account would only sit in cash.
  const firsts = config.screenIds.map((id) => scan.firstByScreen[id]).filter((date) => date !== undefined);
  const start = config.from ?? (firsts.length ? Math.min(...firsts) : (scan.firstSignalDate ?? scan.dates[0]));
  const end = config.to ?? scan.dates.at(-1)!;
  const dates = scan.dates.filter((date) => date >= start && date <= end && (scan.firstSignalDate === null || date >= scan.firstSignalDate));
  if (dates.length < 2) throw new BacktestInputError("The period has fewer than two sessions with enough history.");
  const lastDate = dates.at(-1)!;
  const priorDate = scan.dates[scan.dates.indexOf(dates[0]) - 1] ?? dates[0];

  const benchIndex = new Map(scan.benchmark.map((bar, i) => [bar.t, i]));
  const benchAt = (date: number): number | null => {
    // Last NIFTY close on or before the date.
    let i = benchIndex.get(date);
    if (i === undefined) {
      const before = scan.benchmark.filter((bar) => bar.t <= date);
      return before.length ? before.at(-1)!.c : null;
    }
    i = Math.max(0, i);
    return scan.benchmark[i].c;
  };
  const benchBase = benchAt(priorDate);

  const { costs: model, capital } = config;
  let cash = capital;
  let positions: Position[] = [];
  let pending: Pending[] = [];
  const trades: BacktestTrade[] = [];
  const curve: EquityPoint[] = [];
  const skipped: SkipCounts = { noSlot: 0, held: 0, notTriggered: 0, gapped: 0, tooSmall: 0 };
  let unlotted = 0;
  let signalCount = 0;
  const signalsByScreen = new Map<string, number>();
  let chargeTotal = emptyCosts();
  let slippageTotal = 0;

  const close = (position: Position, index: number, date: number, raw: number, reason: ExitReason) => {
    const { signal, qty } = position;
    const exitFill = slipped("sell", raw, model);
    const exitCosts = legCosts("sell", exitFill, qty, model);
    const charges = addCosts(position.entryCosts, exitCosts);
    const gross = (exitFill - position.entryFill) * qty;
    const pnl = gross - charges.total;
    const riskAmount = qty * (signal.entry - signal.stop);
    const slippage = (position.entryFill - position.entryRaw) * qty + (raw - exitFill) * qty;
    cash += gross - exitCosts.total; // entry costs were paid at entry
    chargeTotal = addCosts(chargeTotal, charges);
    slippageTotal += slippage;
    trades.push({
      id: trades.length + 1,
      symbol: signal.symbol,
      screenId: signal.screenId,
      signalDate: signal.date,
      entryDate: position.entryDate,
      entryPrice: position.entryFill,
      exitDate: date,
      exitPrice: exitFill,
      exitReason: reason,
      stop: signal.stop,
      target: signal.target,
      qty,
      lots: position.lots,
      riskAmount,
      r: riskAmount > 0 ? pnl / riskAmount : 0,
      pnl,
      pnlPct: (pnl / (position.entryFill * qty)) * 100,
      costs: charges.total,
      slippage,
      holdDays: index - position.entryIndex,
      sample: "in",
    });
  };

  const open = (pendingOrder: Pending, index: number, date: number, raw: number, fillBar: number) => {
    const { signal, qty } = pendingOrder;
    const entryFill = slipped("buy", raw, model);
    const entryCosts = legCosts("buy", entryFill, qty, model);
    cash -= entryCosts.total;
    const hold = holdFor(signal.screenId, config.holdBars);
    positions.push({
      signal,
      qty,
      lots: pendingOrder.lots,
      entryIndex: index,
      entryDate: date,
      entryFill,
      entryRaw: raw,
      fillBar,
      // Never a same-day round trip on purpose: the time exit is at least one session after entry.
      lastIndex: Math.max(signal.index + hold, index + 1),
      entryCosts,
      lastClose: raw,
    });
  };

  const markToMarket = () => cash + positions.reduce((sum, position) => sum + (position.lastClose - position.entryFill) * position.qty, 0);
  const openNotional = () =>
    positions.reduce((sum, position) => sum + position.entryRaw * position.qty, 0) + pending.reduce((sum, order) => sum + order.signal.entry * order.qty, 0);

  for (const date of dates) {
    // 1. Fill yesterday's orders.
    for (const order of pending) {
      const series = scan.series.get(order.signal.symbol);
      const i = series?.index.get(date);
      if (!series || i === undefined) {
        skipped.notTriggered += 1;
        continue;
      }
      const bar = series.bars[i];
      const { entry, stop, target } = order.signal;
      if (order.buyStop) {
        if (bar.h < entry) {
          skipped.notTriggered += 1;
          continue;
        }
        open(order, i, date, Math.max(bar.o, entry), i);
      } else {
        if (bar.o <= stop || (target !== null && bar.o >= target)) {
          skipped.gapped += 1;
          continue;
        }
        open(order, i, date, bar.o, -1);
      }
    }
    pending = [];

    // 2. Exits.
    const still: Position[] = [];
    for (const position of positions) {
      const series = scan.series.get(position.signal.symbol)!;
      const i = series.index.get(date);
      if (i === undefined || i < position.entryIndex) {
        if (date === lastDate) close(position, position.entryIndex, date, position.lastClose, "end");
        else still.push(position);
        continue;
      }
      const bar = series.bars[i];
      const { stop, target } = position.signal;
      const gaps = i !== position.fillBar;
      if (exitsAtOpen(position.signal.screenId) && i >= position.lastIndex) {
        close(position, i, date, bar.o, bar.o <= stop ? "stop" : target !== null && bar.o >= target ? "target" : "time");
        continue;
      }
      if (bar.l <= stop) close(position, i, date, gaps ? Math.min(stop, bar.o) : stop, "stop");
      else if (target !== null && bar.h >= target) close(position, i, date, gaps ? Math.max(target, bar.o) : target, "target");
      else if (i >= position.lastIndex) close(position, i, date, bar.c, "time");
      else if (date === lastDate) close(position, i, date, bar.c, "end");
      else {
        position.lastClose = bar.c;
        still.push(position);
      }
    }
    positions = still;

    // 3–4. New signals (none on the last session: nothing could be held).
    const today = date === lastDate ? [] : (scan.byDate.get(date) ?? []).filter((signal) => selected.has(signal.screenId));
    signalCount += today.length;
    for (const signal of today) signalsByScreen.set(signal.screenId, (signalsByScreen.get(signal.screenId) ?? 0) + 1);
    if (today.length) {
      const equityNow = markToMarket();
      const busy = new Set([...positions.map((p) => p.signal.symbol), ...pending.map((p) => p.signal.symbol)]);
      const ranked = rankSignals(today);
      for (const signal of ranked) {
        if (busy.has(signal.symbol)) {
          skipped.held += 1;
          continue;
        }
        if (positions.length + pending.length >= config.maxPositions) {
          skipped.noSlot += 1;
          continue;
        }
        const lot = config.lots ? (config.lots[signal.symbol] ?? null) : null;
        const riskPerShare = signal.entry - signal.stop;
        let { qty, lots } = sizePosition((equityNow * config.riskPct) / 100, riskPerShare, lot);
        // Leverage cap on total open notional.
        const room = equityNow * config.maxLeverage - openNotional();
        if (qty * signal.entry > room) {
          const fit = sizePosition(room * (riskPerShare / signal.entry), riskPerShare, lot);
          qty = fit.qty;
          lots = fit.lots;
        }
        if (qty <= 0) {
          skipped.tooSmall += 1;
          continue;
        }
        if (config.lots && !lot) unlotted += 1;
        busy.add(signal.symbol);
        const order: Pending = { signal, qty, lots, buyStop: isBuyStop(signal) };
        if ((config.entry === "signal-close" || exitsAtOpen(signal.screenId)) && !order.buyStop) open(order, signal.index, date, signal.close, -1);
        else pending.push(order);
      }
    }

    const equity = markToMarket();
    const bench = benchAt(date);
    curve.push({ t: date, equity, bench: bench && benchBase ? (capital * bench) / benchBase : null, drawdown: 0, open: positions.length });
  }
  const dd = drawdowns([capital, ...curve.map((point) => point.equity)]).slice(1);
  curve.forEach((point, i) => (point.drawdown = dd[i]));

  // In-sample / out-of-sample split by signal date.
  const fraction = Math.min(0.9, Math.max(0.1, config.oosFraction));
  const splitIndex = Math.min(dates.length - 1, Math.max(1, Math.round(dates.length * (1 - fraction))));
  const splitDate = dates[splitIndex];
  for (const trade of trades) trade.sample = trade.signalDate < splitDate ? "in" : "out";
  trades.sort((a, b) => a.exitDate - b.exitDate || a.id - b.id);

  const isCurve = curve.slice(0, splitIndex);
  const oosCurve = curve.slice(splitIndex);
  const isTrades = trades.filter((trade) => trade.sample === "in");
  const oosTrades = trades.filter((trade) => trade.sample === "out");
  const inSample: SampleStats = {
    from: dates[0],
    to: dates[splitIndex - 1],
    trades: tradeStats(isTrades),
    equity: equityStats(isCurve, capital, priorDate, benchBase ? capital : null),
  };
  const lastIs = isCurve.at(-1)!;
  const outOfSample: SampleStats = {
    from: splitDate,
    to: lastDate,
    trades: tradeStats(oosTrades),
    equity: equityStats(oosCurve, lastIs.equity, lastIs.t, lastIs.bench),
  };

  const trade = tradeStats(trades);
  const equity = equityStats(curve, capital, priorDate, benchBase ? capital : null);
  const byPnl = [...trades].sort((a, b) => b.pnl - a.pnl);
  const byScreen: ScreenBreakdown[] = config.screenIds
    .filter((id) => screenById.has(id))
    .map((id) => {
      const screen = screenById.get(id)!;
      return {
        screenId: id,
        name: screen.name,
        group: screen.group,
        holdBars: holdFor(id, config.holdBars),
        firstSignal: scan.firstByScreen[id] ?? null,
        signals: signalsByScreen.get(id) ?? 0,
        stats: tradeStats(trades.filter((t) => t.screenId === id)),
      };
    });

  const result: BacktestResult = {
    period: {
      from: dates[0],
      to: lastDate,
      sessions: dates.length,
      historyFrom: scan.dates[0],
      historyTo: scan.dates.at(-1)!,
      historySessions: scan.dates.length,
      firstSignalDate: scan.firstSignalDate,
    },
    config: { ...withoutLots(config), sizing: config.lots && Object.keys(config.lots).length ? "lots" : "shares" },
    signals: signalCount,
    trades,
    curve,
    trade,
    equity,
    best: byPnl[0] ?? null,
    worst: byPnl.at(-1) ?? null,
    costs: { ...chargeTotal, slippage: slippageTotal },
    monthly: monthlyReturns(curve, capital, benchBase ? capital : null),
    byScreen,
    split: { date: splitDate, fraction, inSample, outOfSample },
    skipped,
    unlotted,
    warnings: [],
  };
  result.warnings = warningsFor(result);
  return result;
}

function withoutLots(config: BacktestConfig): Omit<BacktestConfig, "lots"> {
  const { lots: _lots, ...rest } = config;
  void _lots;
  return rest;
}

const MIN_TRADES = 30;
const MIN_OOS_TRADES = 10;

/** Plain-language cautions about how far the result can be trusted. */
export function warningsFor(result: BacktestResult): string[] {
  const out: string[] = [];
  const { trade, split, period, equity, skipped } = result;
  const is = split.inSample.trades;
  const oos = split.outOfSample.trades;
  const months = Math.round((period.sessions / 21) * 10) / 10;

  if (trade.trades === 0) {
    out.push("No trades: the chosen screens never fired (or never filled) in this period.");
    return out;
  }
  if (trade.trades < MIN_TRADES) {
    out.push(
      `Only ${trade.trades} trades — too few to tell an edge from luck. About ${MIN_TRADES} is a bare minimum; with this few, one or two trades can flip the result.`,
    );
  }
  if (oos.trades < MIN_OOS_TRADES) {
    out.push(`Only ${oos.trades} trades in the out-of-sample part, so the robustness check below says little.`);
  } else if (is.avgR !== null && oos.avgR !== null) {
    if (is.avgR > 0 && oos.avgR <= 0) {
      out.push(
        `The edge didn't hold up: +${is.avgR.toFixed(2)}R a trade in the first ${Math.round((1 - split.fraction) * 100)}% of the period, ${oos.avgR.toFixed(2)}R in the last ${Math.round(split.fraction * 100)}%. Treat the overall result as unreliable.`,
      );
    } else if (is.avgR > 0 && oos.avgR < is.avgR * 0.5) {
      out.push(`Out-of-sample results are much weaker (${oos.avgR.toFixed(2)}R vs ${is.avgR.toFixed(2)}R a trade). The edge may be fading or partly luck.`);
    } else if (is.avgR <= 0 && oos.avgR > 0) {
      out.push("Results improved only in the recent part of the period — possibly a change in market conditions rather than a durable edge.");
    }
  }
  const profit = result.trades.filter((t) => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
  if (result.best && trade.netPnl > 0 && result.best.pnl > trade.netPnl * 0.5) {
    out.push(`One trade (${result.best.symbol}) made more than half of the net profit. Without it the picture changes a lot.`);
  } else if (profit > 0 && result.best && result.best.pnl > profit * 0.25 && trade.trades >= 10) {
    out.push(`The best trade (${result.best.symbol}) made a quarter or more of all gains.`);
  }
  if (skipped.noSlot > trade.trades) {
    out.push(`${skipped.noSlot} signals were skipped for lack of free slots — more than were traded. The result depends on which signals the score picked; try more positions to see the rest.`);
  }
  if (skipped.tooSmall > 0 && skipped.tooSmall >= trade.trades * 0.25) {
    out.push(`${skipped.tooSmall} signals couldn't be sized: one lot risked more than ${result.config.riskPct}% of equity (or the leverage cap was reached). Raise capital or risk % to take them.`);
  }
  if (result.unlotted > 0) out.push(`${result.unlotted} trades were sized in whole shares: no futures lot size is known for those stocks.`);
  const benches = result.curve.map((point) => point.bench).filter((value): value is number => value !== null);
  if (!benches.length) out.push("No NIFTY history is stored, so there is no benchmark line.");
  else if (Math.max(...benches) === Math.min(...benches)) out.push("The stored NIFTY history is flat (placeholder data), so the benchmark line means nothing here.");
  if (equity.years < 0.95 && equity.cagr !== null) {
    out.push(`CAGR annualises ${months} months of results — an extrapolation, not a forecast.`);
  }
  if (period.sessions < 250) {
    out.push(`Only ${period.sessions} sessions (≈${months} months) of history behind this result. A year or more, covering different market phases, is far more reliable.`);
  }
  return out;
}
