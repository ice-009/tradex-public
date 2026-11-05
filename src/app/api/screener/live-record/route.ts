import { NextResponse } from "next/server";
import type { LiveRecordResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { liveRecord } from "@/server/services/btstRecord";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The BTST live record: setups seen at 3:10–3:25 PM, settled at the next open. */
export const GET = authed("Live record", "Unable to load the BTST live record right now.", async () => NextResponse.json<LiveRecordResponse>(await liveRecord()));
