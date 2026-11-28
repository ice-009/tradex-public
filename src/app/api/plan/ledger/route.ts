import { NextRequest, NextResponse } from "next/server";
import type { PlanLedgerResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { ledgerView } from "@/server/services/planLedger";
import { pastDay } from "@/server/services/timeMachine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A YYYY-MM-DD date (or a day key) to its day key; null when absent or unreadable. */
const day = (value: string | null) => {
  if (!value) return null;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** The sealed daily plans with ?from&to (YYYY-MM-DD; default the last 30 days); live only (not in the Time Machine). */
export const GET = authed(
  "Plan ledger",
  "Unable to read the sealed-plan ledger right now.",
  async (_email, request: NextRequest) => {
    const params = request.nextUrl.searchParams;
    return NextResponse.json<PlanLedgerResponse>(await ledgerView({ from: day(params.get("from")), to: day(params.get("to")) }, await pastDay(params.get("asOf"))));
  },
  (): PlanLedgerResponse => ({ status: "error", error: "Unable to read the sealed-plan ledger right now." }),
);
