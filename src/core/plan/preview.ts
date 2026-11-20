import { SESSION_OPEN_MIN, istParts } from "@/core/market/session";
import { BTST_WINDOW } from "@/core/screener/btstAlerts";
import { SCREENS } from "@/core/screener/screens";
import { bucketFor, type MarketState, type ScreenEvidence } from "./evidence";

// How to read today's plan during the session. Pure.
//
// The screens were tested on closing prices, and the plan is bought at the
// close (3:15–3:25 PM). Before that window the day's bar still has hours to
// change: a stock up 5% at noon matches a "strong close" screen now and may not
// by 3:15 PM. So until the window opens the plan is a preview.

/** True on a weekday between the open and the close window while the screener scans live prices. */
export function isPlanPreview(live: boolean, time: number = Date.now()): boolean {
  const { minutes, weekday } = istParts(time);
  return live && weekday !== 0 && weekday !== 6 && minutes >= SESSION_OPEN_MIN && minutes < BTST_WINDOW.from;
}

/**
 * Screens with a positive record over the tested years that the evidence rule
 * leaves out in this market state because their last 12 months lost money,
 * worst first. They explain a short plan: "these used to work and stopped".
 */
export function stoppedWorking(screens: Record<string, ScreenEvidence>, state: MarketState | null, eligible: string[]): Array<{ id: string; name: string; recentR: number }> {
  if (!state) return [];
  const out: Array<{ id: string; name: string; recentR: number }> = [];
  for (const screen of SCREENS) {
    const evidence = screens[screen.id];
    if (!evidence || eligible.includes(screen.id)) continue;
    const bucket = bucketFor(evidence, state);
    const recentR = bucket.recent?.mean ?? 0;
    if ((bucket.mean ?? 0) > 0 && recentR < 0) out.push({ id: screen.id, name: screen.name, recentR });
  }
  return out.sort((a, b) => a.recentR - b.recentR);
}
