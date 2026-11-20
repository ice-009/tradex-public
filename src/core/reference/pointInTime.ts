import { MONTHS } from "@/core/format";
import type { ResultsEvent } from "@/core/market/results";
import { DAY_MS } from "@/core/market/session";
import type { IndexCatalog } from "@/core/screener/sectorIndex";

// The point-in-time engine (issue #19): reference data as it was known on a
// given day — the F&O list and lot sizes, the ban list, the results calendar,
// the sector map, tickers as they were named, and how far a stock's prices had
// been adjusted for splits and bonuses by then. Pure: the server loads the
// histories from the Market Data Hub (src/server/providers/asOf.ts) and every
// screener, plan and backtest read goes through `at(day)`.
//
// Every answer says whether it is known. Where the hub keeps no history (lot
// sizes before NSE's files carried them, ban lists before the hub started
// storing them, index constituents and industries, when a results date was
// announced) the answer is `known: false` with the reason and from when it
// would be known — never today's value passed off as that day's. A caller that
// wants today's value as a stand-in says so with `orElse`, and should say so in
// its output too.

/** A fact as known on a day, or why it isn't known. */
export type Known<T> =
  | {
      known: true;
      value: T;
      /** Day key of the record the value comes from (on or before the day asked about). */
      asOf: number;
      /** Where it comes from, in words ("NSE F&O bhavcopy", "today's lot file"…). */
      source: string;
    }
  | {
      known: false;
      /** Why not, in a sentence that can be shown as is. */
      reason: string;
      /** First day it is known from, when it is known from some day (null: not at all). */
      knownFrom: number | null;
    };

export const known = <T>(value: T, asOf: number, source: string): Known<T> => ({ known: true, value, asOf, source });
export const unknown = <T = never>(reason: string, knownFrom: number | null = null): Known<T> => ({ known: false, reason, knownFrom });

/** The value, or `fallback` when it isn't known (the caller should say it used one). */
export const orElse = <T>(fact: Known<T>, fallback: T): T => (fact.known ? fact.value : fallback);

export interface UniverseMember {
  symbol: string;
  name: string;
  industry: string;
}

export interface Rename {
  /** First session under the new ticker (day key). */
  day: number;
  oldSymbol: string;
  newSymbol: string;
}

/** A split/bonus ex-date: prices before `day` × `factor` are comparable with prices from it on. */
export interface PriceFactor {
  day: number;
  factor: number;
}

/**
 * Everything the engine knows, as loaded by the server. Every part is keyed by
 * today's tickers (the hub maps renamed F&O rows and price history to them).
 * A null part was not loaded (the hub couldn't answer or predates it).
 */
export interface ReferenceHistory {
  /** Today (IST day key): days after it are the future, and "current" values are for it. */
  today: number;
  fo: {
    /** Stock-futures underlyings on each F&O bhavcopy day read. */
    byDay: ReadonlyMap<number, ReadonlySet<string>>;
    /** Range `byDay` was read for (days in it without a file are holidays or missing files). */
    span: { from: number; to: number } | null;
    /** First and last bhavcopy day the hub has at all, when it said. */
    stored: { first: number; last: number } | null;
  };
  lots: {
    /** Per stock: its lot from each day it changed (as traded then, not adjusted), oldest first. */
    changes: ReadonlyMap<string, ReadonlyArray<{ day: number; lot: number }>>;
    /** First day NSE's F&O files carry lot sizes (null: none stored). */
    knownFrom: number | null;
    /** Newest F&O file read. */
    lastDay: number | null;
    /** Today's lot file (NSE fo_mktlots), which also has next month's revisions before the bhavcopy does. */
    current: Readonly<Record<string, number>> | null;
  } | null;
  ban: {
    /** Each stored trade date's list ([] = nobody banned). */
    byDay: ReadonlyMap<number, readonly string[]>;
    /** First stored trade date. */
    knownFrom: number | null;
    /** The newest list and the trade date it is for. */
    current: { tradeDate: number | null; symbols: readonly string[] } | null;
  } | null;
  results: {
    /** Results dates the hub has stored (as known today). */
    events: readonly ResultsEvent[];
    /** Range the events were read for. */
    span: { from: number; to: number };
  } | null;
  /** The hub's index catalogue (with each index's first stored session). */
  catalog: IndexCatalog | null;
  /** Today's universe lists ("fno" is the hub's newest F&O list; index lists are snapshots). */
  universes: ReadonlyMap<string, readonly UniverseMember[]>;
  /** Known ticker changes (NSE's list and ISIN changes). */
  renames: readonly Rename[] | null;
  /** Split/bonus factors per stock, oldest first, for the stocks they were loaded for. */
  factors: ReadonlyMap<string, readonly PriceFactor[]>;
}

/** What was known on one day. */
export interface PointInTime {
  day: number;
  /** The F&O stock-futures list that day (from that day's F&O bhavcopy). */
  foList: Known<ReadonlySet<string>>;
  /** Lot sizes that day, as traded then (in that day's shares, not adjusted for later splits). */
  lots: Known<Readonly<Record<string, number>>>;
  /** The F&O ban list for that trade date. */
  ban: Known<readonly string[]>;
  results: {
    /** Results dated from a week before the day to the day: certain by then. */
    reported: Known<ResultsEvent[]>;
    /** Results dated after the day that had been announced by then. */
    upcoming: Known<ResultsEvent[]>;
  };
  /** Indices with history by then, and the industry → sector-index map. */
  sectors: Known<IndexCatalog>;
  /** Industry per stock. */
  industries: Known<ReadonlyMap<string, string>>;
  /** A universe's members that day. */
  universe(id: string): Known<readonly UniverseMember[]>;
  /** Today's ticker as it was named that day. */
  ticker(symbol: string): Known<string>;
  /**
   * What a price adjusted to today (the hub's `adjust=split` bars) on or before
   * this day is multiplied by to be adjusted only for the splits and bonuses
   * that had happened by then: 1 / the product of the later factors.
   */
  priceScale(symbol: string): Known<number>;
  /** That day's lot in today-adjusted shares (the lot ÷ the later factors' product: 250 before a 1:1 bonus is 500), for sizing on adjusted bars. */
  lotInTodayShares(symbol: string): Known<number>;
}

export interface ReferenceTimeline {
  history: ReferenceHistory;
  at(day: number): PointInTime;
}

/** A missing F&O file (or a holiday run) this long is bridged with the file before it. */
export const MAX_FILE_GAP_DAYS = 7;
/** Results "reported" looks back this far. */
const REPORTED_DAYS = 7;

const label = (day: number) => {
  const date = new Date(day);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

/** Index of the last element of sorted `days` that is <= day, or -1. */
function floorIndex(days: readonly number[], day: number): number {
  let lo = 0;
  let hi = days.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid] <= day) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Product of the factors with an ex-date after `day` (what a bar on `day` was multiplied by to be adjusted to today). */
export function laterFactor(factors: readonly PriceFactor[], day: number): number {
  let product = 1;
  for (const factor of factors) if (factor.day > day) product *= factor.factor;
  return product;
}

/**
 * Bars adjusted to today, re-expressed as they were adjusted on `day` (only the
 * splits and bonuses with an ex-date on or before it): prices ÷ the later
 * factors' product, volumes × it. Bars after `day` are dropped.
 */
export function adjustAsOf<B extends { t: number; o: number; h: number; l: number; c: number; v: number }>(bars: readonly B[], factors: readonly PriceFactor[], day: number): B[] {
  const scale = 1 / laterFactor(factors, day);
  const upTo = bars.filter((bar) => bar.t <= day);
  if (scale === 1) return upTo;
  return upTo.map((bar) => ({ ...bar, o: bar.o * scale, h: bar.h * scale, l: bar.l * scale, c: bar.c * scale, v: bar.v / scale }));
}

/** Today's ticker as named on `day`, following the renames back in time. */
export function tickerOn(renames: readonly Rename[], symbol: string, day: number): string {
  let name = symbol;
  // Newest first: each rename after `day` that produced the current name undoes one step.
  const sorted = [...renames].sort((a, b) => b.day - a.day);
  for (const change of sorted) if (change.day > day && change.newSymbol === name) name = change.oldSymbol;
  return name;
}

export function referenceTimeline(history: ReferenceHistory): ReferenceTimeline {
  const { today } = history;
  const foDays = [...history.fo.byDay.keys()].sort((a, b) => a - b);
  const banDays = history.ban ? [...history.ban.byDay.keys()].sort((a, b) => a - b) : [];
  const lotChanges = history.lots ? [...history.lots.changes].map(([symbol, changes]) => ({ symbol, changes, days: changes.map((change) => change.day) })) : [];
  const sortedRenames = history.renames ? [...history.renames].sort((a, b) => b.day - a.day) : null;
  const industries = new Map<string, string>();
  for (const id of ["nifty500", "fno", "nifty200", "nifty50"]) for (const member of history.universes.get(id) ?? []) if (member.industry && !industries.has(member.symbol)) industries.set(member.symbol, member.industry);
  const memo = new Map<number, PointInTime>();

  const future = (what: string, day: number) => unknown<never>(`${what} for ${label(day)} isn't known yet: that day is after today.`);

  function foListOn(day: number): Known<ReadonlySet<string>> {
    if (day > today) return future("The F&O list", day);
    const i = floorIndex(foDays, day);
    if (i >= 0 && day - foDays[i] <= MAX_FILE_GAP_DAYS * DAY_MS) return known(history.fo.byDay.get(foDays[i])!, foDays[i], "NSE F&O bhavcopy");
    const first = history.fo.stored?.first ?? foDays[0] ?? null;
    const span = history.fo.span;
    if (span && (day < span.from || day > span.to)) return unknown(`The F&O list for ${label(day)} wasn't read (asked for ${label(span.from)} – ${label(span.to)}).`, first);
    if (first !== null && day < first) return unknown(`The Market Data Hub has NSE's F&O bhavcopy from ${label(first)}; the F&O list before that isn't known.`, first);
    return unknown(`The Market Data Hub has no F&O bhavcopy for ${label(day)} or the week before it.`, first);
  }

  function lotsOn(day: number, foList: Known<ReadonlySet<string>>): Known<Readonly<Record<string, number>>> {
    if (day > today) return future("Lot sizes", day);
    const lots = history.lots;
    if (!lots) return unknown("Lot sizes couldn't be read from the Market Data Hub.");
    const lastDay = lots.lastDay ?? -Infinity;
    // Today, or past the newest F&O file: today's lot file is the newer record.
    if (lots.current && Object.keys(lots.current).length && (day === today || (day > lastDay && today - day <= MAX_FILE_GAP_DAYS * DAY_MS))) return known(lots.current, today, "NSE lot file (today's)");
    if (lots.knownFrom === null || day < lots.knownFrom) {
      const from = lots.knownFrom;
      return unknown(from === null ? "The Market Data Hub has no F&O file with lot sizes (NSE's files carry them from 8 Jul 2024)." : `Lot sizes are known from ${label(from)} (NSE's F&O files before then don't carry them).`, from);
    }
    if (day - lastDay > MAX_FILE_GAP_DAYS * DAY_MS) return unknown(`The Market Data Hub's lot history ends ${label(lastDay)}.`, lots.knownFrom);
    const members = foList.known ? foList.value : null;
    const out: Record<string, number> = {};
    let asOf = lots.knownFrom;
    for (const { symbol, changes, days } of lotChanges) {
      if (members && !members.has(symbol)) continue;
      const i = floorIndex(days, day);
      if (i < 0) continue;
      out[symbol] = changes[i].lot;
      asOf = Math.max(asOf, changes[i].day);
    }
    return known(out, foList.known ? foList.asOf : asOf, "NSE F&O bhavcopy (lot column)");
  }

  function banOn(day: number): Known<readonly string[]> {
    if (day > today + MAX_FILE_GAP_DAYS * DAY_MS) return future("The F&O ban list", day);
    const ban = history.ban;
    if (!ban) return unknown("The F&O ban list couldn't be read from the Market Data Hub.");
    // Today: the newest list (in the evening, NSE's list for the next session — what a trade entered now faces).
    if (day === today && ban.current) return known(ban.current.symbols, ban.current.tradeDate ?? today, "NSE F&O ban list (newest)");
    const stored = ban.byDay.get(day);
    if (stored) return known(stored, day, "NSE F&O ban list");
    const first = ban.knownFrom ?? banDays[0] ?? null;
    if (first === null || day < first) return unknown(`The Market Data Hub has stored the F&O ban list ${first === null ? "on no day yet" : `from ${label(first)}`}; earlier lists aren't known.`, first);
    return unknown(`The Market Data Hub has no F&O ban list stored for ${label(day)}.`, first);
  }

  function resultsOn(day: number): PointInTime["results"] {
    const results = history.results;
    if (!results) {
      const why = unknown<ResultsEvent[]>("The results calendar couldn't be read from the Market Data Hub.");
      return { reported: why, upcoming: why };
    }
    const from = day - REPORTED_DAYS * DAY_MS;
    const covered = from >= results.span.from && day <= results.span.to;
    const reported = covered && day <= today ? known(results.events.filter((event) => event.date >= from && event.date <= day), day, "NSE PR zip (board meetings)") : unknown<ResultsEvent[]>(`The results calendar wasn't read around ${label(day)}.`);
    // Which later dates had been announced by a past day isn't stored: the hub keeps each event, not the day it first appeared.
    const upcoming =
      day === today
        ? known(results.events.filter((event) => event.date > day), today, "NSE PR zip (board meetings)")
        : day > today
          ? future("The results calendar", day)
          : unknown<ResultsEvent[]>("Which results dates had been announced by then isn't known: the Market Data Hub doesn't store when each date was first announced.", today);
    return { reported, upcoming };
  }

  function sectorsOn(day: number): Known<IndexCatalog> {
    const catalog = history.catalog;
    if (!catalog?.available) return unknown("The Market Data Hub's index catalogue isn't available.");
    if (day > today) return future("The sector map", day);
    // Indices with history by then; each one's last session clipped to the day. The industry → index map is the hub's current one.
    const indices = catalog.indices.filter((entry) => entry.firstDay !== null && entry.firstDay <= day).map((entry) => ({ ...entry, lastDay: entry.lastDay === null ? null : Math.min(entry.lastDay, day) }));
    return known({ ...catalog, indices }, day, day === today ? "Market Data Hub index catalogue" : "Market Data Hub index catalogue (indices with history by then; today's sector map)");
  }

  function industriesOn(day: number): Known<ReadonlyMap<string, string>> {
    if (day === today) return industries.size ? known(industries, today, "NSE index lists (industry)") : unknown("No industry classification is loaded.");
    return unknown("Industries are today's classification (NSE's index lists); the history of it isn't stored.", today);
  }

  function universeOn(day: number, foList: Known<ReadonlySet<string>>, id: string): Known<readonly UniverseMember[]> {
    const members = history.universes.get(id);
    if (day === today) return members ? known(members, today, id === "fno" ? "Market Data Hub F&O list" : "NSE index list (snapshot)") : unknown(`No list for universe ${id}.`);
    if (id !== "fno") return unknown(`The ${id} constituents are today's snapshot; past constituents aren't stored.`, today);
    if (!foList.known) return foList;
    const names = new Map((members ?? []).map((member) => [member.symbol, member.name]));
    return known(
      [...foList.value].sort().map((symbol) => ({ symbol, name: names.get(symbol) ?? symbol, industry: industries.get(symbol) ?? "" })),
      foList.asOf,
      foList.source,
    );
  }

  function at(day: number): PointInTime {
    const cached = memo.get(day);
    if (cached) return cached;
    const foList = foListOn(day);
    const lots = lotsOn(day, foList);
    const factorsOf = (symbol: string) => history.factors.get(symbol);
    const snapshot: PointInTime = {
      day,
      foList,
      lots,
      ban: banOn(day),
      results: resultsOn(day),
      sectors: sectorsOn(day),
      industries: industriesOn(day),
      universe: (id) => universeOn(day, foList, id),
      ticker: (symbol) => {
        if (!sortedRenames) return unknown("Ticker changes couldn't be read from the Market Data Hub.");
        return known(tickerOn(sortedRenames, symbol, day), day, "NSE symbol changes");
      },
      priceScale: (symbol) => {
        const factors = factorsOf(symbol);
        return factors ? known(1 / laterFactor(factors, day), day, "Market Data Hub split/bonus factors") : unknown(`Split/bonus factors for ${symbol} weren't loaded.`);
      },
      lotInTodayShares: (symbol) => {
        if (!lots.known) return lots;
        const lot = lots.value[symbol];
        if (lot === undefined) return unknown(`${symbol} had no stock futures on ${label(day)}.`);
        const factors = factorsOf(symbol);
        if (!factors) return unknown(`Split/bonus factors for ${symbol} weren't loaded.`);
        return known(lot / laterFactor(factors, day), lots.asOf, lots.source);
      },
    };
    memo.set(day, snapshot);
    return snapshot;
  }

  return { history, at };
}
