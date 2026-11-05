import { NextRequest, NextResponse } from "next/server";
import type { ChartResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { getChart } from "@/server/services/chart";

/** Candles for ?symbol&interval&range (broker, else sample data). */
export const GET = authed("Chart", "Unable to load chart data right now.", async (email, request: NextRequest) => {
  const params = request.nextUrl.searchParams;
  return NextResponse.json<ChartResponse>(await getChart(email, { symbol: params.get("symbol"), interval: params.get("interval"), range: params.get("range") }));
});
