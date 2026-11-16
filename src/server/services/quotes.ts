import "server-only";

import type { QuotesResponse } from "@/contracts/api";
import { dataEngine } from "@/server/data";
import { planLimits } from "@/server/providers/hub/budget";

// Snapshot quotes for the watchlist (initial paint + safety-net refresh), from
// the Market Data Hub through the data engine: live where the hub has them, its
// last stored price (marked delayed) otherwise. Tick-by-tick updates arrive
// over /api/broker/stream.

export const MAX_QUOTE_SYMBOLS = 300;

/**
 * How old a cached quote may be. Tradex is for shortlisting, not order entry, so a
 * refresh (watchlist rows off screen, alerts' backstop — on-screen rows and charts
 * stream live) accepts quotes up to 5 minutes old on the broker's Standard plan,
 * the same age the screener uses, so both share one request. `fresh` is for the
 * rare just-now price. Prime's budget is 100× larger.
 */
function maxAgeMs(fresh: boolean) {
  if (fresh) return 5_000;
  return planLimits().name === "prime" ? 15_000 : 5 * 60_000;
}

export async function getQuotes(symbols: string[], fresh = false): Promise<QuotesResponse> {
  if (!symbols.length) return { quotes: [] };
  return { quotes: await dataEngine().quotes(symbols, { maxAgeMs: maxAgeMs(fresh) }) };
}
