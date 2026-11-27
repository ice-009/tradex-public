import "server-only";

import type { ResultsEvent } from "@/core/market/results";
import { dedupeEvents } from "@/core/market/results";
import { DAY_MS } from "@/core/market/session";
import type { PriceFactor, Rename } from "@/core/reference/pointInTime";
import { hubClient } from "@/server/providers/hub";
import { log } from "@/server/log";

// Reference data as it was on past days, from the Market Data Hub, for the
// point-in-time engine (src/server/providers/asOf.ts — read it through that):
//
//   lot history       GET /v1/lots/history         lot per stock per F&O day (8 Jul 2024 on)   cached 6 h
//   ban history       GET /v1/fo/ban/history       every stored trade date's ban list          cached 30 min
//   price factors     GET /v1/adjustments/batch    split/bonus factors per stock               cached 6 h per stock
//   ticker changes    GET /v1/symbols/changes      NSE's renames                               cached 12 h
//   results by span   GET /v1/results-calendar     results dates over a past span              cached 6 h
//   trading calendar  GET /v1/calendar             NSE's sessions since 1994 (hub #17)          cached 12 h
//
// A hub that predates an endpoint (market-data-hub#46) or can't answer gives
// null, and asOf says the data isn't known rather than using today's.

const LOTS_TTL_MS = 6 * 60 * 60 * 1000;
const BAN_TTL_MS = 30 * 60 * 1000;
const FACTORS_TTL_MS = 6 * 60 * 60 * 1000;
const RENAMES_TTL_MS = 12 * 60 * 60 * 1000;
const RESULTS_TTL_MS = 6 * 60 * 60 * 1000;
const CALENDAR_TTL_MS = 12 * 60 * 60 * 1000;
/** NSE's first session in its archive (3 Nov 1994): the calendar is read from here. */
const CALENDAR_FROM = Date.UTC(1994, 10, 1);
const RETRY_MS = 10 * 60 * 1000;
const isoDay = (day: number) => new Date(day).toISOString().slice(0, 10);

export interface LotHistory {
  changes: Map<string, Array<{ day: number; lot: number }>>;
  knownFrom: number | null;
  lastDay: number | null;
}

export interface BanHistory {
  byDay: Map<number, string[]>;
  knownFrom: number | null;
}

interface Slot<T> {
  value: T | null;
  at: number;
  ok: boolean;
  pending: Promise<T | null> | null;
}

const globalForHistory = globalThis as unknown as {
  refLots?: Slot<LotHistory>;
  refBan?: Slot<BanHistory>;
  refRenames?: Slot<Rename[]>;
  refFactors?: Map<string, { at: number; factors: PriceFactor[] }>;
  refResults?: Map<string, Slot<ResultsEvent[]>>;
  refCalendar?: Slot<number[]>;
};
const slot = <T>(): Slot<T> => ({ value: null, at: 0, ok: false, pending: null });
const lotsSlot: Slot<LotHistory> = (globalForHistory.refLots ??= slot());
const banSlot: Slot<BanHistory> = (globalForHistory.refBan ??= slot());
const renamesSlot: Slot<Rename[]> = (globalForHistory.refRenames ??= slot());
const factorCache = (globalForHistory.refFactors ??= new Map());
const resultsSlots = (globalForHistory.refResults ??= new Map());
const calendarSlot: Slot<number[]> = (globalForHistory.refCalendar ??= slot());

/** The cached value, re-read when older than `ttl` (or RETRY_MS after a failure); waits only for the first answer. */
function read<T>(state: Slot<T>, ttl: number, what: string, load: () => Promise<T>): Promise<T | null> {
  if (Date.now() - state.at > (state.ok ? ttl : RETRY_MS) && !state.pending) {
    state.pending = load()
      .then((value) => {
        state.value = value;
        state.ok = true;
        return value;
      })
      .catch((error: Error) => {
        log.warn(`${what} from the Market Data Hub failed`, { error: error.message });
        return state.value;
      })
      .finally(() => {
        state.at = Date.now();
        state.pending = null;
      });
  }
  if (state.pending && !state.ok) return state.pending;
  return Promise.resolve(state.value);
}

/** Lot sizes per stock as they changed over the stored F&O days; null when the hub can't say. */
export function lotHistory(): Promise<LotHistory | null> {
  const hub = hubClient();
  if (!hub) return Promise.resolve(null);
  return read(lotsSlot, LOTS_TTL_MS, "Lot history", async () => {
    const answer = await hub.lotHistory();
    const changes = new Map<string, Array<{ day: number; lot: number }>>();
    for (const [symbol, list] of Object.entries(answer.lots ?? {})) changes.set(symbol.toUpperCase(), list.filter((entry) => Number.isFinite(entry.day) && entry.lot > 0).map((entry) => ({ day: entry.day, lot: entry.lot })));
    return { changes, knownFrom: answer.knownFromDay ?? null, lastDay: Number.isFinite(answer.lastDay) ? answer.lastDay : null };
  });
}

/** Every stored trade date's ban list; null when the hub can't say. */
export function banHistory(): Promise<BanHistory | null> {
  const hub = hubClient();
  if (!hub) return Promise.resolve(null);
  return read(banSlot, BAN_TTL_MS, "Ban-list history", async () => {
    const answer = await hub.foBanHistory();
    return { byDay: new Map((answer.days ?? []).map((day) => [day.day, day.symbols ?? []])), knownFrom: answer.knownFromDay ?? null };
  });
}

/** Known ticker changes; null when the hub can't say. */
export function renames(): Promise<Rename[] | null> {
  const hub = hubClient();
  if (!hub) return Promise.resolve(null);
  return read(renamesSlot, RENAMES_TTL_MS, "Ticker changes", async () => {
    const answer = await hub.symbolChanges();
    return (answer.changes ?? []).filter((change) => Number.isFinite(change.day)).map((change) => ({ day: change.day, oldSymbol: change.oldSymbol, newSymbol: change.newSymbol }));
  });
}

/** Split/bonus factors for these stocks (oldest first); a stock is missing when the hub couldn't say. */
export async function priceFactors(symbols: readonly string[]): Promise<Map<string, PriceFactor[]>> {
  const out = new Map<string, PriceFactor[]>();
  const now = Date.now();
  const missing: string[] = [];
  for (const symbol of new Set(symbols)) {
    const entry = factorCache.get(symbol);
    if (entry && now - entry.at < FACTORS_TTL_MS) out.set(symbol, entry.factors);
    else missing.push(symbol);
  }
  const hub = hubClient();
  if (!missing.length || !hub) return out;
  try {
    const answer = await hub.adjustmentsBatch(missing);
    for (const symbol of missing) {
      const series = answer.series?.[symbol];
      if (!series) continue;
      const factors = (series.factors ?? []).filter((factor) => Number.isFinite(factor.day) && factor.factor > 0).map((factor) => ({ day: factor.day, factor: factor.factor }));
      factorCache.set(symbol, { at: now, factors });
      out.set(symbol, factors);
    }
  } catch (error) {
    log.warn("Split/bonus factors from the Market Data Hub failed", { error: (error as Error).message });
  }
  return out;
}

/** NSE's trading days (day keys, ascending) from 1994 to a month ahead; null when the hub can't say (one with no /v1/calendar). */
export function tradingCalendar(): Promise<number[] | null> {
  const hub = hubClient();
  if (!hub) return Promise.resolve(null);
  return read(calendarSlot, CALENDAR_TTL_MS, "Trading calendar", async () => {
    const answer = await hub.calendar(isoDay(CALENDAR_FROM), isoDay(Date.now() + 31 * DAY_MS));
    return (answer.tradingDays ?? []).map((date) => Date.parse(`${date}T00:00:00Z`)).filter(Number.isFinite).sort((a, b) => a - b);
  });
}

/** Results dates between two days (as stored by the hub today); null when it can't say. */
export function resultsBetween(from: number, to: number): Promise<ResultsEvent[] | null> {
  const hub = hubClient();
  if (!hub) return Promise.resolve(null);
  const key = `${from}:${to}`;
  let state = resultsSlots.get(key);
  if (!state) {
    state = slot<ResultsEvent[]>();
    resultsSlots.set(key, state);
    for (const old of [...resultsSlots.keys()].filter((other) => other !== key).slice(0, -3)) resultsSlots.delete(old);
  }
  return read(state, RESULTS_TTL_MS, "Results calendar", async () => {
    const answer = await hub.resultsCalendar(isoDay(from), isoDay(to));
    return dedupeEvents(
      (answer.events ?? []).flatMap((event) => {
        const date = Number.isFinite(event.day) ? event.day : Date.parse(`${event.date}T00:00:00Z`);
        return Number.isFinite(date) ? [{ symbol: event.symbol, company: event.company, date, purpose: event.purpose }] : [];
      }),
    );
  });
}

/** Results the span's days need: a week before its first day to 60 days after its last. */
export const resultsWindow = (from: number, to: number) => ({ from: from - 7 * DAY_MS, to: to + 60 * DAY_MS });
