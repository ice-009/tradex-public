import { NextResponse } from "next/server";
import type { BrokerStatusResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { hubBrokerStatus } from "@/server/services/marketConnection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How Tradex reaches the market: the Market Data Hub's state (not configured, unreachable, or connected with its health). */
export const GET = authed("Broker status", "Unable to check the Market Data Hub right now.", async () => NextResponse.json<BrokerStatusResponse>(await hubBrokerStatus()));
