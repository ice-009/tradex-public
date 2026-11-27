import { MONTHS } from "@/core/format";
import { ARCHIVE_START } from "@/core/backtest/phases";
import { DAY_MS, IST_OFFSET_MS, SESSION_CLOSE_MIN, isWeekday } from "@/core/market/session";

// The Time Machine (issue #31): the whole terminal as it was at one past day's
// close. Pure rules shared by the server (which enforces them) and the browser
// (which only asks): which day a request means, and where "after that day"
// starts for daily and intraday bars.
//
//   ?asOf=2020-03-23   the terminal as of 23 Mar 2020's close
//
// A day that wasn't a session (a weekend, an exchange holiday) means the last
// session before it, from the Market Data Hub's trading calendar (/v1/calendar)
// — or, when the hub can't say, the last weekday, and the answer says holidays
// weren't checked. Today or later is the live terminal, not the Time Machine.

/** A parsed `asOf` parameter. */
export type AsOfParam = { ok: true; day: number } | { ok: false; error: string };

/** "23 Mar 2020". */
export function dayLabel(day: number): string {
  const date = new Date(day);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "2020-03-23" (the URL form). */
export const isoDay = (day: number) => new Date(day).toISOString().slice(0, 10);

/** `YYYY-MM-DD` → day key (UTC midnight of that IST date). Rejects malformed dates and days before NSE's first session. */
export function parseAsOfParam(raw: string): AsOfParam {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return { ok: false, error: `"${raw}" isn't a date: use YYYY-MM-DD, e.g. 2020-03-23.` };
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const day = Date.UTC(year, month - 1, date);
  if (new Date(day).getUTCMonth() !== month - 1 || new Date(day).getUTCDate() !== date) return { ok: false, error: `${raw} isn't a calendar date.` };
  if (day < ARCHIVE_START) return { ok: false, error: `The Time Machine goes back to NSE's first session, ${dayLabel(ARCHIVE_START)}.` };
  return { ok: true, day };
}

/** Last element of ascending `days` that is ≤ `day`, or null. */
export function sessionOnOrBefore(day: number, tradingDays: readonly number[]): number | null {
  let lo = 0;
  let hi = tradingDays.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tradingDays[mid] <= day) {
      found = tradingDays[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The weekday on or before `day` (holidays unknown). */
export function weekdayOnOrBefore(day: number): number {
  let out = day;
  while (!isWeekday(out)) out -= DAY_MS;
  return out;
}

/** Which day the terminal shows. */
export type TimeMachineDay =
  | { mode: "live" }
  | {
      mode: "past";
      /** The session shown (day key). */
      day: number;
      /** The day asked for. */
      requested: number;
      /** The day asked for wasn't a session: `day` is the last one before it. */
      snapped: boolean;
      /** Whether exchange holidays were checked (the hub's calendar answered). */
      calendar: boolean;
      /** What to tell the user about the day chosen (snapping, holidays unchecked); null when nothing. */
      note: string | null;
    };

/**
 * The session a requested day means. `today` is today's IST day key;
 * `tradingDays` the hub's sessions (ascending) around the day, or null when
 * the hub couldn't say (then weekends are skipped and the note says holidays
 * weren't checked).
 */
export function resolveDay(requested: number, today: number, tradingDays: readonly number[] | null): TimeMachineDay {
  if (requested >= today) return { mode: "live" };
  const day = tradingDays ? sessionOnOrBefore(requested, tradingDays) : weekdayOnOrBefore(requested);
  if (day === null) return { mode: "past", day: requested, requested, snapped: false, calendar: true, note: `No session on or before ${dayLabel(requested)} in the exchange calendar.` };
  const snapped = day !== requested;
  const why = !snapped ? "" : !isWeekday(requested) ? `${dayLabel(requested)} was a ${new Date(requested).getUTCDay() === 0 ? "Sunday" : "Saturday"}` : `${dayLabel(requested)} was an exchange holiday`;
  const note = [snapped ? `${why}: showing ${dayLabel(day)}, the last session before it.` : "", tradingDays ? "" : "The exchange calendar couldn't be read from the Market Data Hub: weekends are skipped, holidays aren't checked."].filter(Boolean).join(" ");
  return { mode: "past", day, requested, snapped, calendar: Boolean(tradingDays), note: note || null };
}

/** The instant a day's session closed (15:30 IST), epoch ms: a bar starting before it is that day's or earlier. */
export const sessionCloseMs = (day: number) => day - IST_OFFSET_MS + SESSION_CLOSE_MIN * 60_000;

/**
 * Bars known by `day`'s close: daily bars (keyed by their day) up to and
 * including it, intraday bars that started before 15:30 IST that day.
 */
export function barsThrough<B>(bars: readonly B[], day: number, time: (bar: B) => number): B[] {
  const end = sessionCloseMs(day);
  return bars.filter((bar) => time(bar) < end);
}

/** First day of the plan's evidence window for a past day: the same five years the live plan uses, ending that day. */
export const evidenceWindowStart = (day: number, storeDays: number) => Math.max(ARCHIVE_START, day - storeDays * DAY_MS);
