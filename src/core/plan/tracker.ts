import { formatPrice } from "@/core/format";
import { SESSION_CLOSE_MIN, SESSION_OPEN_MIN, isWeekday, istParts } from "@/core/market/session";
import type { DailyBar } from "@/core/types";
import { trailSessions } from "./instructions";

// Today's instruction for an open trade from the journal: which session of the
// hold it is in, where it stands in R, and what to do — sell at the open
// (BTST), the stop or target was hit, the time exit is due, or the trailing
// level for screens that trail. The rules are the plan's own (see
// instructions.ts), checked against the stored daily bars since entry and,
// when there is one, the live price. Pure.

export interface TrackedTrade {
  entryPrice: number;
  /** Planned stop and target (the R unit is the planned entry − stop). */
  plannedEntry: number;
  stop: number;
  target: number | null;
  exitRule: string;
  holdSessions: number;
  /** IST day key of the entry session. */
  entryDay: number;
}

export type TrackAction = "sell-open" | "overnight" | "stop" | "target" | "trail" | "time" | "hold";

export interface TradeTrack {
  /** Sessions after the entry session so far (today's counts once it has opened). */
  session: number;
  holdSessions: number;
  /** Price the R is worked out at: live when given, else the last stored close. */
  price: number;
  live: boolean;
  /** (price − entry) ÷ (planned entry − stop). */
  r: number;
  /** Trailing exit level right now (N-session low), for trailing rules. */
  trailStop: number | null;
  action: TrackAction;
  text: string;
  /** Something to do today, not just "hold". */
  urgent: boolean;
}

/** R of a long trade at a price, in units of the planned risk. */
export function rAt(trade: Pick<TrackedTrade, "entryPrice" | "plannedEntry" | "stop">, price: number): number {
  const risk = trade.plannedEntry - trade.stop;
  return risk > 0 ? (price - trade.entryPrice) / risk : 0;
}

const lowOf = (bars: DailyBar[]) => Math.min(...bars.map((bar) => bar.l));

/**
 * Lay a live price over a track worked out from stored bars (the browser has
 * the price, the server the bars): the R at that price, and a stop, target or
 * trailing level it has just crossed. An action already due stays.
 */
export function withLivePrice(track: TradeTrack, trade: TrackedTrade, price: number | null | undefined): TradeTrack {
  if (!price || !(price > 0)) return track;
  const next: TradeTrack = { ...track, price, live: true, r: rAt(trade, price) };
  if (track.urgent || trade.exitRule === "next-open") return next;
  if (price <= trade.stop) return { ...next, action: "stop", text: `At or below the stop ${formatPrice(trade.stop)}: exit`, urgent: true };
  if (trade.target !== null && price >= trade.target) return { ...next, action: "target", text: `At the target ${formatPrice(trade.target)}: take the profit`, urgent: true };
  const trail = trailSessions(trade.exitRule);
  if (trail && track.trailStop !== null && price < track.trailStop) {
    return { ...next, text: `Below the ${trail}-day low ${formatPrice(track.trailStop)}: exit at the close if it stays there` };
  }
  return next;
}

export function trackTrade(trade: TrackedTrade, bars: DailyBar[], now: number, livePrice?: number | null): TradeTrack {
  const { day: today, minutes } = istParts(now);
  const after = bars.filter((bar) => bar.t > trade.entryDay);
  const sessionOpen = isWeekday(today) && minutes >= SESSION_OPEN_MIN;
  const todayLive = today > trade.entryDay && sessionOpen && !after.some((bar) => bar.t === today);
  const session = after.length + (todayLive ? 1 : 0);
  const lastClose = after.at(-1)?.c ?? bars.filter((bar) => bar.t <= trade.entryDay).at(-1)?.c ?? trade.entryPrice;
  const live = livePrice !== null && livePrice !== undefined && livePrice > 0;
  const price = live ? livePrice! : lastClose;
  const trail = trailSessions(trade.exitRule);
  const lastN = trail ? bars.slice(-trail) : [];
  const trailStop = trail && lastN.length === trail ? lowOf(lastN) : null;
  const base = { session, holdSessions: trade.holdSessions, price, live, r: rAt(trade, price), trailStop };
  const result = (action: TrackAction, text: string): TradeTrack => ({ ...base, action, text, urgent: action !== "hold" && action !== "overnight" });

  // Overnight trades: out at the first open after the entry.
  if (trade.exitRule === "next-open") {
    if (today <= trade.entryDay && !after.length) return result("overnight", "Hold overnight · sell at tomorrow's open");
    if (sessionOpen || after.length > 1) return result("sell-open", "Sell now: it was due at today's open");
    return result("sell-open", isWeekday(today) ? "Sell at today's open" : "Sell at the next session's open");
  }

  // Stored sessions in order: the first level reached decides (a bar touching both counts as the stop).
  for (let i = 0; i < after.length; i += 1) {
    const bar = after[i];
    if (bar.l <= trade.stop) return result("stop", `Stop ${formatPrice(trade.stop)} was hit: exit`);
    if (trade.target !== null && bar.h >= trade.target) return result("target", `Target ${formatPrice(trade.target)} was hit: take the profit`);
    if (trail) {
      const before = bars.filter((entry) => entry.t < bar.t).slice(-trail);
      if (before.length === trail && bar.c < lowOf(before)) return result("trail", `Closed below the ${trail}-day low (${formatPrice(lowOf(before))}): exit`);
    }
  }
  if (live && price <= trade.stop) return result("stop", `At or below the stop ${formatPrice(trade.stop)}: exit`);
  if (live && trade.target !== null && price >= trade.target) return result("target", `At the target ${formatPrice(trade.target)}: take the profit`);

  if (session > trade.holdSessions || (session === trade.holdSessions && !todayLive)) {
    return result("time", `Time exit was due at the close of session ${trade.holdSessions}: sell`);
  }
  if (session === trade.holdSessions) {
    return result("time", minutes > SESSION_CLOSE_MIN ? "Time exit was due at today's close: sell at the next open" : "Time exit: sell at today's close (3:15–3:30 PM)");
  }
  if (trail && trailStop !== null && live && price < trailStop) return result("hold", `Below the ${trail}-day low ${formatPrice(trailStop)}: exit at the close if it stays there`);
  if (trail && trailStop !== null) return result("hold", `Hold · trail stop now ${formatPrice(Math.max(trailStop, trade.stop))}`);
  return result("hold", `Hold · stop ${formatPrice(trade.stop)}${trade.target !== null ? ` · target ${formatPrice(trade.target)}` : ""}`);
}
