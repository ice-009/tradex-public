import "server-only";

import { DAY_MS, istParts } from "@/core/market/session";
import { MAX_FILE_GAP_DAYS, referenceTimeline, type PointInTime, type ReferenceHistory, type ReferenceTimeline, type UniverseMember } from "@/core/reference/pointInTime";
import { foMembership } from "@/server/providers/foData";
import { getFnoBan, getIndexCatalog, getLotSizes, getResultsCalendar } from "@/server/providers/reference";
import { banHistory, lotHistory, priceFactors, renames, resultsBetween, resultsWindow } from "@/server/providers/referenceHistory";
import { UNIVERSES, getUniverse } from "@/server/providers/universe";

// The point-in-time engine's one door (issue #19). The screener, the plan and
// the backtester read reference data — the F&O list, lot sizes, the ban list,
// the results calendar, the sector map, universes, ticker names and how far
// prices had been adjusted — only through here; ESLint stops them importing
// the providers below directly (eslint.config.mjs).
//
//   asOf(day)              what was known on one day (today by default)
//   asOfSpan(from, to)     the same for every day of a span, read with one set
//                          of hub requests: `.at(day)` answers like asOf(day)
//
// The rules (what is known when, and what isn't) are pure, in
// src/core/reference/pointInTime.ts. The data comes from the Market Data Hub
// through the cached providers: reference.ts (today's lots, ban list, results
// and index catalogue), foData.ts (F&O list per day), referenceHistory.ts
// (lot and ban history, split/bonus factors, ticker changes) and universe.ts.

export type { Known, PointInTime, ReferenceTimeline, UniverseMember } from "@/core/reference/pointInTime";
export { orElse } from "@/core/reference/pointInTime";

export interface SpanOptions {
  /** Stocks whose split/bonus factors to load (default: every F&O stock of the span and today's universes, unless `factors` is false). */
  symbols?: readonly string[];
  /** False: load no split/bonus factors unless `symbols` names some (asOf(day) default). */
  factors?: boolean;
  /** Read the results calendar for the span (default: only when it is at most 400 days). */
  results?: boolean;
}

const MAX_RESULTS_SPAN_DAYS = 400;

/** Today's universes: the F&O list from the hub (or the snapshot) and the index lists. */
async function universes(): Promise<Map<string, UniverseMember[]>> {
  const lists = await Promise.all(UNIVERSES.map(async ({ id }) => [id, await getUniverse(id)] as const));
  return new Map(lists);
}

/** Every day of `from`..`to` (day keys), as known on each. */
export async function asOfSpan(from: number, to: number, options: SpanOptions = {}): Promise<ReferenceTimeline> {
  const today = istParts().day;
  const last = Math.min(to, today);
  // A week before `from`, so its first days can lean on the file before a holiday.
  const window = { from: from - MAX_FILE_GAP_DAYS * DAY_MS, to: last };
  const spanDays = (to - from) / DAY_MS;
  const wantResults = options.results ?? spanDays <= MAX_RESULTS_SPAN_DAYS;
  const results = resultsWindow(from, to);

  const [byDay, lots, currentLots, ban, currentBan, catalog, lists, changes, events] = await Promise.all([
    window.to >= window.from ? foMembership(window.from, window.to) : Promise.resolve(new Map<number, Set<string>>()),
    lotHistory(),
    getLotSizes(),
    banHistory(),
    getFnoBan(),
    getIndexCatalog(),
    universes(),
    renames(),
    !wantResults ? Promise.resolve(null) : spanDays === 0 && from === today ? getResultsCalendar().then((calendar) => (calendar.available ? calendar.events : null)) : resultsBetween(results.from, results.to),
  ]);

  const symbols = options.symbols ?? (options.factors === false ? [] : [...new Set([...[...byDay.values()].flatMap((set) => [...set]), ...[...lists.values()].flatMap((members) => members.map((member) => member.symbol))])]);
  const factors = symbols.length ? await priceFactors(symbols) : new Map();

  const history: ReferenceHistory = {
    today,
    fo: { byDay, span: window.to >= window.from ? window : null, stored: null },
    lots:
      lots || Object.keys(currentLots.lots).length
        ? {
            changes: lots?.changes ?? new Map(),
            knownFrom: lots?.knownFrom ?? null,
            lastDay: lots?.lastDay ?? null,
            current: Object.keys(currentLots.lots).length ? currentLots.lots : null,
          }
        : null,
    ban:
      ban || currentBan.available
        ? {
            byDay: ban?.byDay ?? new Map(),
            knownFrom: ban?.knownFrom ?? null,
            current: currentBan.available ? { tradeDate: currentBan.tradeDate, symbols: currentBan.symbols } : null,
          }
        : null,
    results: events ? { events, span: spanDays === 0 && from === today ? { from: today - 7 * DAY_MS, to: today + 60 * DAY_MS } : results } : null,
    catalog,
    universes: lists,
    renames: changes,
    factors,
  };
  return referenceTimeline(history);
}

/** What was known on `day` (a day key; today by default). Split/bonus factors only for `options.symbols`. */
export async function asOf(day: number = istParts().day, options: Pick<SpanOptions, "symbols"> = {}): Promise<PointInTime> {
  return (await asOfSpan(day, day, { factors: false, ...options })).at(day);
}
