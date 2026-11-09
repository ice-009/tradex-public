import { NextRequest, NextResponse } from "next/server";
import { hubManagesBroker } from "@/server/http";
import { hubMode } from "@/server/providers/hub";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/server/auth";
import { exchangeFyersAuthCode } from "@/server/providers/fyers/client";
import { prisma } from "@/server/db/prisma";

type AppSession = { user?: { email?: string | null } } | null;

export async function GET(request: NextRequest) {
  try {
    if (hubMode()) return hubManagesBroker();
    const { searchParams } = new URL(request.url);
    const code = searchParams.get("auth_code") ?? searchParams.get("code");

    if (!code) {
      return NextResponse.json({ error: "Missing authorization code" }, { status: 400 });
    }

    const session = (await getServerSession(authOptions as never)) as AppSession;
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { accessToken, refreshToken, expiresAt } = await exchangeFyersAuthCode(code);

    await prisma.user.update({
      where: { email: session.user.email },
      data: {
        brokerAccessToken: accessToken,
        brokerRefreshToken: refreshToken,
        brokerTokenExpiresAt: expiresAt,
      },
    });

    return NextResponse.redirect(new URL("/", request.url));
  } catch (error) {
    console.error("Fyers callback error:", error);
    return NextResponse.json(
      { error: "Failed to complete Fyers authentication" },
      { status: 500 }
    );
  }
}
