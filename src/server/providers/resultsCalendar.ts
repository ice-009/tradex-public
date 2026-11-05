import "server-only";

import { dedupeEvents, parseCalendar, type ResultsEvent } from "@/core/parsers/resultsCalendar";

export { dedupeEvents, parseCalendar, type ResultsEvent };

// Upcoming / recent results dates from NSE's event calendar
// (https://www.nseindia.com/api/event-calendar — undocumented; used by
// open-source NSE wrappers such as nsepython). NSE serves its JSON APIs only
// to a browser-like session, so we load the home page first for cookies.
// Everything here is best-effort: any failure means "no calendar", never an
// error, and the rest of the terminal works without it.

const HOME = "https://www.nseindia.com/";
const CALENDAR = "https://www.nseindia.com/api/event-calendar";
const TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_TTL_MS = 30 * 60 * 1000;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-IN,en;q=0.9",
  Referer: "https://www.nseindia.com/companies-listing/corporate-filings-event-calendar",
};
async function download(): Promise<ResultsEvent[]> {
  const home = await fetch(HOME, { headers: { ...HEADERS, Accept: "text/html" }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  const cookies = (home.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(";")[0])
    .filter(Boolean)
    .join("; ");
  const response = await fetch(CALENDAR, {
    headers: { ...HEADERS, ...(cookies ? { Cookie: cookies } : {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`NSE event calendar ${response.status}`);
  return parseCalendar(await response.json());
}

const globalForResults = globalThis as unknown as {
  resultsCalendar?: { at: number; ok: boolean; events: ResultsEvent[]; pending: Promise<void> | null };
};
const state = (globalForResults.resultsCalendar ??= { at: 0, ok: false, events: [], pending: null });

/** Cached calendar; refreshes in the background when stale. `available` is false until NSE has answered once. */
export async function getResultsCalendar(): Promise<{ available: boolean; events: ResultsEvent[]; fetchedAt: number }> {
  const stale = Date.now() - state.at > (state.ok ? TTL_MS : FAIL_TTL_MS);
  if (stale && !state.pending) {
    state.pending = download()
      .then((events) => {
        state.events = events;
        state.ok = true;
      })
      .catch((error: Error) => {
        console.warn("NSE results calendar unavailable:", error.message);
      })
      .finally(() => {
        state.at = Date.now();
        state.pending = null;
      });
  }
  // First call waits (briefly) for the download; later calls return the cache immediately.
  if (!state.at && state.pending) await state.pending;
  return { available: state.ok, events: state.events, fetchedAt: state.at };
}
