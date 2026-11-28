import { NextResponse } from "next/server";
import { authed } from "@/server/http";
import { newPaperSession } from "@/server/services/paper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start a new paper session (the current one is kept, closed). */
export const POST = authed("Paper session", "Unable to start a new paper session right now.", async (email) => NextResponse.json<{ id: string }>(await newPaperSession(email)));
