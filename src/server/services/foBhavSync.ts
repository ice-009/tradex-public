import "server-only";

import type { FoBhavStatus } from "@/contracts/api";
import { oiFact, type OiFact } from "@/core/market/openInterest";
import { DAY_MS, istParts } from "@/core/market/session";
import { foDaysToCheck } from "@/core/parsers/foBhavcopy";
import { FoFetchError, fetchFoDay } from "@/server/providers/foBhavcopy";
import { checkedFoDays, foCoverage, latestFoDay, markFoDay, writeFoDay } from "@/server/providers/foBhavStore";

// Importing NSE's F&O bhavcopy into the market database:
//
//  - Backfill ("F&O bhavcopy (NSE, free)" in the Market data dialog): every
//    weekday of the last year not checked yet, newest first. Resumable — a
//    checked day (stored, holiday or wrong-date file) is never asked for again,
//    so it can be stopped and started. ~260 files at ≤ 1 request a second is
//    about five minutes.
//  - Evening update: every screener run calls `ensureFoRecent()`; at most every
//    30 minutes it fetches whatever of the last ten days is missing (normally
//    just today's file, after 18:00 IST). The screener's cash bhavcopy is kept
//    up to date the same way.
//
// All of it comes from NSE's free public archive: no broker API calls, no
// budget. After three days in a row fail hard (403/429/timeouts after
// retries) the run stops instead of hammering NSE.

export const FO_LOOKBACK_DAYS = 366;
const RECENT_DAYS = 10;
const RECENT_EVERY_MS = 30 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;

type Job = FoBhavStatus["job"] & { stop: boolean };
const globalForFo = globalThis as unknown as { foBhavJob?: Job; foBhavRecent?: { at: number; pending: Promise<void> | null } };
const job: Job = (globalForFo.foBhavJob ??= { state: "idle", done: 0, total: 0, failed: 0, current: null, message: "", startedAt: null, finishedAt: null, stop: false });
const recent = (globalForFo.foBhavRecent ??= { at: 0, pending: null });

const isoDay = (day: number) => new Date(day).toISOString().slice(0, 10);

function windowStart(now: number) {
  return istParts(now).day - FO_LOOKBACK_DAYS * DAY_MS;
}

/** Weekdays in the window NSE could have published by now. */
function expectedDays(now: number): number {
  const { day: today, minutes } = istParts(now);
  return foDaysToCheck({ today, minutes, from: windowStart(now), checked: new Map() }).length;
}

export function foBhavStatus(now = Date.now()): FoBhavStatus {
  const from = windowStart(now);
  const coverage = foCoverage(from);
  const { stop: _stop, ...state } = job;
  void _stop;
  return {
    job: state,
    coverage: { lookbackDays: FO_LOOKBACK_DAYS, expected: expectedDays(now), checked: coverage.checked, days: coverage.days, first: coverage.first, last: coverage.last, rows: coverage.rows },
  };
}

type Outcome = "ok" | "holiday" | "mismatch";

/** Download, check and store one day. Throws FoFetchError when NSE won't serve it. */
async function importDay(day: number, shouldStop: () => boolean): Promise<Outcome> {
  const result = await fetchFoDay(day, shouldStop);
  const { day: today } = istParts();
  if (result.kind === "ok") {
    writeFoDay(day, result.records, Date.now());
    if (result.badRows) console.warn(`F&O bhavcopy ${isoDay(day)}: ${result.badRows} stock-futures rows couldn't be read`);
    return "ok";
  }
  if (result.kind === "missing") {
    // Today's file may just not be out yet; any earlier weekday without a file is a holiday.
    if (day < today) markFoDay(day, "holiday", Date.now());
    return "holiday";
  }
  console.warn(`F&O bhavcopy ${isoDay(day)}: ${result.note}; treated as a holiday`);
  if (day < today) markFoDay(day, "mismatch", Date.now(), result.note);
  return "mismatch";
}

/**
 * Import `days` one by one (the provider spaces requests ≥ 1.1 s apart).
 * Returns why it stopped early, or null when it got through them all.
 */
async function importDays(days: number[], onDay: (day: number, outcome: Outcome | "failed") => void, shouldStop: () => boolean): Promise<string | null> {
  let consecutive = 0;
  for (const day of days) {
    if (shouldStop()) return "stopped";
    try {
      onDay(day, await importDay(day, shouldStop));
      consecutive = 0;
    } catch (error) {
      const message = error instanceof FoFetchError ? error.message : (error as Error).message;
      console.warn(`F&O bhavcopy ${isoDay(day)} failed:`, message);
      onDay(day, "failed");
      consecutive += 1;
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) return `NSE refused ${consecutive} days in a row (${message}). Stopped so as not to hammer it — try again later; it continues where it stopped.`;
    }
  }
  return null;
}

export function startFoBackfill(): void {
  if (job.state === "running") return;
  const now = Date.now();
  const { day: today, minutes } = istParts(now);
  const days = foDaysToCheck({ today, minutes, from: windowStart(now), checked: checkedFoDays(windowStart(now)) });
  Object.assign(job, {
    state: "running",
    done: 0,
    total: days.length,
    failed: 0,
    current: null,
    stop: false,
    startedAt: now,
    finishedAt: null,
    message: days.length ? `Downloading ${days.length} daily file${days.length === 1 ? "" : "s"} from NSE (≈${Math.ceil((days.length * 1.2) / 60)} min, no broker calls)…` : "Every day of the last year is already stored.",
  });
  if (!days.length) {
    Object.assign(job, { state: "done", finishedAt: now });
    return;
  }
  void (async () => {
    let stored = 0;
    const why = await importDays(
      days,
      (day, outcome) => {
        job.done += 1;
        if (outcome === "failed") job.failed += 1;
        if (outcome === "ok") stored += 1;
        job.current = isoDay(day);
      },
      () => job.stop,
    );
    const finishedAt = Date.now();
    if (why === "stopped") Object.assign(job, { state: "paused", current: null, finishedAt, message: "Stopped. Start again to continue where it left off." });
    else if (why) Object.assign(job, { state: "paused", current: null, finishedAt, message: why });
    else
      Object.assign(job, {
        state: "done",
        current: null,
        finishedAt,
        message: `Done — ${stored} trading day${stored === 1 ? "" : "s"} stored${job.failed ? `, ${job.failed} day${job.failed === 1 ? "" : "s"} failed (start again to retry)` : ""}.`,
      });
  })().catch((error) => Object.assign(job, { state: "error", current: null, message: (error as Error).message, finishedAt: Date.now() }));
}

export function stopFoBackfill() {
  if (job.state === "running") job.stop = true;
}

/**
 * The evening update: fetch the newest file(s) when they're due. Cheap to call
 * often (the screener calls it on every run) — it checks at most every 30
 * minutes and never while the backfill runs. Returns immediately.
 */
export function ensureFoRecent(now = Date.now()): void {
  if (job.state === "running" || recent.pending || now - recent.at < RECENT_EVERY_MS) return;
  const { day: today, minutes } = istParts(now);
  const from = today - RECENT_DAYS * DAY_MS;
  const days = foDaysToCheck({ today, minutes, from, checked: checkedFoDays(from), recheck: ["mismatch"] });
  recent.at = now;
  if (!days.length) return;
  recent.pending = importDays(days, () => undefined, () => job.state === "running")
    .then((why) => {
      if (why && why !== "stopped") console.warn("F&O bhavcopy update:", why);
    })
    .catch((error) => console.error("F&O bhavcopy update failed", error))
    .finally(() => {
      recent.pending = null;
    });
}

/** Wait for an update started by ensureFoRecent (tests and scripts). */
export const foRecentSettled = () => recent.pending ?? Promise.resolve();

const facts = ((globalThis as unknown as { foOiFacts?: { key: string; value: { day: number; bySymbol: Map<string, OiFact> } | null } }).foOiFacts ??= { key: "", value: null });

/**
 * OI facts for every underlying on the newest stored F&O day (for the screener).
 * Null when nothing is stored, or when the newest day is more than a week old.
 */
export function latestOiFacts(now = Date.now()): { day: number; bySymbol: Map<string, OiFact> } | null {
  const { last, rows } = foCoverage(istParts(now).day - 14 * DAY_MS);
  if (last === null || istParts(now).day - last > 7 * DAY_MS) return null;
  const key = `${last}:${rows}`;
  if (facts.key !== key) {
    const latest = latestFoDay();
    facts.value = latest ? { day: latest.day, bySymbol: new Map(latest.records.map((record) => [record.symbol, oiFact(record)])) } : null;
    facts.key = key;
  }
  return facts.value;
}
