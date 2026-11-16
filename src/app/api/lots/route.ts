import { NextResponse } from "next/server";
import type { LotsResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { getLotSizes } from "@/server/providers/reference";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stock-futures lot sizes, from the Market Data Hub (its copy of NSE's lot file). */
export const GET = authed("Lots", "Unable to load lot sizes right now.", async () => NextResponse.json<LotsResponse>(await getLotSizes()));
