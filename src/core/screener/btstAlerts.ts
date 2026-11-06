import { istParts } from "@/core/market/session";
import type { Outcome } from "./backtest";
import type { ScreenDef, ScreenerRow } from "./screens";

// Which BTST setups to flash, and when. BTST screens are bought near the close
// and sold at the next open (ScreenDef.exit), so a match only becomes a trade in
// the last minutes of the session: before 3:10 PM the day's bar can still change
// a lot, after 3:25 PM there's no time left to act. Inside that window every
// live match flashes once per day. A screen only flashes while its own track
// record beats its costs — the screener keeps showing the others, it just
// doesn't interrupt you for them. Pure.

/** IST minutes: 3:10 PM to 3:25 PM. */
export const BTST_WINDOW = { from: 15 * 60 + 10, to: 15 * 60 + 25 };
/** Fewer past signals than this and the track record can't vouch for a screen. */
export const MIN_TRACK_SIGNALS = 20;
/**
 * The track record is in R before costs. A futures round trip costs ~0.11% with
 * slippage, about 0.04R on the typical ~3% BTST stop; 0.05R leaves a little margin.
 */
export const MIN_EDGE_R = 0.05;

export function inBtstWindow(time: number = Date.now()): boolean {
  const { minutes, weekday } = istParts(time);
  return weekday !== 0 && weekday !== 6 && minutes >= BTST_WINDOW.from && minutes <= BTST_WINDOW.to;
}

/** Why a BTST screen won't flash (null = it will). */
export function mutedReason(record: (Outcome & { avgR: number | null }) | undefined): string | null {
  if (!record) return "track record not loaded yet";
  if (record.signals < MIN_TRACK_SIGNALS) return `only ${record.signals} past signals`;
  if (record.avgR === null || record.avgR < MIN_EDGE_R) return `past signals averaged ${record.avgR === null ? "–" : record.avgR.toFixed(2)}R, under the ~${MIN_EDGE_R}R costs`;
  return null;
}

export interface BtstAlert {
  key: string;
  screen: ScreenDef;
  row: ScreenerRow;
}

/** One key per setup per day, so a setup flashes once however often the screener re-runs. */
export const alertKey = (day: number, screenId: string, symbol: string) => `${day}:${screenId}:${symbol}`;

/** Live BTST matches that should flash now and haven't yet today. */
export function pendingBtstAlerts(params: {
  screens: ScreenDef[];
  results: Record<string, ScreenerRow[]> | undefined;
  track: Record<string, Outcome & { avgR: number | null }> | undefined;
  banned: string[];
  alerted: Set<string>;
  now: number;
}): BtstAlert[] {
  const { screens, results, track, alerted, now } = params;
  if (!results || !inBtstWindow(now)) return [];
  const day = istParts(now).day;
  const banned = new Set(params.banned);
  const out: BtstAlert[] = [];
  for (const screen of screens) {
    if (screen.exit !== "next-open" || mutedReason(track?.[screen.id])) continue;
    for (const row of results[screen.id] ?? []) {
      const key = alertKey(day, screen.id, row.symbol);
      // Only today's live bar: an EOD row is yesterday's setup.
      if (!row.live || banned.has(row.symbol) || alerted.has(key)) continue;
      out.push({ key, screen, row });
    }
  }
  return out;
}
