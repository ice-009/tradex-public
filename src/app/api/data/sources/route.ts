import { NextResponse } from "next/server";
import type { DataSourcesResponse } from "@/contracts/api";
import { dataEngine, marketStream } from "@/server/data";
import { authed } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The data sources in the order they're tried, whether each can serve now, and how live prices are fed. */
export const GET = authed("Data sources", "Unable to read the data sources right now.", async (email) => {
  const engine = dataEngine();
  const sources = await Promise.all(
    engine.status().map(async ({ source, restingUntil, lastError }) => ({
      id: source.id,
      label: source.label,
      kind: source.kind,
      provides: [source.history && "history", source.quotes && "quotes", source.stream && "stream"].filter(Boolean) as DataSourcesResponse["sources"][number]["provides"],
      unavailable: await engine.unavailable(source, email),
      lastError,
      restingUntil,
    })),
  );
  const status = marketStream().status();
  return NextResponse.json<DataSourcesResponse>({ sources, stream: { mode: status.mode, source: status.source, live: status.live.length, polled: status.polled.length } });
});
