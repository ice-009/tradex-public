// When did each setup first appear today? The screener re-runs all day on live
// prices; this remembers the first time each (screen, stock) matched, so the
// panel can show "new since 11:42" and sort fresh setups first. A setup that
// flickers out and back in within GRACE_MS keeps its original time (no "new"
// spam from a price hovering around a threshold). Pure.

export const GRACE_MS = 10 * 60 * 1000;

export interface FreshState {
  /** IST day key the state belongs to; a new day starts empty. */
  day: number;
  seen: Record<string, { first: number; last: number }>;
}

export const emptyFresh = (day: number): FreshState => ({ day, seen: {} });

export const freshKey = (screenId: string, symbol: string) => `${screenId}:${symbol}`;

/** Record the keys matching now; returns the new state (input not mutated). */
export function updateFresh(state: FreshState, day: number, keys: string[], now: number): FreshState {
  const base = state.day === day ? state : emptyFresh(day);
  const seen: FreshState["seen"] = {};
  for (const [key, entry] of Object.entries(base.seen)) if (now - entry.last <= GRACE_MS) seen[key] = entry;
  for (const key of keys) seen[key] = { first: seen[key]?.first ?? now, last: now };
  return { day, seen };
}

/** A setup counts as new for this long after it first matched. */
export const NEW_WINDOW_MS = 30 * 60 * 1000;
/** Setups found in the day's first scan aren't "new" (they were there at the open). */
export const FIRST_SCAN_GRACE_MS = 5 * 60 * 1000;

/**
 * Is a setup first seen at `firstSeenAt` new as of `now`? `firstScanAt` is the
 * earliest first-seen time of the day (the first scan).
 */
export function isNewSetup(firstSeenAt: number | undefined, firstScanAt: number, now: number): boolean {
  if (!firstSeenAt) return false;
  return firstSeenAt > firstScanAt + FIRST_SCAN_GRACE_MS && now - firstSeenAt <= NEW_WINDOW_MS;
}
