import { NextRequest, NextResponse } from "next/server";
import type { ChartResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { getChart } from "@/server/services/chart";
import { pastDay } from "@/server/services/timeMachine";

/** Candles for ?symbol&interval&range (broker, else sample data); daily-based intervals also take &from&to (epoch ms) for older bars; ?asOf=YYYY-MM-DD ends them at that day's close. */
export const GET = authed("Chart", "Unable to load chart data right now.", async (email, request: NextRequest) => {
  const params = request.nextUrl.searchParams;
  const past = await pastDay(params.get("asOf"));
  return NextResponse.json<ChartResponse>(await getChart(email, { symbol: params.get("symbol"), interval: params.get("interval"), range: params.get("range"), from: params.get("from"), to: params.get("to") }, past));
});
