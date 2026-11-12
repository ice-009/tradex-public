import { NextRequest, NextResponse } from "next/server";
import type { FuturesResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { getFutures } from "@/server/services/futures";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A stock's listed futures contracts (near and next month) and lot size, from the Market Data Hub. */
export const GET = authed("Futures", "Unable to load futures contracts right now.", async (_email, request: NextRequest) =>
  NextResponse.json<FuturesResponse>(await getFutures(request.nextUrl.searchParams.get("symbol") ?? "")),
);
