import "server-only";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/server/auth";
import type { ApiError } from "@/contracts/api";

// Shared plumbing for the /api route handlers, so each route is only:
// parse the request → call a service → return JSON.

type AppSession = { user?: { email?: string | null } } | null;

/** The signed-in user's email, or null. */
export async function sessionEmail(): Promise<string | null> {
  const session = (await getServerSession(authOptions as never)) as AppSession;
  return session?.user?.email ?? null;
}

export const unauthorized = () => NextResponse.json<ApiError>({ error: "Unauthorized" }, { status: 401 });

/**
 * Wraps a handler: 401 without a session; a thrown error is logged and becomes
 * `{ error: failMessage }` with status 500 (or `failBody` when the route has its own error shape).
 */
export function authed<Args extends unknown[]>(
  name: string,
  failMessage: string,
  handler: (email: string, ...args: Args) => Promise<Response>,
  failBody?: () => object,
) {
  return async (...args: Args): Promise<Response> => {
    try {
      const email = await sessionEmail();
      if (!email) return unauthorized();
      return await handler(email, ...args);
    } catch (error) {
      console.error(`${name} route error`, error);
      return NextResponse.json(failBody?.() ?? ({ error: failMessage } satisfies ApiError), { status: 500 });
    }
  };
}

/** "a, B,b" → ["A", "B"]: trimmed, upper-cased, de-duplicated, capped. */
export function symbolList(value: string | null, max: number): string[] {
  return [
    ...new Set(
      String(value ?? "")
        .split(",")
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  ].slice(0, max);
}
