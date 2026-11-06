import { NextRequest, NextResponse } from "next/server";
import type { ApiError, TradeDto, TradesResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { TradeInputError, createTrade, listTrades } from "@/server/services/trades";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Your trades: open ones with today's action, closed ones with the journal summary. */
export const GET = authed("Trades", "Unable to load your trades right now.", async (email) => NextResponse.json<TradesResponse>(await listTrades(email)));

/** "I took it": record a trade from the plan (a TradeCreateRequest). */
export const POST = authed("Trade create", "Unable to save the trade right now.", async (email, request: NextRequest) => {
  try {
    return NextResponse.json<TradeDto>(await createTrade(email, await request.json().catch(() => null)));
  } catch (error) {
    if (error instanceof TradeInputError) return NextResponse.json<ApiError>({ error: error.message }, { status: 400 });
    throw error;
  }
});
