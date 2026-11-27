import "server-only";

import type { AsOfInfo, LotsResponse, Quote, QuotesResponse, ResultsResponse, TimeMachineResponse } from "@/contracts/api";
import { ARCHIVE_START, storeStart } from "@/core/backtest/phases";
import { DAY_MS, istParts } from "@/core/market/session";
import { barsThrough, dayLabel, isoDay, parseAsOfParam, resolveDay } from "@/core/reference/timeMachine";
import type { Known } from "@/core/reference/pointInTime";
import type { DailyBar } from "@/core/types";
import { asOf, priceScales, tradingDays } from "@/server/providers/asOf";
import { screenerStore } from "@/server/providers/dailyStore";
import { LongBars, longWarnings, type LongBarSet } from "@/server/providers/longBars";
import { longBatch } from "@/server/providers/longStore";
import { RequestError } from "@/server/http";
import { log } from "@/server/log";

// The Time Machine (issue #31): the terminal as it was at a past day's close.
// The browser sends `asOf=YYYY-MM-DD` with every data request; this module
// turns it into a session (snapped to the last trading day on or before it,
// from the hub's calendar) and supplies what the screener, the plan's
// evidence, charts, quotes, lots and results read for that day:
//
//   - Daily bars up to the day's close, never later (`barsThrough`): from the
//     screener's store when it covers the look-back, else read from the hub's
//     long history for that day (`pastBars`, kept in memory for a few days).
//   - Prices adjusted only for the splits and bonuses that had happened by
//     then (asOf's price scale), so RELIANCE before its 2017 bonus shows the
//     price it traded at.
//   - Reference data — the F&O list, lots, ban list, results, sector map — only
//     through asOf(day), so it is what was known that day; what wasn't known
//     is said, never filled in with today's value without saying so.
//
// Nothing here reads a live quote, the stream or today's reference data.

/** Calendar days of daily bars the screener reads before a past day: features (260 sessions) + the track record's 160 sessions. */
export const PAST_SCREEN_DAYS = 640;
/** Past days whose bars are kept in memory (each a few tens of MB for the F&O list). */
const MAX_SETS = 6;

/** A past session the terminal is shown as of. */
export interface PastDay {
  day: number;
  requested: number;
  snapped: boolean;
  note: string | null;
}

/**
 * The session `raw` (YYYY-MM-DD) means, or null for the live terminal (no
 * parameter, today or later). A malformed date or one before 1994 is a 400.
 */
export async function pastDay(raw: string | null | undefined): Promise<PastDay | null> {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const parsed = parseAsOfParam(raw);
  if (!parsed.ok) throw new RequestError(parsed.error);
  const today = istParts().day;
  if (parsed.day >= today) return null;
  const resolved = resolveDay(parsed.day, today, await tradingDays().catch(() => null));
  return resolved.mode === "live" ? null : { day: resolved.day, requested: resolved.requested, snapped: resolved.snapped, note: resolved.note };
}

const factText = <T>(fact: Known<T>, text: (value: T) => string) => (fact.known ? { known: true, text: `${text(fact.value)} (${fact.source}, ${dayLabel(fact.asOf)})` } : { known: false, text: fact.reason });

/** GET /api/time-machine: the session shown and what was known about it. */
export async function timeMachineInfo(raw: string | null): Promise<TimeMachineResponse> {
  const past = await pastDay(raw);
  if (!past) return { status: "live" };
  const known = await asOf(past.day);
  return {
    status: "past",
    day: past.day,
    date: isoDay(past.day),
    label: dayLabel(past.day),
    requested: isoDay(past.requested),
    snapped: past.snapped,
    note: past.note,
    facts: [
      { name: "F&O list", ...factText(known.foList, (list) => `${list.size} stocks with futures`) },
      { name: "Lot sizes", ...factText(known.lots, (lots) => `${Object.keys(lots).length} lots, as traded that day`) },
      { name: "F&O ban list", ...factText(known.ban, (list) => (list.length ? list.join(", ") : "nobody banned")) },
      { name: "Results", ...factText(known.results.reported, (events) => `${events.length} results in the week up to that day`) },
      { name: "Sector map", ...factText(known.sectors, (catalog) => `${catalog.indices.length} sector indices with history by then`) },
    ],
  };
}

// ------------------------------------------------------------------ daily bars as of a day

interface PastSetState {
  done: number;
  total: number;
  value: PastBars | null;
  error: string | null;
  promise: Promise<PastBars>;
}

/** Daily bars (adjusted to today, as the hub serves them) up to a past day's close. */
export interface PastBars {
  day: number;
  from: number;
  /** Where they came from: the screener's store, or the hub's long history read for this day. */
  source: "store" | "hub";
  bars: Map<string, DailyBar[]>;
  /** What the hub said about the read (renames joined, ranges incomplete), for the answer's notes. */
  notes: string[];
  missing: string[];
}

const globalForPast = globalThis as unknown as { timeMachineSets?: Map<string, PastSetState> };
const sets = (globalForPast.timeMachineSets ??= new Map());

const clip = (bars: readonly DailyBar[], day: number) => barsThrough(bars, day, (bar) => bar.t);

/** The screener's store holds every symbol's bars from `from`: the 5 years it keeps reach back that far. */
export const storeCovers = (from: number) => from >= storeStart(istParts().day);

/**
 * Bars up to `day` from the screener's store (it must cover the look-back:
 * `storeCovers`). Read on every ask — it is in memory — so a store still
 * syncing fills in as it goes.
 */
export async function storeBarsThrough(day: number, symbols: readonly string[]): Promise<PastBars> {
  const list = [...new Set(symbols)];
  screenerStore.ensureFresh(list);
  await screenerStore.hasData(list);
  const bars = new Map<string, DailyBar[]>();
  for (const symbol of list) {
    const through = clip(screenerStore.getBars(symbol), day);
    if (through.length) bars.set(symbol, through);
  }
  return { day, from: storeStart(istParts().day), source: "store", bars, notes: [], missing: list.filter((symbol) => !bars.has(symbol)) };
}

async function readPast(day: number, symbols: string[], from: number, progress: { done: number; total: number }): Promise<PastBars> {
  const started = Date.now();
  const reader = new LongBars({ batch: longBatch, progress: (done, total) => Object.assign(progress, { done, total }) });
  const set: LongBarSet = await reader.load(symbols, from, day);
  const bars = new Map<string, DailyBar[]>();
  for (const [symbol, list] of set.bars) {
    const through = clip(list, day);
    if (through.length) bars.set(symbol, through);
  }
  log.info("Time Machine bars read", { day: isoDay(day), from: isoDay(from), symbols: symbols.length, ms: Date.now() - started });
  return { day, from, source: "hub", bars, notes: longWarnings({ from, to: day, set, standInUntil: null }, bars.size).slice(1), missing: set.missing };
}

/**
 * Daily bars of `symbols` from `from` to `day`'s close (none after it), read
 * from the hub's long history, started in the background on first ask and
 * kept for a few days. `ready` is null while they are being read (poll `progress`).
 */
export function pastBars(day: number, symbols: readonly string[], from: number): { ready: PastBars | null; error: string | null; progress: { done: number; total: number }; promise: Promise<PastBars> } {
  const wanted = [...new Set(symbols)].sort();
  const start = Math.max(ARCHIVE_START, from);
  const key = `${day}:${start}:${wanted.join(",")}`;
  let state = sets.get(key);
  if (!state) {
    const fresh: PastSetState = { done: 0, total: wanted.length, value: null, error: null, promise: Promise.resolve(null as never) };
    fresh.promise = readPast(day, wanted, start, fresh).then(
      (value) => {
        fresh.value = value;
        return value;
      },
      (error: Error) => {
        fresh.error = error.message;
        // A failed read is tried again on the next ask.
        if (sets.get(key) === fresh) sets.delete(key);
        throw error;
      },
    );
    fresh.promise.catch(() => undefined);
    state = fresh;
    sets.set(key, fresh);
    while (sets.size > MAX_SETS) sets.delete(sets.keys().next().value!);
  } else {
    // Most recently used last.
    sets.delete(key);
    sets.set(key, state);
  }
  return { ready: state.value, error: state.error, progress: { done: state.done, total: state.total }, promise: state.promise };
}

/**
 * One symbol's daily candles from `from` to a past day's close, read from the hub for that
 * request (not kept: a chart asks once per symbol and range), in the chart's candle shape.
 */
export async function dailyCandlesThrough(day: number, symbol: string, from: number): Promise<Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>> {
  const set = await new LongBars({ batch: longBatch }).load([symbol], Math.max(ARCHIVE_START, from), day);
  return clip(set.bars.get(symbol) ?? [], day).map((bar) => ({ date: new Date(bar.t).toISOString(), open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v }));
}

/** Bars re-expressed as adjusted on their last day (`scale` = asOf's price scale): prices × scale, volumes ÷ it. */
export function scaleBars(bars: readonly DailyBar[], scale: number): DailyBar[] {
  if (scale === 1) return bars as DailyBar[];
  return bars.map((bar) => ({ ...bar, o: bar.o * scale, h: bar.h * scale, l: bar.l * scale, c: bar.c * scale, v: bar.v / scale }));
}

/** Price scales for `symbols` on `day`, with a note naming stocks whose factors couldn't be loaded (their prices stay adjusted to today). */
export async function scalesOn(day: number, symbols: readonly string[], indices: ReadonlySet<string> = new Set()): Promise<{ scaleOf: (symbol: string) => number; note: string | null }> {
  const stocks = symbols.filter((symbol) => !indices.has(symbol));
  const scales = await priceScales(day, stocks);
  const unknown = stocks.filter((symbol) => !scales.get(symbol)?.known);
  const note = !unknown.length
    ? null
    : unknown.length === stocks.length
      ? "Split/bonus factors couldn't be loaded from the Market Data Hub: prices are adjusted for every split and bonus up to today, not only those by then."
      : `Split/bonus factors couldn't be loaded for ${unknown.length} stock${unknown.length === 1 ? "" : "s"} (${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? "…" : ""}): their prices are adjusted to today.`;
  return {
    scaleOf: (symbol) => {
      const fact = scales.get(symbol);
      return fact?.known ? fact.value : 1;
    },
    note,
  };
}

// ------------------------------------------------------------------ quotes, lots, results as of a day

/** A past day's closes for the watchlist: the last bar on or before the day, with its change on the bar before. */
export async function quotesAsOf(symbols: string[], day: number): Promise<QuotesResponse> {
  if (!symbols.length) return { quotes: [], asOf: { day, notes: [] } };
  // Two weeks back is plenty for the bar before (holidays); a stock that didn't trade then has no quote.
  // From the hub (one small read), so watchlist symbols don't join the screener's store.
  const set = await pastBars(day, symbols, day - 14 * DAY_MS).promise;
  const { scaleOf, note } = await scalesOn(day, symbols);
  const quotes: Quote[] = [];
  for (const symbol of symbols) {
    const bars = set.bars.get(symbol);
    const last = bars?.at(-1);
    if (!last) continue;
    const scale = scaleOf(symbol);
    const prev = bars!.at(-2);
    const ltp = last.c * scale;
    const prevClose = prev ? prev.c * scale : ltp;
    quotes.push({ symbol, ltp, ch: ltp - prevClose, chp: prevClose ? ((ltp - prevClose) / prevClose) * 100 : 0, open: last.o * scale, high: last.h * scale, low: last.l * scale, prevClose, volume: last.v / scale, source: "hub", delayed: true, asOf: last.t });
  }
  return { quotes, asOf: { day, notes: note ? [note] : [] } };
}

/** The stand-in position when a day's lot isn't known: about ₹5 lakh of stock, as the plan's evidence assumes. */
const STAND_IN_NOTIONAL = 500_000;

/**
 * Lot sizes as traded on a past day (that day's shares, like the Time
 * Machine's prices). Before NSE's files carried them (8 Jul 2024) they aren't
 * known: a lot of about ₹5 lakh at that day's close stands in for each stock on
 * that day's F&O list (the evidence's assumption), and the answer says so —
 * nothing from after the day, today's lots included, is used.
 */
export async function lotsAsOf(day: number): Promise<LotsResponse> {
  const known = await asOf(day);
  if (known.lots.known) return { lots: { ...known.lots.value }, source: "as-of", fetchedAt: Date.now(), asOf: { day, notes: [`Lot sizes as traded on ${dayLabel(known.lots.asOf)} (${known.lots.source}).`] } };
  const list = known.universe("fno");
  if (!list.known) return { lots: {}, source: "as-of", fetchedAt: Date.now(), asOf: { day, notes: [known.lots.reason, list.reason] } };
  const { quotes } = await quotesAsOf(list.value.map((member) => member.symbol), day);
  const lots: Record<string, number> = {};
  for (const quote of quotes) if (quote.ltp > 0) lots[quote.symbol] = Math.max(1, Math.round(STAND_IN_NOTIONAL / quote.ltp));
  return {
    lots,
    source: "as-of",
    fetchedAt: Date.now(),
    asOf: { day, notes: [`${known.lots.reason} Each stands in as about ₹5 lakh of stock at that day's close: position sizes are indicative.`] },
  };
}

/** Results dated in the week up to a past day (certain by then); later dates aren't shown, since when each was announced isn't stored. */
export async function resultsAsOf(day: number): Promise<ResultsResponse> {
  const known = await asOf(day);
  const reported = known.results.reported;
  const notes = [known.results.upcoming.known ? "" : "Upcoming results aren't shown: the Market Data Hub doesn't store when each date was announced."].filter(Boolean);
  if (!reported.known) return { available: false, fetchedAt: Date.now(), events: [], asOf: { day, notes: [reported.reason, ...notes] } };
  return { available: true, fetchedAt: Date.now(), events: reported.value, asOf: { day, notes } };
}

/** The notes every Time Machine answer can share: snapping to a session. */
export const dayNotes = (past: PastDay): AsOfInfo => ({ day: past.day, notes: past.note ? [past.note] : [] });
