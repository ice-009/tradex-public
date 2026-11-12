// Point-in-time universe for backtests of the F&O list. Pure.
//
// Today's F&O list applied to the past has survivorship bias: stocks NSE
// dropped from F&O during the period are missing and stocks added after a
// strong run are included. Where the Market Data Hub has NSE's F&O bhavcopy
// for a session (GET /v1/fo/members), membership on it is "had stock futures
// that day", so a signal only counts for a stock that could actually have been
// traded in futures then. Sessions it has no file for fall back to today's
// list, and the result says how many sessions used which.
//
// In the research run behind this (BTST closing-strength, Oct 2025 – Nov 2026)
// switching to point-in-time membership moved the result by only ~0.015 pp a
// day, so treat it as a correctness fix, not a source of edge.

import { MONTHS } from "@/core/format";

export interface MembershipSource {
  /** Stock-futures underlyings per session (day key), from the F&O bhavcopy. */
  byDay: ReadonlyMap<number, ReadonlySet<string>>;
  /** Today's list, for sessions the bhavcopy doesn't cover. */
  today: readonly string[];
}

export interface PointInTimeUniverse {
  /** Everyone who was a member on some session, plus today's list. */
  symbols: string[];
  isMember(symbol: string, date: number): boolean;
}

export function pointInTimeUniverse({ byDay, today }: MembershipSource): PointInTimeUniverse {
  const current = new Set(today);
  const all = new Set(today);
  for (const members of byDay.values()) for (const symbol of members) all.add(symbol);
  return {
    symbols: [...all].sort(),
    isMember: (symbol, date) => (byDay.get(date) ?? current).has(symbol),
  };
}

const dayLabel = (day: number) => {
  const date = new Date(day);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

/**
 * One line for the backtest's notes: which list decided membership on how many
 * of the period's sessions, and which former members had no price history.
 */
export function universeNote(params: { sessions: number[]; byDay: ReadonlyMap<number, ReadonlySet<string>>; noHistory: string[] }): string {
  const { sessions, byDay, noHistory } = params;
  const covered = sessions.filter((day) => byDay.has(day));
  if (!covered.length) {
    return "Universe: today's F&O list for every session, so stocks dropped from F&O during the period are missing and later additions are included (survivorship bias). The Market Data Hub has no F&O bhavcopy for these sessions, which is where the list of each day comes from.";
  }
  const range = `${dayLabel(covered[0])} – ${dayLabel(covered.at(-1)!)}`;
  const rest = sessions.length - covered.length;
  const missing = noHistory.length
    ? ` ${noHistory.length} former member${noHistory.length === 1 ? " has" : "s have"} no stored price history and ${noHistory.length === 1 ? "is" : "are"} left out (${noHistory.slice(0, 6).join(", ")}${noHistory.length > 6 ? "…" : ""}).`
    : "";
  return rest
    ? `Universe: F&O stocks as listed on each day (NSE F&O bhavcopy) on ${covered.length} of ${sessions.length} sessions (${range}); today's list on the other ${rest}.${missing}`
    : `Universe: F&O stocks as listed on each day (NSE F&O bhavcopy), ${range}.${missing}`;
}
