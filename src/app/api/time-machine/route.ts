import { NextRequest, NextResponse } from "next/server";
import type { TimeMachineResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { timeMachineInfo } from "@/server/services/timeMachine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Time Machine (#31): which session ?asOf=YYYY-MM-DD means (the last one on or before it) and what was known that day. */
export const GET = authed("Time Machine", "Unable to open that day right now.", async (_email, request: NextRequest) =>
  NextResponse.json<TimeMachineResponse>(await timeMachineInfo(request.nextUrl.searchParams.get("asOf"))),
);
