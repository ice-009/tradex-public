import { NextRequest, NextResponse } from "next/server";
import type { BacktestResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { replayBacktest } from "@/server/services/backtest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Re-run this": run a stamped backtest again from scratch; the body is a ReplayRequest. */
export const POST = authed(
  "Backtest replay",
  "Unable to re-run the backtest right now.",
  async (_email, request: NextRequest) => NextResponse.json<BacktestResponse>(await replayBacktest(await request.json().catch(() => null))),
  (): BacktestResponse => ({ status: "error", error: "Unable to re-run the backtest right now." }),
);
