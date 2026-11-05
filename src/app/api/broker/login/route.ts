import { NextResponse } from "next/server";
import { getFyersAuthURL } from "@/server/providers/fyers/client";

// The auth URL embeds FYERS_CLIENT_ID, a server-only env var, so it must be
// built here rather than in the client component (see BrokerConnect.tsx).
export async function GET() {
  return NextResponse.redirect(getFyersAuthURL());
}
