import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/server/auth";
import { prisma } from "@/server/db/prisma";
import { clearFyersTokenFailureReason, validateFyersAccessToken } from "@/server/providers/fyers/client";

type AppSession = { user?: { email?: string | null } } | null;

function normalizeToken(value: string) {
  return value.trim().replace(/\s+/g, "");
}

export async function POST(request: NextRequest) {
  try {
    const session = (await getServerSession(authOptions as never)) as AppSession;
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as { accessToken?: string };
    const accessToken = normalizeToken(body.accessToken ?? "");
    const forceSave = Boolean((body as { force?: boolean }).force);

    if (!accessToken) {
      return NextResponse.json({ error: "Access token is required." }, { status: 400 });
    }

    clearFyersTokenFailureReason(accessToken);

    const isValid = forceSave ? true : await validateFyersAccessToken(accessToken);
    if (!isValid) {
      return NextResponse.json(
        { error: "Fyers rejected this token. Please paste a fresh access token or reconnect with OAuth." },
        { status: 400 },
      );
    }

    // A manually pasted token has no known refresh token or expiry, so those
    // fields are cleared rather than left stale from a prior OAuth login.
    await prisma.user.update({
      where: { email: session.user.email },
      data: { brokerAccessToken: accessToken, brokerRefreshToken: null, brokerTokenExpiresAt: null },
    });

    clearFyersTokenFailureReason(accessToken);

    return NextResponse.json({ success: true, connected: true, forced: forceSave });
  } catch (error) {
    console.error("Fyers token save error:", error);
    return NextResponse.json({ error: "Unable to save the Fyers token right now." }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const session = (await getServerSession(authOptions as never)) as AppSession;
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await prisma.user.update({
      where: { email: session.user.email },
      data: { brokerAccessToken: null, brokerRefreshToken: null, brokerTokenExpiresAt: null },
    });

    return NextResponse.json({ success: true, connected: false });
  } catch (error) {
    console.error("Fyers token clear error:", error);
    return NextResponse.json({ error: "Unable to clear the Fyers token right now." }, { status: 500 });
  }
}
