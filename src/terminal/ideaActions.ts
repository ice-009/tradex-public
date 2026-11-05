import { focusSetup, getFeed } from "@/client/screenerFeed";
import { getState, updateActiveCell } from "./store";

// UI actions on screener ideas: they move the active chart, so they live with
// the terminal's state rather than in the data feed.

/** Move the active chart to the next/previous idea in the screener's current order. */
export function stepIdea(direction: 1 | -1): string | null {
  const { order } = getFeed();
  if (!order.length) return null;
  const current = getState().cells[getState().activeCell].symbol;
  const index = order.indexOf(current);
  const next = index === -1 ? (direction === 1 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, index + direction));
  const symbol = order[next];
  if (symbol !== current) openIdea(symbol);
  return symbol;
}

/** Show a stock's setup: daily chart (screens are built on daily bars). */
export function openIdea(symbol: string, screenId?: string) {
  if (screenId) focusSetup(symbol, screenId);
  updateActiveCell({ symbol, interval: "1d" });
}
