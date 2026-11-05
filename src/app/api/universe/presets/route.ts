import { NextResponse } from "next/server";
import type { PresetsResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { getPresetLists } from "@/server/services/presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ready-made watchlists: every F&O stock, by sector, a popular list, and Nifty 50. */
export const GET = authed("Presets", "Unable to load the ready-made lists right now.", async () => NextResponse.json<PresetsResponse>({ presets: await getPresetLists() }));
