import { NextRequest, NextResponse } from "next/server";
import type { LabResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { parseLabRequest, runLabRequest } from "@/server/services/lab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Run the Signal Lab; the body is a LabRequest. */
export const POST = authed(
  "Signal Lab",
  "Unable to run the Signal Lab right now.",
  async (_email, request: NextRequest) => NextResponse.json<LabResponse>(await runLabRequest(parseLabRequest(await request.json().catch(() => null)))),
  (): LabResponse => ({ status: "error", error: "Unable to run the Signal Lab right now." }),
);
