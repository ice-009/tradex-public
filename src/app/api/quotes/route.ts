import { NextRequest, NextResponse } from "next/server";
import type { QuotesResponse } from "@/contracts/api";
import { authed, symbolList } from "@/server/http";
import { MAX_QUOTE_SYMBOLS, getQuotes } from "@/server/services/quotes";
import { pastDay, quotesAsOf } from "@/server/services/timeMachine";

/** Snapshot quotes for ?symbols=A,B from the Market Data Hub (stored last prices marked delayed); ?fresh=1 for a just-now price; ?asOf=YYYY-MM-DD for that day's closes. */
export const GET = authed("Quotes", "Unable to load quotes right now.", async (_email, request: NextRequest) => {
  const params = request.nextUrl.searchParams;
  const symbols = symbolList(params.get("symbols"), MAX_QUOTE_SYMBOLS);
  const past = await pastDay(params.get("asOf"), params.get("replay"));
  return NextResponse.json<QuotesResponse>(past ? await quotesAsOf(symbols, past.day, past.replay) : await getQuotes(symbols, params.get("fresh") === "1"));
});
