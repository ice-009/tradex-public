import { NextRequest, NextResponse } from "next/server";
import type { AnalyzeResponse } from "@/contracts/api";
import { authed, symbolList } from "@/server/http";
import { MAX_ANALYZE_SYMBOLS, analyzeSymbols } from "@/server/services/analyze";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Facts, score inputs and a chart-based plan for ?symbols=A,B (Compare view). */
export const GET = authed("Analyze", "Unable to analyze these symbols right now.", async (_email, request: NextRequest) =>
  NextResponse.json<AnalyzeResponse>({ stocks: await analyzeSymbols(symbolList(request.nextUrl.searchParams.get("symbols"), MAX_ANALYZE_SYMBOLS)) }),
);
