import { NextResponse } from "next/server";
import type { ApiUsageResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { hubApiUsage } from "@/server/services/marketConnection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Market Data Hub's broker budget today (calls, per priority, 429 strikes) and its health — for the top bar meter. */
export const GET = authed("API usage", "Unable to read API usage right now.", async () => NextResponse.json<ApiUsageResponse>(await hubApiUsage()));
