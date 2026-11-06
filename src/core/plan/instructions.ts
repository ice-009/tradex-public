import { formatPrice } from "@/core/format";
import { isBuyStop } from "@/core/screener/planStatus";
import { HOLD_BARS } from "@/core/screener/backtest";
import type { ScreenDef, TradePlan } from "@/core/screener/screens";

// Plain instructions for one trade: how to get in and how to get out. They
// follow what the evidence engine tested (src/core/plan/evidence.ts): bought
// at the signal close (3:15–3:25 PM) or on a buy-stop the next session; out at
// the stop, the target, the next open (BTST) or the close after the holding
// period. The one extra is the Turtle screen's own trailing exit (a close
// below the 10-session low), shown because it is part of that screen's rules;
// the 5-year test used its 2N stop and time exit only. Pure.

export type EntryKind = "close" | "buy-stop" | "btst";

/**
 * How a trade is exited, stored with each journal trade:
 *   next-open      sell at the next session's open (BTST)
 *   stop-target    stop, target, else the close after the holding period
 *   time           stop, else the close after the holding period (no fixed target)
 *   trail-low:N    stop, a close below the N-session low, else the time exit
 */
export type ExitRule = "next-open" | "stop-target" | "time" | `trail-low:${number}`;

/** Screens with a trailing exit of their own (in their plan text). */
const TRAILS: Record<string, number> = { "pos-turtle-adx": 10 };

export function entryKind(screen: Pick<ScreenDef, "exit">, plan: Pick<TradePlan, "entry" | "stop">, close: number): EntryKind {
  if (screen.exit === "next-open") return "btst";
  return isBuyStop(plan, close) ? "buy-stop" : "close";
}

export function entryText(kind: EntryKind, price: number): string {
  if (kind === "btst") return `Buy 3:15–3:25 PM near ₹${formatPrice(price)}, sell at tomorrow's open`;
  if (kind === "buy-stop") return `Buy-stop at ₹${formatPrice(price)} next session`;
  return `Buy 3:15–3:25 PM near ₹${formatPrice(price)}`;
}

export function exitRuleFor(screen: Pick<ScreenDef, "id" | "exit">, plan: Pick<TradePlan, "target">): ExitRule {
  if (screen.exit === "next-open") return "next-open";
  const trail = TRAILS[screen.id];
  if (trail) return `trail-low:${trail}`;
  return plan.target !== null ? "stop-target" : "time";
}

/** Sessions until the time exit (BTST: 1, the next open). */
export const holdSessionsFor = (screen: Pick<ScreenDef, "group">) => HOLD_BARS[screen.group];

/** Trailing-low length of an exit rule, or null. */
export function trailSessions(rule: string): number | null {
  const match = /^trail-low:(\d+)$/.exec(rule);
  return match ? Number(match[1]) : null;
}

/** One line: "stop 398 · target 450 · else sell after 25 sessions". */
export function exitText(rule: string, plan: Pick<TradePlan, "stop" | "target">, hold: number): string {
  const stop = `stop ${formatPrice(plan.stop)}`;
  if (rule === "next-open") return `sell at tomorrow's open · ${stop} sizes it (a gap below it is the loss)`;
  const trail = trailSessions(rule);
  const time = `else sell at the close after ${hold} sessions`;
  if (trail) return `${stop} · trail: exit on a close below the ${trail}-day low · ${time}`;
  if (rule === "stop-target" && plan.target !== null) return `${stop} · target ${formatPrice(plan.target)} · ${time}`;
  return `${stop} · ${time}`;
}

/** Short exit label for compact rows: "trail 10-day low", "target 450", "tomorrow's open". */
export function exitShort(rule: string, plan: Pick<TradePlan, "target">, hold: number): string {
  if (rule === "next-open") return "sell at tomorrow's open";
  const trail = trailSessions(rule);
  if (trail) return `trail ${trail}-day low · ${hold} sessions max`;
  if (plan.target !== null && rule === "stop-target") return `target ${formatPrice(plan.target)} · ${hold} sessions max`;
  return `sell after ${hold} sessions`;
}
