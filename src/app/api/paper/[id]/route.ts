import { NextRequest, NextResponse } from "next/server";
import { authed } from "@/server/http";
import { removePaper } from "@/server/services/paper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Remove a paper trade. */
export const DELETE = authed("Paper delete", "Unable to delete the paper trade right now.", async (email, _request: NextRequest, context: Context) => {
  await removePaper(email, (await context.params).id);
  return NextResponse.json({ ok: true });
});
