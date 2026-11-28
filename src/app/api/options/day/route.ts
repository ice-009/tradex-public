import { NextRequest, NextResponse } from "next/server";
import type { OptionsDayResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { optionsDayFor } from "@/server/services/options";
import { pastDay } from "@/server/services/timeMachine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every underlying's option summary on the newest stored day (?kind=stock|index); ?asOf=YYYY-MM-DD: on or before that day. */
export const GET = authed("Options day", "Unable to load the day's option summaries right now.", async (_email, request: NextRequest) => {
  const params = request.nextUrl.searchParams;
  const kind = params.get("kind");
  const past = await pastDay(params.get("asOf"));
  return NextResponse.json<OptionsDayResponse>(await optionsDayFor(kind === "stock" || kind === "index" ? kind : null, past));
});
