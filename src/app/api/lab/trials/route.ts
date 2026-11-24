import { NextRequest, NextResponse } from "next/server";
import type { ApiError, LabTrialsResponse } from "@/contracts/api";
import { isIdeaId } from "@/core/lab/trials";
import { authed } from "@/server/http";
import { trialSummary } from "@/server/services/labTrials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Signal Lab's trial record for one idea: every variant tried, the luck benchmark and the deflated Sharpe verdicts (#24). */
export const GET = authed("Lab trials", "Unable to load the Lab's trials right now.", async (_email, request: NextRequest) => {
  const idea = request.nextUrl.searchParams.get("idea");
  if (!isIdeaId(idea)) return NextResponse.json<ApiError>({ error: "idea must be 1–80 letters, digits or . _ : -" }, { status: 400 });
  return NextResponse.json<LabTrialsResponse>(trialSummary(idea));
});
