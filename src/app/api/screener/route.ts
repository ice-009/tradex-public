import { NextRequest, NextResponse } from "next/server";
import type { ScreenerResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { parseUniverse, runScreener } from "@/server/services/screener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every screen over ?universe= (default nifty200); ?live=0 skips today's live bar. */
export const GET = authed(
  "Screener",
  "Unable to run the screener right now.",
  async (_email, request: NextRequest) => {
    const params = request.nextUrl.searchParams;
    return NextResponse.json<ScreenerResponse>(await runScreener(parseUniverse(params.get("universe")), params.get("live") !== "0"));
  },
  (): ScreenerResponse => ({ status: "error", error: "Unable to run the screener right now." }),
);
