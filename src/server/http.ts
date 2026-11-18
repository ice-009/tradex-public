import "server-only";

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/server/auth";
import type { ApiError } from "@/contracts/api";
import { log, withRequestId } from "@/server/log";
import { requestMetrics } from "@/server/metrics";

// Shared plumbing for the /api route handlers, so each route is only:
// parse the request → call a service → return JSON.
//
// Every request through `authed()` gets a request id (the caller's
// `X-Request-Id` when it sends a sane one, otherwise a new UUID): it is
// returned as the `X-Request-Id` header, put on every log line written while
// the request is handled (src/server/log.ts), and included in a 500's body, so
// "it failed" can be matched to the server's log.

type AppSession = { user?: { email?: string | null } } | null;

/** The signed-in user's email, or null. */
export async function sessionEmail(): Promise<string | null> {
  const session = (await getServerSession(authOptions as never)) as AppSession;
  return session?.user?.email ?? null;
}

export const unauthorized = () => NextResponse.json<ApiError>({ error: "Unauthorized" }, { status: 401 });

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;

/** The caller's X-Request-Id when it looks like an id, otherwise a new one. */
export function requestIdFor(headers: Headers | null | undefined): string {
  const given = headers?.get("x-request-id")?.trim();
  return given && REQUEST_ID.test(given) ? given : randomUUID();
}

/** Requests slower than this are logged at info even when they succeed. */
const SLOW_MS = 1_000;

/** Run a handler with a request id, logging and metrics around it; `check` answers 401 or lets it through. */
function instrumented<Args extends unknown[]>(
  name: string,
  failMessage: string,
  check: (request: Request | null) => Promise<string | null>,
  handler: (who: string, ...args: Args) => Promise<Response>,
  failBody?: () => object,
) {
  return async (...args: Args): Promise<Response> => {
    const request = args[0] instanceof Request ? args[0] : null;
    const requestId = requestIdFor(request?.headers);
    const started = performance.now();
    const method = request?.method ?? "GET";
    const path = request ? new URL(request.url).pathname : undefined;
    return withRequestId(requestId, async () => {
      let response: Response;
      let threw = false;
      try {
        const who = await check(request);
        response = who ? await handler(who, ...args) : unauthorized();
      } catch (error) {
        threw = true;
        log.error(`${name} failed`, { requestId, route: name, method, path, error });
        response = NextResponse.json({ ...(failBody?.() ?? ({ error: failMessage } satisfies ApiError)), requestId }, { status: 500 });
      }
      const ms = Math.round(performance.now() - started);
      try {
        response.headers.set("X-Request-Id", requestId);
      } catch {
        // immutable headers (a proxied response): the id is still in the log
      }
      requestMetrics.record(name, method, response.status, ms / 1000);
      const fields = { requestId, route: name, method, path, status: response.status, ms };
      if (threw) return response; // already logged, with the error
      if (response.status >= 500) log.warn("request failed", fields);
      else if (response.status >= 400 || ms >= SLOW_MS) log.info("request", fields);
      else log.debug("request", fields);
      return response;
    });
  };
}

/**
 * Wraps a handler: 401 without a session; a thrown error is logged and becomes
 * `{ error: failMessage, requestId }` with status 500 (or `failBody` when the route has its own error shape).
 */
export function authed<Args extends unknown[]>(
  name: string,
  failMessage: string,
  handler: (email: string, ...args: Args) => Promise<Response>,
  failBody?: () => object,
) {
  return instrumented(name, failMessage, () => sessionEmail(), handler, failBody);
}

/** True when the request carries `Authorization: Bearer <expected>` (compared in constant time). */
export function bearerMatches(request: Request | null, expected: string | undefined): boolean {
  if (!request || !expected) return false;
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return false;
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(match[1]), digest(expected));
}

/**
 * Like `authed`, for endpoints a machine reads (Prometheus): a signed-in
 * session, or `Authorization: Bearer <process.env[tokenVar]>` when that variable is set.
 * The handler gets the email, or "token" for a token caller.
 */
export function authedOrToken<Args extends unknown[]>(tokenVar: string, name: string, failMessage: string, handler: (who: string, ...args: Args) => Promise<Response>) {
  return instrumented(name, failMessage, async (request) => (bearerMatches(request, process.env[tokenVar]?.trim() || undefined) ? "token" : sessionEmail()), handler);
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
