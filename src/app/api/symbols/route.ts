import { NextRequest, NextResponse } from "next/server";
import type { SymbolsResponse } from "@/contracts/api";
import { authed } from "@/server/http";
import { searchSymbols } from "@/server/providers/symbols";

/** Symbol search for ?q= (stocks and the indices the chart can open). */
export const GET = authed("Symbols", "Unable to search symbols right now.", async (_email, request: NextRequest) =>
  NextResponse.json<SymbolsResponse>({ results: await searchSymbols(String(request.nextUrl.searchParams.get("q") ?? ""), 40) }),
);
