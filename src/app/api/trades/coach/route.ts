import { NextRequest, NextResponse } from "next/server";
import type { CoachResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { coachFor } from "@/server/services/coach";
import { pastDay } from "@/server/services/timeMachine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The trade coach on your journal (#42): MAE / MFE, rule breaks and findings with their samples. Live only (`past` in the Time Machine). */
export const GET = authed(
  "Trade coach",
  "Unable to review your journal right now.",
  async (email, request: NextRequest) => NextResponse.json<CoachResponse>(await coachFor(email, await pastDay(request.nextUrl.searchParams.get("asOf")))),
  (): CoachResponse => ({ status: "error", error: "Unable to review your journal right now." }),
);
