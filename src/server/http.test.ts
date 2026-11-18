import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// authed(): request ids on the response, in the log and in a 500's body;
// authedOrToken(): a bearer token for scrapers.

const session = vi.hoisted(() => ({ value: { user: { email: "me@example.com" } } as { user: { email: string } } | null }));
vi.mock("next-auth/next", () => ({ getServerSession: async () => session.value }));
vi.mock("@/server/auth", () => ({ authOptions: {} }));

const { authed, authedOrToken, bearerMatches, requestIdFor } = await import("./http");
const { log, currentRequestId } = await import("./log");
const { requestMetrics } = await import("./metrics");

beforeEach(() => {
  session.value = { user: { email: "me@example.com" } };
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("request ids", () => {
  it("keeps a sane X-Request-Id and makes one otherwise", () => {
    expect(requestIdFor(new Headers({ "x-request-id": "abc-12345678" }))).toBe("abc-12345678");
    expect(requestIdFor(new Headers({ "x-request-id": "has spaces in it" }))).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFor(null)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns it as a header and tags the handler's log lines with it", async () => {
    let seen: string | undefined;
    const handler = authed<[Request]>("Test ok", "nope", async (email: string) => {
      seen = currentRequestId();
      return Response.json({ email });
    });
    const response = await handler(new Request("http://localhost/api/test", { headers: { "x-request-id": "caller-id-0001" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: "me@example.com" });
    expect(response.headers.get("x-request-id")).toBe("caller-id-0001");
    expect(seen).toBe("caller-id-0001");
  });

  it("answers 401 without a session", async () => {
    session.value = null;
    const response = await authed<[Request]>("Test 401", "nope", async () => Response.json({}))(new Request("http://localhost/api/test"));
    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("turns a thrown error into a 500 carrying the request id, logged with it", async () => {
    const response = await authed<[Request]>("Test boom", "Something broke.", async () => {
      throw new Error("kaboom");
    })(new Request("http://localhost/api/boom"));
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; requestId: string };
    expect(body.error).toBe("Something broke.");
    expect(body.requestId).toBe(response.headers.get("x-request-id"));
    expect(log.recent()[0]).toMatchObject({ level: "error", msg: "Test boom failed", requestId: body.requestId });
    expect(log.recent()[0].detail).toContain("kaboom");
  });

  it("records each request in the metrics", async () => {
    await authed<[Request]>("Test metrics", "nope", async () => Response.json({}))(new Request("http://localhost/api/m"));
    const [total] = requestMetrics.families();
    expect(total.samples).toContainEqual({ labels: { route: "Test metrics", method: "GET", status: "2xx" }, value: 1 });
  });
});

describe("token auth for scrapers", () => {
  const scrape = (authorization?: string) => authedOrToken<[Request]>("METRICS_TOKEN", "Test metrics auth", "nope", async (who: string) => new Response(who))(new Request("http://localhost/api/metrics", { headers: authorization ? { authorization } : {} }));

  it("accepts the token, or a session, and nothing else", async () => {
    vi.stubEnv("METRICS_TOKEN", "scrape-token-123");
    session.value = null;
    expect(await (await scrape("Bearer scrape-token-123")).text()).toBe("token");
    expect((await scrape("Bearer wrong")).status).toBe(401);
    expect((await scrape()).status).toBe(401);
    session.value = { user: { email: "me@example.com" } };
    expect(await (await scrape()).text()).toBe("me@example.com");
  });

  it("never matches when no token is configured", () => {
    expect(bearerMatches(new Request("http://x", { headers: { authorization: "Bearer " } }), undefined)).toBe(false);
    expect(bearerMatches(new Request("http://x", { headers: { authorization: "Bearer abc" } }), "")).toBe(false);
  });
});
