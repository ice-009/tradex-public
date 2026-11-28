import { NextRequest, NextResponse } from "next/server";
import type { PaperResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { listPaper, takePaper } from "@/server/services/paper";
import { pastDay } from "@/server/services/timeMachine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const pastOf = (request: NextRequest) => pastDay(request.nextUrl.searchParams.get("asOf"), request.nextUrl.searchParams.get("replay"));

/** The current paper session (Time Machine replay), every trade graded as of ?asOf's close. */
export const GET = authed("Paper trades", "Unable to load your paper trades right now.", async (email, request: NextRequest) => NextResponse.json<PaperResponse>(await listPaper(email, await pastOf(request))));

/** Paper-take a plan idea on ?asOf (a PaperTakeRequest). */
export const POST = authed("Paper take", "Unable to save the paper trade right now.", async (email, request: NextRequest) =>
  NextResponse.json<{ id: string }>(await takePaper(email, await pastOf(request), await request.json().catch(() => null))),
);
