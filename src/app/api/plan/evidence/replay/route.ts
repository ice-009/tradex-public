import { NextRequest, NextResponse } from "next/server";
import type { EvidenceReplayResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { replayEvidence } from "@/server/services/evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Re-run this": compute a stamped evidence table again from scratch (~10 s); the body is a ReplayRequest. */
export const POST = authed(
  "Evidence replay",
  "Unable to re-run the evidence right now.",
  async (_email, request: NextRequest) => NextResponse.json<EvidenceReplayResponse>(await replayEvidence(await request.json().catch(() => null))),
  (): EvidenceReplayResponse => ({ status: "error", error: "Unable to re-run the evidence right now." }),
);
