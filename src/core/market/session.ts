// NSE calendar and session helpers (IST). One copy for the engine, backend and frontend.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** Regular session, minutes after IST midnight. */
export const SESSION_OPEN_MIN = 9 * 60 + 15;
export const SESSION_CLOSE_MIN = 15 * 60 + 30;

export interface IstParts {
  /** UTC midnight of the IST calendar date — the "day key" used for daily bars. */
  day: number;
  /** Minutes since IST midnight. */
  minutes: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

export function istParts(time: number = Date.now()): IstParts {
  const ist = new Date(time + IST_OFFSET_MS);
  return {
    day: Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()),
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
    weekday: ist.getUTCDay(),
  };
}

/** Day key (UTC midnight of the IST date) for a timestamp or ISO string. */
export function istDayKey(time: number | string = Date.now()): number {
  return istParts(typeof time === "string" ? Date.parse(time) : time).day;
}

export function isWeekday(dayKey: number): boolean {
  const weekday = new Date(dayKey).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

/** Inside the regular 9:15–15:30 IST session on a weekday (exchange holidays aren't known here). */
export function isMarketOpen(time: number = Date.now()): boolean {
  const { minutes, weekday } = istParts(time);
  return weekday !== 0 && weekday !== 6 && minutes >= SESSION_OPEN_MIN && minutes <= SESSION_CLOSE_MIN;
}

/** Whole days from today's IST date to a day key (negative = in the past). */
export function daysFromToday(dayKey: number, now: number = Date.now()): number {
  return Math.round((dayKey - istParts(now).day) / DAY_MS);
}
