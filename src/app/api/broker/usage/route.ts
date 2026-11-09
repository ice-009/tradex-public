import { NextResponse } from "next/server";
import type { ApiUsageResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { budgetSnapshot } from "@/server/providers/fyers/budget";
import { hubMode } from "@/server/providers/hub";
import { hubApiUsage } from "@/server/services/marketConnection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Broker Data API usage today (calls, per priority, 429 strikes) — for the top bar meter. With a Market Data Hub, the hub's. */
export const GET = authed("API usage", "Unable to read API usage right now.", async () =>
  NextResponse.json<ApiUsageResponse>(hubMode() ? await hubApiUsage() : { ...budgetSnapshot(), via: "fyers" }),
);
