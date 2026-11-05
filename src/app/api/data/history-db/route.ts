import { NextRequest, NextResponse } from "next/server";
import type { HistoryDbAction, HistoryDbStatus, HistoryKind } from "@/contracts/api";
import { authed } from "@/server/http";
import { historyDbStatus, startHistoryPrefetch, stopHistoryPrefetch } from "@/server/services/historyPrefetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The local market-data database: coverage and the "Download F&O history" job. */
export const GET = authed("History database", "Unable to read the history database right now.", async () => NextResponse.json<HistoryDbStatus>(await historyDbStatus()));

/** Start (`{ action: "start", kinds: ["daily", "m15"] }`) or stop (`{ action: "stop" }`) the download. */
export const POST = authed("History database", "Unable to change the history download right now.", async (_email, request: NextRequest) => {
  const body = (await request.json().catch(() => null)) as HistoryDbAction | null;
  if (body?.action === "start") {
    const kinds = (Array.isArray(body.kinds) ? body.kinds : []).filter((kind): kind is HistoryKind => kind === "daily" || kind === "m15");
    await startHistoryPrefetch(kinds.length ? kinds : ["daily", "m15"]);
  } else if (body?.action === "stop") {
    stopHistoryPrefetch();
  }
  return NextResponse.json<HistoryDbStatus>(await historyDbStatus());
});
