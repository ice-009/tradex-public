import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/server/auth";
import { prisma } from "@/server/db/prisma";
import { refreshFyersAccessToken, validateFyersAccessToken } from "@/server/providers/fyers/client";
import { getFyersAccessToken } from "@/server/providers/fyers/auth";
import { hubMode } from "@/server/providers/hub";
import { hubBrokerStatus } from "@/server/services/marketConnection";

type AppSession = { user?: { email?: string | null } } | null;

export async function GET() {
  try {
    const session = (await getServerSession(authOptions as never)) as AppSession;
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Connected to a Market Data Hub: the hub owns the broker login; never touch Fyers here.
    if (hubMode()) {
      return NextResponse.json(await hubBrokerStatus());
    }

    // If unattended TOTP auto-login is configured, the app is connected via the
    // deployment's Fyers account regardless of any per-user OAuth token.
    const autoToken = await getFyersAccessToken();
    if (autoToken) {
      return NextResponse.json({ connected: true, mode: "auto" });
    }

    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { brokerAccessToken: true, brokerRefreshToken: true },
    });

    if (!user?.brokerAccessToken) {
      return NextResponse.json({ connected: false });
    }

    const isValid = await validateFyersAccessToken(user.brokerAccessToken);
    if (isValid) {
      return NextResponse.json({ connected: true });
    }

    // Unlike Upstox, Fyers issues a refresh token — try it transparently
    // before reporting disconnected, so the user isn't forced through OAuth
    // every day. If Fyers requires a trading PIN to refresh (unverified),
    // this will simply fail and fall through to connected: false.
    if (user.brokerRefreshToken) {
      const refreshed = await refreshFyersAccessToken(user.brokerRefreshToken);
      if (refreshed) {
        await prisma.user.update({
          where: { email: session.user.email },
          data: { brokerAccessToken: refreshed.accessToken, brokerTokenExpiresAt: refreshed.expiresAt },
        });
        return NextResponse.json({ connected: true });
      }
    }

    return NextResponse.json({ connected: false });
  } catch (error) {
    console.error("Fyers status check error:", error);
    return NextResponse.json({ connected: false, error: "Failed to check status" }, { status: 500 });
  }
}
