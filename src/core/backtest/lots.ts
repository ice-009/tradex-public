// Point-in-time lot sizes for backtests and the plan's evidence. Pure.
//
// NSE revises lot sizes twice a year and after splits and bonuses (SEBI's
// minimum contract value went from ₹5 lakh to ₹15 lakh in Nov 2024, so most
// lots roughly tripled). Sizing a 2024 trade with today's lot overstates its
// size. Where the point-in-time engine knows a session's lot (NSE's F&O files
// carry it from 8 Jul 2024), that lot is used, converted to the bars' shares:
// the bars are adjusted to today for later splits and bonuses, so a lot of 250
// before a 1:1 bonus is 500 of today's shares. Before then, and for a stock the
// engine has no lot for that day, today's lot is the stand-in — and the run's
// notes say on how many sessions.

import { MONTHS } from "@/core/format";
import type { Known, ReferenceHistory } from "@/core/reference/pointInTime";

/** What the lots need from the engine (a ReferenceTimeline's snapshot). */
export interface LotSource {
  at(day: number): { lots: Known<unknown>; lotInTodayShares(symbol: string): Known<number> };
}

export interface PointInTimeLots {
  /** The lot on a session, in the bars' shares: that day's when known, else today's; null when neither is known. */
  lotOn(symbol: string, day: number): number | null;
  /** One line for the run's notes: which lots sized trades on how many of the sessions. */
  note(sessions: readonly number[]): string;
}

/**
 * The lot data a run used, for its stamp (src/core/repro/stamp.ts): each of
 * `symbols`' lot changes and split/bonus factors, and from when lots are known.
 */
export function lotHistoryPart(history: Pick<ReferenceHistory, "lots" | "factors">, symbols: readonly string[]) {
  const wanted = [...new Set(symbols)].sort();
  return {
    knownFrom: history.lots?.knownFrom ?? null,
    changes: Object.fromEntries(wanted.flatMap((symbol) => {
      const changes = history.lots?.changes.get(symbol);
      return changes?.length ? [[symbol, changes.map((change) => [change.day, change.lot])]] : [];
    })),
    factors: Object.fromEntries(wanted.flatMap((symbol) => {
      const factors = history.factors.get(symbol);
      return factors?.length ? [[symbol, factors.map((factor) => [factor.day, factor.factor])]] : [];
    })),
  };
}

const dayLabel = (day: number) => {
  const date = new Date(day);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

/**
 * `today`: the stand-in where a session's lot isn't known (today's lots, or, in
 * the Time Machine, the shown day's — `standIn` names it in the note).
 */
export function pointInTimeLots(source: LotSource, today: Readonly<Record<string, number>>, standIn = "today's lot sizes"): PointInTimeLots {
  return {
    lotOn(symbol, day) {
      const fact = source.at(day).lotInTodayShares(symbol);
      if (fact.known) return fact.value;
      return today[symbol] ?? null;
    },
    note(sessions) {
      const covered = sessions.filter((day) => source.at(day).lots.known);
      if (!sessions.length) return "";
      if (!covered.length) {
        const fact = sessions.length ? source.at(sessions[0]).lots : null;
        const from = fact && !fact.known && fact.knownFrom !== null ? ` (the Market Data Hub has them from ${dayLabel(fact.knownFrom)})` : "";
        return `Lot sizes: ${standIn} for every session; the lot of each day isn't known for this period${from}.`;
      }
      const range = `${dayLabel(covered[0])} – ${dayLabel(covered.at(-1)!)}`;
      const rest = sessions.length - covered.length;
      return rest
        ? `Lot sizes: as listed on each day (NSE F&O bhavcopy) on ${covered.length} of ${sessions.length} sessions (${range}); ${standIn} on the other ${rest}, where the day's isn't known.`
        : `Lot sizes: as listed on each day (NSE F&O bhavcopy), ${range}.`;
    },
  };
}
