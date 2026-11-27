import { DAY_MS, IST_OFFSET_MS, SESSION_OPEN_MIN, istParts } from "@/core/market/session";
import type { SealKind } from "./seal";

// When the server seals the day's plan (issue #33). Pure: the job in
// src/server/services/planLedger.ts asks every minute which seals are due.
//
//   close   3:15–3:25 PM IST on a trading day: the plan is final at 3:10 PM
//           (src/core/plan/preview.ts) and the buy window is 3:15–3:25 PM, so
//           this is the plan as it stood when the first entry could be taken.
//           A server that is down for the whole window makes no close seal
//           that day: a seal written later wouldn't be "before the trade".
//   final   from 7:30 PM IST, once the day's final daily bars are stored (NSE's
//           evening files, through the hub), until the next session opens:
//           the plan of record before the next open, on final prices.
//
// Holidays come from the hub's trading calendar; without it, weekends are the
// only days off (the caller says so).

export const SEAL_WINDOWS = {
  close: { from: 15 * 60 + 15, to: 15 * 60 + 25 },
  final: { from: 19 * 60 + 30 },
} as const;

/** How far to look for the next / previous trading day. */
const MAX_GAP_DAYS = 15;

/** A trading day by the calendar (day keys, ascending), or a weekday when there is none. */
export function isTradingDay(day: number, calendar: ReadonlySet<number> | null): boolean {
  if (calendar) return calendar.has(day);
  const weekday = new Date(day).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

function stepTradingDay(day: number, calendar: ReadonlySet<number> | null, step: 1 | -1): number | null {
  for (let i = 1; i <= MAX_GAP_DAYS; i += 1) {
    const next = day + step * i * DAY_MS;
    if (isTradingDay(next, calendar)) return next;
  }
  return null;
}

/** Epoch ms of IST minute `minutes` on a day key. */
export const istTime = (day: number, minutes: number) => day + minutes * 60_000 - IST_OFFSET_MS;

export interface DueSeal {
  day: number;
  kind: SealKind;
}

/**
 * The seals due at `now`: today's close seal inside its window, and the final
 * seal of the newest trading day whose evening has come, until the next open.
 * `sealed(day, kind)` says which already exist (the job is idempotent).
 */
export function dueSeals(now: number, calendar: ReadonlySet<number> | null, sealed: (day: number, kind: SealKind) => boolean): DueSeal[] {
  const { day, minutes } = istParts(now);
  const due: DueSeal[] = [];
  const today = isTradingDay(day, calendar);
  if (today && minutes >= SEAL_WINDOWS.close.from && minutes < SEAL_WINDOWS.close.to && !sealed(day, "close")) due.push({ day, kind: "close" });
  const last = today && minutes >= SEAL_WINDOWS.final.from ? day : stepTradingDay(day, calendar, -1);
  if (last !== null) {
    const next = stepTradingDay(last, calendar, 1);
    const deadline = next === null ? Infinity : istTime(next, SESSION_OPEN_MIN);
    if (now >= istTime(last, SEAL_WINDOWS.final.from) && now < deadline && !sealed(last, "final")) due.push({ day: last, kind: "final" });
  }
  return due;
}

/** When the next close seal is made (epoch ms), from `now`; null when no trading day is found ahead. */
export function nextCloseSeal(now: number, calendar: ReadonlySet<number> | null): number | null {
  const { day, minutes } = istParts(now);
  if (isTradingDay(day, calendar) && minutes < SEAL_WINDOWS.close.from) return istTime(day, SEAL_WINDOWS.close.from);
  const next = stepTradingDay(day, calendar, 1);
  return next === null ? null : istTime(next, SEAL_WINDOWS.close.from);
}
