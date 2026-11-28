import { NextRequest, NextResponse } from "next/server";
import type { LotsResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { getLotSizes } from "@/server/providers/reference";
import { lotsAsOf, pastDay } from "@/server/services/timeMachine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stock-futures lot sizes, from the Market Data Hub (its copy of NSE's lot file); ?asOf=YYYY-MM-DD: as traded that day. */
export const GET = authed("Lots", "Unable to load lot sizes right now.", async (_email, request: NextRequest) => {
  const past = await pastDay(request.nextUrl.searchParams.get("asOf"), request.nextUrl.searchParams.get("replay"));
  return NextResponse.json<LotsResponse>(past ? await lotsAsOf(past.day) : await getLotSizes());
});
