import { NextResponse } from "next/server";
import type { EvidenceResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { strategyEvidence } from "@/server/services/evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which screens have an edge in which market state (5-year replay; "computing" while it runs in the background). */
export const GET = authed(
  "Strategy evidence",
  "Unable to compute the strategy evidence right now.",
  async () => NextResponse.json<EvidenceResponse>(await strategyEvidence()),
  (): EvidenceResponse => ({ status: "error", error: "Unable to compute the strategy evidence right now." }),
);
