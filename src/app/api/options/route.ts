import { NextRequest, NextResponse } from "next/server";
import type { OptionsResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { optionsFor, parseOptionRange } from "@/server/services/options";
import { pastDay } from "@/server/services/timeMachine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** An underlying's daily option summaries (IV, skew, PCR, max pain, straddle) from the Market Data Hub; ?asOf=YYYY-MM-DD: up to that day. */
export const GET = authed("Options", "Unable to load option summaries right now.", async (_email, request: NextRequest) => {
  const params = request.nextUrl.searchParams;
  const past = await pastDay(params.get("asOf"));
  return NextResponse.json<OptionsResponse>(await optionsFor(params.get("symbol") ?? "", parseOptionRange(params.get("range")), past));
});
