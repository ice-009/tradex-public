import { NextRequest, NextResponse } from "next/server";
import type { HighLowResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { readHighLow } from "@/server/services/highLowScanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Day high / low events for F&O cash + futures after sequence number ?after=. */
export const GET = authed("High/low", "Unable to read the high/low scan right now.", async (_email, request: NextRequest) =>
  NextResponse.json<HighLowResponse>(await readHighLow(Number(request.nextUrl.searchParams.get("after") ?? 0) || 0)),
);
