// Market phases a backtest or the evidence check can be run over, and what
// counts as a "long" range. Pure.
//
// The Market Data Hub serves daily history back to NSE's first session (3 Nov
// 1994): the broker's ~5 years, and NSE's archive before them
// (market-data-hub#22). The screener's store holds the 5 years, so a period
// inside them runs exactly as before; a period reaching further back is read
// from the hub for that run (src/server/providers/longBars.ts). Those are
// opt-in — the default period and the plan's evidence keep the 5 years.

import { DAY_MS } from "@/core/market/session";

/** NSE's first session in its archive (day key). */
export const ARCHIVE_START = Date.UTC(1994, 10, 3);

/** Days of daily history the screener's store keeps (the hub's broker window: 5 × 365 − 3). */
export const STORE_DAYS = 5 * 365 - 3;

/**
 * Calendar days read before a long period's first session: features look back
 * 260 sessions (src/core/backtest/signals.ts), so ~300 sessions make a period's
 * first signal exactly what it would be with all history before it.
 */
export const WARMUP_DAYS = 440;

export interface MarketPhase {
  id: string;
  label: string;
  /** First and last session (day keys); `to` null = up to the newest stored session. */
  from: number;
  to: number | null;
  note: string;
}

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

export const MARKET_PHASES: readonly MarketPhase[] = [
  { id: "crash-2008", label: "2008 crash", from: day("2008-01-01"), to: day("2009-03-31"), note: "NIFTY's January 2008 top to the March 2009 bottom: about −60%." },
  { id: "sideways-2010", label: "2010–13 sideways", from: day("2010-01-01"), to: day("2013-12-31"), note: "Four years of NIFTY ranging between about 4,500 and 6,300." },
  { id: "covid-2020", label: "2020 Covid crash", from: day("2020-01-01"), to: day("2020-12-31"), note: "The February–March 2020 crash (about −38%) and the recovery to new highs by December." },
  { id: "recent-2021", label: "2021–26", from: day("2021-01-01"), to: null, note: "From January 2021 to the newest session: the post-Covid bull run and what followed." },
];

export const phaseById = (id: string): MarketPhase | null => MARKET_PHASES.find((phase) => phase.id === id) ?? null;

/** First day the screener's store holds at `today` (a day key). */
export const storeStart = (today: number) => today - STORE_DAYS * DAY_MS;

/** Does a period starting on `from` reach before the store (so it is read from the hub for the run)? */
export const isLongRange = (from: number | null, today: number) => from !== null && from < storeStart(today);

/** A period's `from`, never before NSE's archive. */
export const clampToArchive = (from: number) => Math.max(ARCHIVE_START, from);
