import { NextResponse } from "next/server";
import type { LabCardsResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { labCardIndex } from "@/server/services/labCards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The report cards index (#23): every Lab signal with its latest stored report's verdict. */
export const GET = authed("Lab cards", "Unable to load the report cards right now.", async () => NextResponse.json<LabCardsResponse>(labCardIndex()));
