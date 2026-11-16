import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LotsResponse } from "@/contracts/api";
import { dedupeEvents, type ResultsEvent } from "@/core/market/results";
import { DAY_MS, istDayKey } from "@/core/market/session";
import { hubClient } from "@/server/providers/hub";

// Reference data from the Market Data Hub, which keeps NSE's files current:
//
//   lot sizes        GET /v1/lots              (NSE fo_mktlots.csv)       cached 12 h, and on disk
//   F&O ban list     GET /v1/fo/ban            (NSE fo_secban.csv)        cached 30 min
//   results dates    GET /v1/results-calendar  (NSE event calendar)       cached 6 h
//
// Each is best-effort: when the hub can't answer, the last good copy is kept
// (lot sizes survive a restart through .cache/lots.json) and the feature that
// needs it says so; nothing is ever fetched from NSE here.

export type LotSizes = LotsResponse;

const LOTS_TTL_MS = 12 * 60 * 60 * 1000;
const BAN_TTL_MS = 30 * 60 * 1000;
const RESULTS_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const LOTS_FILE = path.join(process.cwd(), ".cache", "lots.json");
const isoDay = (day: number) => new Date(day).toISOString().slice(0, 10);

interface Cached<T> {
  value: T;
  ok: boolean;
  at: number;
  pending: Promise<T> | null;
}

const globalForReference = globalThis as unknown as {
  hubLots?: Cached<LotSizes>;
  hubBan?: Cached<FnoBanState>;
  hubResults?: Cached<ResultsCalendar>;
};

/**
 * A value refreshed in the background when older than `ttl` (or `RETRY_MS` after a
 * failure). The first call waits for the first answer; later calls get the cache.
 */
function cached<T>(state: Cached<T>, ttl: number, load: (previous: T) => Promise<T | null>): Promise<T> {
  if (Date.now() - state.at > (state.ok ? ttl : RETRY_MS) && !state.pending) {
    state.pending = load(state.value)
      .then((value) => {
        if (value !== null) {
          state.value = value;
          state.ok = true;
        }
        return state.value;
      })
      .catch((error: Error) => {
        console.warn("Market Data Hub reference data:", error.message);
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

// ------------------------------------------------------------------ lot sizes

const lotsState = (globalForReference.hubLots ??= { value: { lots: {}, source: "none", fetchedAt: 0 }, ok: false, at: 0, pending: null });

async function lastSavedLots(): Promise<LotSizes | null> {
  try {
    const saved = JSON.parse(await readFile(LOTS_FILE, "utf8")) as LotSizes;
    return Object.keys(saved.lots ?? {}).length ? { ...saved, source: "disk" } : null;
  } catch {
    return null;
  }
}

/** Stock-futures lot sizes (empty, source "none", until the hub or the disk copy has them). */
export function getLotSizes(): Promise<LotSizes> {
  return cached(lotsState, LOTS_TTL_MS, async (previous) => {
    const hub = hubClient();
    try {
      if (!hub) throw new Error("no Market Data Hub configured");
      const answer = await hub.lots();
      if (!Object.keys(answer.lots ?? {}).length) throw new Error("the hub has no lot sizes yet");
      const value: LotSizes = { lots: answer.lots, source: "hub", fetchedAt: answer.fetchedAt || Date.now() };
      await mkdir(path.dirname(LOTS_FILE), { recursive: true });
      await writeFile(LOTS_FILE, JSON.stringify(value));
      return value;
    } catch (error) {
      console.warn("Lot sizes from the Market Data Hub:", (error as Error).message);
      return previous.source === "hub" ? previous : await lastSavedLots();
    }
  });
}

// ------------------------------------------------------------------ F&O ban list

export interface FnoBanState {
  /** False until the hub has answered once. */
  available: boolean;
  /** Trade day the list is for (day key), null when unknown. */
  tradeDate: number | null;
  symbols: string[];
  fetchedAt: number;
}

const banState = (globalForReference.hubBan ??= { value: { available: false, tradeDate: null, symbols: [], fetchedAt: 0 }, ok: false, at: 0, pending: null });

/** Today's F&O ban list. Best-effort: without an answer the screener simply doesn't flag bans (and says so). */
export function getFnoBan(): Promise<FnoBanState> {
  return cached(banState, BAN_TTL_MS, async () => {
    const hub = hubClient();
    if (!hub) return null;
    const answer = await hub.foBan();
    const tradeDate = answer.tradeDate ? Date.parse(`${answer.tradeDate}T00:00:00Z`) : NaN;
    return { available: true, tradeDate: Number.isFinite(tradeDate) ? tradeDate : null, symbols: answer.symbols ?? [], fetchedAt: Date.now() };
  });
}

// ------------------------------------------------------------------ results calendar

export interface ResultsCalendar {
  /** False until the hub has answered once. */
  available: boolean;
  events: ResultsEvent[];
  fetchedAt: number;
}

const resultsState = (globalForReference.hubResults ??= { value: { available: false, events: [], fetchedAt: 0 }, ok: false, at: 0, pending: null });

/** Results dates from a week ago to 60 days ahead, one event per stock and day. */
export function getResultsCalendar(): Promise<ResultsCalendar> {
  return cached(resultsState, RESULTS_TTL_MS, async () => {
    const hub = hubClient();
    if (!hub) return null;
    const today = istDayKey();
    const answer = await hub.resultsCalendar(isoDay(today - 7 * DAY_MS), isoDay(today + 60 * DAY_MS));
    const events = dedupeEvents(
      (answer.events ?? []).flatMap((event) => {
        const date = Number.isFinite(event.day) ? event.day : Date.parse(`${event.date}T00:00:00Z`);
        return Number.isFinite(date) ? [{ symbol: event.symbol, company: event.company, date, purpose: event.purpose }] : [];
      }),
    );
    return { available: true, events, fetchedAt: answer.fetchedAt || Date.now() };
  });
}
