import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { HubClient, HubError, parseRetryAfter } from "./client";
import { hubConfig } from "./config";

const KEY = "mdh_secret-key-123";
const config = { url: "http://hub.test", key: KEY, timeoutMs: 5_000 };

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fetch that answers from a script and records requests; a sleep that records waits. */
function fakeHub(replies: Reply[]) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const waits: number[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: init?.headers as Record<string, string> });
    const reply = replies.shift() ?? { status: 500, body: { error: "no more replies", code: "test" } };
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
  }) as typeof globalThis.fetch;
  const client = new HubClient(config, { fetch, sleep: async (ms) => void waits.push(ms), backoffMs: 100 });
  return { client, requests, waits };
}

describe("hubConfig", () => {
  it("is off without both HUB_URL and HUB_KEY", () => {
    expect(hubConfig({})).toBeNull();
    expect(hubConfig({ HUB_URL: "http://hub.test" })).toBeNull();
    expect(hubConfig({ HUB_KEY: KEY })).toBeNull();
  });

  it("normalises the URL, drops credentials in it and reads the timeout", () => {
    expect(hubConfig({ HUB_URL: "https://user:pw@hub.example.com/", HUB_KEY: ` ${KEY} `, HUB_TIMEOUT_MS: "12000" })).toEqual({ url: "https://hub.example.com", key: KEY, timeoutMs: 12_000 });
    expect(hubConfig({ HUB_URL: "http://127.0.0.1:8787", HUB_KEY: KEY })?.timeoutMs).toBe(30_000);
    expect(hubConfig({ HUB_URL: "ftp://hub", HUB_KEY: KEY })).toBeNull();
  });
});

describe("HubClient requests", () => {
  it("sends the key as a bearer token and encodes symbols", async () => {
    const { client, requests } = fakeHub([{ status: 200, body: { quotes: [], missing: [] } }]);
    await client.quotes(["M&M", "SBIN"]);
    expect(requests[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(new URL(requests[0].url).searchParams.get("symbols")).toBe("M&M,SBIN");
    expect(requests[0].url).toContain("M%26M");
  });

  it("retries 5xx and network errors with doubling back-off", async () => {
    const { client, requests, waits } = fakeHub([
      { status: 502, body: { error: "bad gateway", code: "upstream" } },
      new TypeError("fetch failed"),
      { status: 200, body: { service: "market-data-hub", version: "0.1.0", broker: { configured: true, connected: true } } },
    ]);
    const status = await client.get<{ version: string }>("/v1/status");
    expect(status.version).toBe("0.1.0");
    expect(requests).toHaveLength(3);
    expect(waits).toEqual([100, 200]);
  });

  it("waits what Retry-After asks on 429", async () => {
    const { client, waits } = fakeHub([{ status: 429, body: { error: "slow down", code: "rate_limited" }, headers: { "Retry-After": "3" } }, { status: 200, body: { lots: {}, count: 0 } }]);
    await client.lots();
    expect(waits).toEqual([3_000]);
  });

  it("fails at once when Retry-After is longer than it may wait, or retries run out", async () => {
    const long = fakeHub([{ status: 503, body: { error: "broker down", code: "not_ready" }, headers: { "Retry-After": "60" } }]);
    await expect(long.client.foBan()).rejects.toMatchObject({ status: 503, code: "not_ready", retryAfterMs: 60_000 });
    expect(long.waits).toEqual([]);

    const flaky = fakeHub([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 200, body: {} }]);
    await expect(flaky.client.foBan()).rejects.toBeInstanceOf(HubError);
    expect(flaky.requests).toHaveLength(3); // first try + 2 retries
  });

  it("doesn't retry client errors", async () => {
    const { client, requests } = fakeHub([{ status: 404, body: { error: "Unknown symbol NEWCO.", code: "unknown_symbol" } }]);
    await expect(client.candles("NEWCO", "1d", 0)).rejects.toThrow("Market Data Hub 404 unknown_symbol: Unknown symbol NEWCO.");
    expect(requests).toHaveLength(1);
  });

  it("returns a 503 that carries stored candles as a partial answer, without retrying", async () => {
    const { client, requests } = fakeHub([
      { status: 503, headers: { "Retry-After": "60" }, body: { error: "The broker is unavailable (budget); showing what is stored.", code: "broker_unavailable", reason: "budget", symbol: "SBIN", tf: "1d", complete: false, candles: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }] } },
    ]);
    const answer = await client.candles("SBIN", "1d", 0);
    expect(requests).toHaveLength(1);
    expect(answer.candles).toHaveLength(1);
    expect(answer.partial).toMatchObject({ code: "broker_unavailable", reason: "budget" });
  });

  it("asks for quotes in batches of 100", async () => {
    const symbols = Array.from({ length: 230 }, (_, index) => `S${index}`);
    const { client, requests } = fakeHub([0, 1, 2].map((batch) => ({ status: 200, body: { quotes: [{ symbol: `S${batch}`, ltp: 1 }], missing: [] } })));
    const answer = await client.quotes(symbols);
    expect(requests.map((request) => new URL(request.url).searchParams.get("symbols")!.split(",").length)).toEqual([100, 100, 30]);
    expect(answer.quotes).toHaveLength(3);
  });
});

describe("HubClient never reveals the key", () => {
  it("scrubs it from error messages, even when the hub echoes it", async () => {
    const { client } = fakeHub([{ status: 401, body: { error: `bad key ${KEY}`, code: "unauthorized" } }, new TypeError(`connect failed for ${KEY}`), new TypeError("x"), new TypeError("y")]);
    const first = (await client.status().catch((error: Error) => error)) as Error;
    expect(first.message).toContain("401 unauthorized");
    expect(first.message).not.toContain(KEY);
    const second = (await client.lots().catch((error: Error) => error)) as Error;
    expect(second.message).toContain("network error");
    expect(second.message).not.toContain(KEY);
  });

  it("doesn't print it when the client itself is logged", () => {
    const { client } = fakeHub([]);
    expect(JSON.stringify(client)).not.toContain(KEY);
    expect(inspect(client, { depth: 5, showHidden: true })).not.toContain(KEY);
    expect(String(Object.values(client))).not.toContain(KEY);
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("10")).toBe(10_000);
    expect(parseRetryAfter(new Date(61_000).toUTCString(), 1_000)).toBe(60_000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});
