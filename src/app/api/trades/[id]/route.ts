import { NextRequest, NextResponse } from "next/server";
import type { ApiError, TradeDto } from "@/contracts/api";
import { authed } from "@/server/http";
import { TradeInputError, deleteTrade, updateTrade } from "@/server/services/trades";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const inputError = (error: unknown) => (error instanceof TradeInputError ? NextResponse.json<ApiError>({ error: error.message }, { status: 400 }) : null);

/** Fix a trade's fill, size, stop, target or notes (a TradeUpdateRequest). */
export const PATCH = authed("Trade update", "Unable to update the trade right now.", async (email, request: NextRequest, context: Context) => {
  try {
    return NextResponse.json<TradeDto>(await updateTrade(email, (await context.params).id, await request.json().catch(() => null)));
  } catch (error) {
    const answer = inputError(error);
    if (answer) return answer;
    throw error;
  }
});

/** Remove a trade entered by mistake. */
export const DELETE = authed("Trade delete", "Unable to delete the trade right now.", async (email, _request: NextRequest, context: Context) => {
  try {
    await deleteTrade(email, (await context.params).id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const answer = inputError(error);
    if (answer) return answer;
    throw error;
  }
});
