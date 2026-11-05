import { NextRequest, NextResponse } from "next/server";
import type { BacktestInfoResponse, BacktestResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { backtestInfo, parseBacktestRequest, runBacktest } from "@/server/services/backtest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stored history available for a backtest of ?universe=. */
export const GET = authed("Backtest info", "Unable to read the stored history right now.", async (_email, request: NextRequest) =>
  NextResponse.json<BacktestInfoResponse>(await backtestInfo(request.nextUrl.searchParams.get("universe") ?? "")),
);

/** Run a backtest; the body is a BacktestRequest. */
export const POST = authed(
  "Backtest",
  "Unable to run the backtest right now.",
  async (_email, request: NextRequest) => NextResponse.json<BacktestResponse>(await runBacktest(parseBacktestRequest(await request.json().catch(() => null)))),
  (): BacktestResponse => ({ status: "error", error: "Unable to run the backtest right now." }),
);
