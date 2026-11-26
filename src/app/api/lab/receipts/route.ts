import { NextResponse } from "next/server";
import type { ReceiptsResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { labReceipts } from "@/server/services/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Receipts (#29): every score factor's and screen's report card in brief, and the factors whose card passes. */
export const GET = authed("Lab receipts", "Unable to load the receipts right now.", async () => NextResponse.json<ReceiptsResponse>(labReceipts()));
