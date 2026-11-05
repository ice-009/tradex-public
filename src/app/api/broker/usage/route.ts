import { NextResponse } from "next/server";
import type { ApiUsageResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { budgetSnapshot } from "@/server/providers/fyers/budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Fyers Data API usage today (calls, per priority, 429 strikes) — for the top bar meter. */
export const GET = authed("API usage", "Unable to read API usage right now.", async () => NextResponse.json<ApiUsageResponse>(budgetSnapshot()));
