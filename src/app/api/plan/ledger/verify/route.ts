import { NextRequest, NextResponse } from "next/server";
import type { PlanLedgerVerifyResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { verifyPlanLedger } from "@/server/services/planLedger";
import { pastDay } from "@/server/services/timeMachine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The sealed-plan ledger verified end to end: every hash, every link, the published hashes, and the trading days with no seal. */
export const GET = authed(
  "Plan ledger verify",
  "Unable to verify the sealed-plan ledger right now.",
  async (_email, request: NextRequest) => NextResponse.json<PlanLedgerVerifyResponse>(await verifyPlanLedger(await pastDay(request.nextUrl.searchParams.get("asOf")))),
  (): PlanLedgerVerifyResponse => ({ status: "error", error: "Unable to verify the sealed-plan ledger right now." }),
);
