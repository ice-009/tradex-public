import "server-only";

import type { QuotesResponse } from "@/contracts/api";
import { dataEngine } from "@/server/data";
import { asPriority, fyersPlan } from "@/server/providers/fyers/budget";

// Snapshot quotes for the watchlist (initial paint + safety-net refresh), from
// the data engine: live quotes from the broker where it has them, the last
// end-of-day close (marked delayed) for anything it doesn't. Tick-by-tick
// updates arrive over /api/broker/stream.

export const MAX_QUOTE_SYMBOLS = 300;

/**
 * How old a cached quote may be. Tradex is for shortlisting, not order entry, so a
 * refresh (watchlist rows off screen, alerts' backstop — on-screen rows and charts
 * stream live at no API cost) accepts quotes up to 5 minutes old on Fyers Standard,
 * the same age the screener uses, so both share one fetch. `fresh` is for the rare
 * just-now price. Prime's budget is 100× larger.
 */
function maxAgeMs(fresh: boolean) {
  if (fresh) return 5_000;
  return fyersPlan().name === "prime" ? 15_000 : 5 * 60_000;
}

export async function getQuotes(symbols: string[], fresh = false): Promise<QuotesResponse> {
  if (!symbols.length) return { quotes: [] };
  return { quotes: await asPriority(fresh ? "user" : "refresh", () => dataEngine().quotes(symbols, { maxAgeMs: maxAgeMs(fresh) })) };
}
