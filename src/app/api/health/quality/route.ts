import { NextResponse } from "next/server";
import type { DataQualityResponse } from "@/contracts/api";
import { qualityReport } from "@/core/quality/findings";
import { authed } from "@/server/http";
import { hubHealth } from "@/server/providers/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The hub's data-quality findings (from its /v1/status, cached 30 s), for the terminal's alerts. */
export const GET = authed("Data quality", "Unable to read the hub's data-quality findings right now.", async () => {
  const { status } = await hubHealth();
  return NextResponse.json<DataQualityResponse>({ checkedAt: Date.now(), quality: qualityReport(status?.quality) });
});
