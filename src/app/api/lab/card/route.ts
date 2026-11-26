import { NextRequest, NextResponse } from "next/server";
import type { ApiError, LabCardResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { labCard } from "@/server/services/labCards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One signal's report card (#23): ?signal=<id>[&variant=<variant key>] (default: its newest stored run). */
export const GET = authed("Lab card", "Unable to load the report card right now.", async (_email, request: NextRequest) => {
  const params = request.nextUrl.searchParams;
  const card = labCard(String(params.get("signal") ?? "").slice(0, 80), params.get("variant")?.slice(0, 4_000) || null);
  if (!card) return NextResponse.json<ApiError>({ error: "Unknown signal." }, { status: 404 });
  return NextResponse.json<LabCardResponse>(card);
});
