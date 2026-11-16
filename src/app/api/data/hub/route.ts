import { NextResponse } from "next/server";
import type { MarketDataStatus } from "@/contracts/api";
import { authed } from "@/server/http";
import { marketDataStatus } from "@/server/services/marketConnection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Market data: provided by your hub": the hub's health and the freshness of each dataset (read-only). */
export const GET = authed("Market data", "Unable to read the Market Data Hub's status right now.", async () => NextResponse.json<MarketDataStatus>(await marketDataStatus()));
