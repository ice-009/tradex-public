import { NextRequest, NextResponse } from "next/server";
import type { TrackResult } from "@/contracts/api";
import { authed } from "@/server/http";
import { parseUniverse, trackRecord } from "@/server/services/screener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Historical replay of every screen over ?universe=. */
export const GET = authed(
  "Track record",
  "Unable to replay the screens right now.",
  async (_email, request: NextRequest) => NextResponse.json<TrackResult>(await trackRecord(parseUniverse(request.nextUrl.searchParams.get("universe")))),
  (): TrackResult => ({ status: "error", error: "Unable to replay the screens right now." }),
);
