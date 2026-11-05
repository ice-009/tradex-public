import { NextResponse } from "next/server";
import type { ResultsResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { getResultsWindow } from "@/server/services/results";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Results dates from a week ago to five weeks ahead (NSE event calendar, best-effort). */
export const GET = authed("Results", "Unable to load the results calendar right now.", async () => NextResponse.json<ResultsResponse>(await getResultsWindow()));
