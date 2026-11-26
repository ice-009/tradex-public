import { SESSION_OPEN_MIN, istParts } from "@/core/market/session";
import { BTST_WINDOW } from "@/core/screener/btstAlerts";

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
