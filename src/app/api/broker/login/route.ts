import { NextResponse } from "next/server";
import { hubManagesBroker } from "@/server/http";
import { hubMode } from "@/server/providers/hub";
import { getFyersAuthURL } from "@/server/providers/fyers/client";

// The auth URL embeds FYERS_CLIENT_ID, a server-only env var, so it must be
// built here rather than in the client component (see BrokerConnect.tsx).
export async function GET() {
  if (hubMode()) return hubManagesBroker();
  return NextResponse.redirect(getFyersAuthURL());
}
