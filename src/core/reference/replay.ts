import { DAY_MS } from "@/core/market/session";
import { sessionCloseMs, sessionOnOrBefore } from "./timeMachine";

// Replay in the Time Machine (issue #32): stepping the terminal's past day a
// session at a time, playing it forward, and revealing a chart's bars one at a
// time. Pure rules shared by the server and the browser.
//
// Replay blocks. A replay asks for day after day, so the server reads each
// dataset once for a block of days around the first one asked — from a few
// weeks before it to about three months after (`REPLAY_BACK_DAYS`,
// `REPLAY_AHEAD_DAYS`) — and cuts it at each day: a past day's answer is
// computed from data up to that day's close only, as without a replay, and a
// test proves the cut answer equals the from-scratch one. Only requests marked
// as a replay may read ahead like this; a Time Machine day opened on its own
// still reads nothing after it.
//
// A block never straddles the start of the broker's ~5-year window at the
// Market Data Hub: the hub lines its NSE archive up with the broker's prices
// only when a read reaches into that window, so a block that reached into it
// from a day before it would read that day's history at other price levels
// than the day's own read.

/** Calendar days a replay block reaches back before the first day asked (stepping back). */
export const REPLAY_BACK_DAYS = 21;
/** Calendar days it reaches forward (about three months of sessions). */
export const REPLAY_AHEAD_DAYS = 92;

/** Days a block serves (day keys, inclusive). */
export interface ReplayBlock {
  from: number;
  to: number;
}

/**
 * The block for a replay that reaches `day`: a few weeks before it to about
 * three months after, never past `lastDay` (the newest past session) nor across
 * `brokerFrom` (the first day of the hub's broker window) from a day before it.
 */
export function replayBlockFor(day: number, lastDay: number, brokerFrom: number): ReplayBlock {
  let to = Math.max(day, Math.min(lastDay, day + REPLAY_AHEAD_DAYS * DAY_MS));
  let from = day - REPLAY_BACK_DAYS * DAY_MS;
  if (day < brokerFrom) to = Math.max(day, Math.min(to, brokerFrom - DAY_MS));
  else from = Math.max(from, brokerFrom);
  return { from, to };
}

/** The first block of `blocks` that serves `day`, or null. */
export function blockServing<B extends ReplayBlock>(blocks: Iterable<B>, day: number): B | null {
  for (const block of blocks) if (block.from <= day && day <= block.to) return block;
  return null;
}

/** For a read that asked `from` for `day`: the same look-back from the block's first day, so every day of the block shares one read. */
export const blockReadFrom = (block: ReplayBlock, day: number, from: number) => from - (day - block.from);

// ------------------------------------------------------------------ stepping

/** `steps` sessions after (positive) or before (negative) `day` in an ascending calendar; null past either end. */
export function stepSession(day: number, sessions: readonly number[], steps: number): number | null {
  if (!sessions.length || steps === 0) return day;
  const at = sessionOnOrBefore(day, sessions);
  let index = at === null ? -1 : sessions.indexOf(at);
  // A day that isn't a session sits between two: one step back is the session before it.
  if (at !== day && steps < 0) index += 1;
  const next = index + steps;
  return next >= 0 && next < sessions.length ? sessions[next] : null;
}

/** Sessions per second a replay can play at. */
export const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const;

/** Milliseconds between steps at a speed (sessions per second). */
export const stepIntervalMs = (speed: number) => Math.round(1000 / Math.max(0.1, speed));

// ------------------------------------------------------------------ revealing a chart's bars

/**
 * Where a chart's bars stop being shown: the close of the day shown, or, while
 * a bar-by-bar replay is inside the next session, just after its last revealed
 * bar. Bars start at their time; a bar is shown when it starts before the limit.
 */
export const revealLimit = (day: number, cursor: number | null) => cursor ?? sessionCloseMs(day);

/** The bars a replay shows: those that started before the limit (indicators get only these). */
export function revealed<B>(bars: readonly B[], limit: number, time: (bar: B) => number): B[] {
  // Bars are in time order: cut at the first one at or after the limit.
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (time(bars[mid]) < limit) lo = mid + 1;
    else hi = mid;
  }
  return bars.slice(0, lo);
}

/**
 * One bar further: the limit that reveals the next unrevealed bar (null when
 * every loaded bar is shown).
 */
export function nextBarLimit(times: readonly number[], limit: number): number | null {
  for (const time of times) if (time >= limit) return time + 1;
  return null;
}

/** One bar back: the limit that hides the last revealed bar after `floor` (null: back to `floor`, the day's close). */
export function previousBarLimit(times: readonly number[], limit: number, floor: number): number | null {
  const after = times.filter((time) => time >= floor && time < limit);
  return after.length > 1 ? after.at(-1)! : null;
}
