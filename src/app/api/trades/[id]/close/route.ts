import { NextRequest, NextResponse } from "next/server";
import type { ApiError, TradeDto } from "@/contracts/api";
import { authed } from "@/server/http";
import { TradeInputError, closeTrade } from "@/server/services/trades";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Close a trade with your exit fill (a TradeCloseRequest). */
export const POST = authed("Trade close", "Unable to close the trade right now.", async (email, request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  try {
    return NextResponse.json<TradeDto>(await closeTrade(email, (await context.params).id, await request.json().catch(() => null)));
  } catch (error) {
    if (error instanceof TradeInputError) return NextResponse.json<ApiError>({ error: error.message }, { status: 400 });
    throw error;
  }
});
