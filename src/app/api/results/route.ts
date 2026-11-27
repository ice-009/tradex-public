import { NextRequest, NextResponse } from "next/server";
import type { ResultsResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { getResultsWindow } from "@/server/services/results";
import { pastDay, resultsAsOf } from "@/server/services/timeMachine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Results dates from a week ago to five weeks ahead (NSE event calendar, best-effort); ?asOf=YYYY-MM-DD: the week up to that day. */
export const GET = authed("Results", "Unable to load the results calendar right now.", async (_email, request: NextRequest) => {
  const past = await pastDay(request.nextUrl.searchParams.get("asOf"));
  return NextResponse.json<ResultsResponse>(past ? await resultsAsOf(past.day) : await getResultsWindow());
});
