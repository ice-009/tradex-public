import { NextRequest, NextResponse } from "next/server";
import type { TrackResult } from "@/contracts/api";
import { authed } from "@/server/http";
import { parseUniverse, trackRecord } from "@/server/services/screener";
import { pastDay } from "@/server/services/timeMachine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Historical replay of every screen over ?universe= (?asOf=YYYY-MM-DD: the sessions before that day). */
export const GET = authed(
  "Track record",
  "Unable to replay the screens right now.",
  async (_email, request: NextRequest) => {
    const params = request.nextUrl.searchParams;
    return NextResponse.json<TrackResult>(await trackRecord(parseUniverse(params.get("universe")), await pastDay(params.get("asOf"), params.get("replay"))));
  },
  (): TrackResult => ({ status: "error", error: "Unable to replay the screens right now." }),
);
