import { NextRequest, NextResponse } from "next/server";
import type { EvidenceResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { strategyEvidence } from "@/server/services/evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const day = (value: string | null) => (value === null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

/**
 * Which screens have an edge in which market state ("computing" while it runs in the background):
 * the plan's 5-year replay, or with ?from&to (day keys) that period's.
 */
export const GET = authed(
  "Strategy evidence",
  "Unable to compute the strategy evidence right now.",
  async (_email, request: NextRequest) => {
    const params = request.nextUrl.searchParams;
    return NextResponse.json<EvidenceResponse>(await strategyEvidence({ from: day(params.get("from")), to: day(params.get("to")) }));
  },
  (): EvidenceResponse => ({ status: "error", error: "Unable to compute the strategy evidence right now." }),
);
