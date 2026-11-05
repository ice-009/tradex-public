import { NextRequest, NextResponse } from "next/server";
import type { QuotesResponse } from "@/contracts/api";
import { authed, symbolList } from "@/server/http";
import { MAX_QUOTE_SYMBOLS, getQuotes } from "@/server/services/quotes";

/** Snapshot quotes for ?symbols=A,B (broker, with end-of-day fallback); ?fresh=1 for a just-now price. */
export const GET = authed("Quotes", "Unable to load quotes right now.", async (_email, request: NextRequest) => {
  const params = request.nextUrl.searchParams;
  return NextResponse.json<QuotesResponse>(await getQuotes(symbolList(params.get("symbols"), MAX_QUOTE_SYMBOLS), params.get("fresh") === "1"));
});
