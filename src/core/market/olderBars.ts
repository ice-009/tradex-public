// Lazy loading of older bars for daily, weekly and monthly charts (pure).
//
// A chart opens with 5 years; the Market Data Hub has daily history back to
// NSE's first session (3 Nov 1994, market-data-hub#22). When the chart is
// scrolled to its left edge it asks /api/chart for the stretch before its
// oldest bar (`olderRequest`), and the server answers only that stretch, plus
// `hasOlder` when the hub may have more still. Weekly and monthly bars are
// built from daily ones, so the chart's oldest bar may be a part-week (or
// part-month): the request runs up to the second-oldest bar and replaces both.

import { ARCHIVE_START } from "@/core/backtest/phases";
import type { Bar } from "@/core/types";
import { DAY_MS } from "./session";

/** Daily bars are fetched ten years at a time; weekly and monthly ones all the way back at once (they are few). */
export const OLDER_DAILY_YEARS = 10;

/** Slack between the day asked from and the first bar (weekends, holidays, the first bar of a week or month). */
const OLDER_SLACK_MS = 45 * DAY_MS;

/** Do bars starting at the first one suggest the hub has more before `from`? Not before NSE's first session, nor when the series starts well after `from`. */
export function hasOlderBars(candles: ReadonlyArray<{ date: string }>, from: number): boolean {
  if (!candles.length || from <= ARCHIVE_START) return false;
  return Date.parse(candles[0].date) <= from + OLDER_SLACK_MS;
}

/** A valid older-bars request: from < to (epoch ms), `from` no earlier than NSE's first session. Null otherwise. */
export function olderWindow(fromRaw: string | null | undefined, toRaw: string | null | undefined): { from: number; to: number } | null {
  const from = Number(fromRaw);
  const to = Number(toRaw);
  if (!fromRaw || !toRaw || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  const clamped = Math.max(ARCHIVE_START, from);
  return clamped < to ? { from: clamped, to } : null;
}

/** What to ask for before a chart's bars (oldest first), or null when it already starts at NSE's first session. */
export function olderRequest(bars: readonly Bar[], unit: "days" | "weeks" | "months"): { from: number; to: number } | null {
  if (!bars.length) return null;
  // A part-week or part-month first bar is asked for again, whole.
  const to = unit === "days" ? bars[0].time : (bars[1]?.time ?? bars[0].time);
  if (to <= ARCHIVE_START) return null;
  const from = unit === "days" ? Math.max(ARCHIVE_START, to - OLDER_DAILY_YEARS * 365 * DAY_MS) : ARCHIVE_START;
  return { from, to };
}

/** The chart's bars with an older stretch (bars before `to`) put in front. */
export function prependOlder(bars: readonly Bar[], older: readonly Bar[], to: number): Bar[] {
  return [...older.filter((bar) => bar.time < to), ...bars.filter((bar) => bar.time >= to)];
}
