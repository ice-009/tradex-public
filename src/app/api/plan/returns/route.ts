import { NextRequest, NextResponse } from "next/server";
import type { RiskReturnsResponse } from "@/contracts/api";
import { authed, symbolList } from "@/server/http";
import { MAX_RISK_SYMBOLS, riskReturns } from "@/server/services/riskReturns";
import { pastDay } from "@/server/services/timeMachine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The last 120 sessions' daily returns of ?symbols=A,B and NIFTY, for the plan's risk model; ?asOf=YYYY-MM-DD ends them at that day's close. */
export const GET = authed(
  "Plan returns",
  "Unable to load the daily returns right now.",
  async (_email, request: NextRequest) => {
    const params = request.nextUrl.searchParams;
    return NextResponse.json<RiskReturnsResponse>(await riskReturns(symbolList(params.get("symbols"), MAX_RISK_SYMBOLS), await pastDay(params.get("asOf"))));
  },
  (): RiskReturnsResponse => ({ status: "error", error: "Unable to load the daily returns right now." }),
);
