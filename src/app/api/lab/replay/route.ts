import { NextRequest, NextResponse } from "next/server";
import type { LabResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { replayLab } from "@/server/services/lab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Re-run this": run a stamped Lab run again from scratch; the body is a ReplayRequest. */
export const POST = authed(
  "Signal Lab replay",
  "Unable to re-run the Signal Lab right now.",
  async (_email, request: NextRequest) => NextResponse.json<LabResponse>(await replayLab(await request.json().catch(() => null))),
  (): LabResponse => ({ status: "error", error: "Unable to re-run the Signal Lab right now." }),
);
