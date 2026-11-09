import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Tick } from "@/contracts/api";

// With HUB_URL and HUB_KEY set, the real wiring (src/server/data/index.ts) must
// get history, quotes and live prices from the hub and never run any Fyers code.
// Every Fyers module is replaced by spies, and the Fyers SDK by a module that
// records being loaded; the hub is a fake fetch. No network.

const fyers = vi.hoisted(() => {
  const calls: string[] = [];
  const spy = (name: string) =>
    (...args: unknown[]) => {
      calls.push(name);
      void args;
      throw new Error(`Fyers code was called: ${name}`);
    };
  return { calls, spy, sdkLoaded: false };
});

vi.mock("fyers-api-v3", () => {
  fyers.sdkLoaded = true;
  return { fyersDataSocket: { getInstance: fyers.spy("sdk.getInstance") } };
});
vi.mock("@/server/providers/fyers/auth", () => ({ getFyersAccessToken: fyers.spy("getFyersAccessToken"), loginFyersViaTotp: fyers.spy("loginFyersViaTotp") }));
vi.mock("@/server/providers/fyers/budget", () => ({
  BudgetExhaustedError: class extends Error {},
  asPriority: fyers.spy("budget.asPriority"),
  budgetFor: fyers.spy("budget.budgetFor"),
  fyersPlan: fyers.spy("budget.fyersPlan"),
  budgetSnapshot: fyers.spy("budget.budgetSnapshot"),
  acquireFyersSlot: fyers.spy("budget.acquireFyersSlot"),
  reportRateLimited: fyers.spy("budget.reportRateLimited"),
}));
vi.mock("@/server/providers/fyers/client", () => ({
  downloadFyersHistory: fyers.spy("downloadFyersHistory"),
  fetchFyersQuotes: fyers.spy("fetchFyersQuotes"),
  fyersHistoryCacheKey: fyers.spy("fyersHistoryCacheKey"),
  fyersHistoryWindowDays: fyers.spy("fyersHistoryWindowDays"),
  getFyersTokenFailureReason: fyers.spy("getFyersTokenFailureReason"),
}));
vi.mock("@/server/providers/fyers/stream", () => ({ fyersStream: fyers.spy("fyersStream") }));
vi.mock("@/server/db/prisma", () => ({ prisma: new Proxy({}, { get: (_target, name) => fyers.spy(`prisma.${String(name)}`) }) }));

// Keep the test off disk: pass-through history store, simple stand-ins for the other sources.
vi.mock("@/server/data/historyStore", () => ({
  getHistory: async ({ from, download }: { from: number; download: (from: number) => Promise<{ candles: unknown[] }> }) => (await download(from)).candles,
  peekHistory: async () => null,
}));
vi.mock("@/server/data/sources/eod", () => ({ eodSource: { id: "eod", label: "EOD", kind: "eod", unavailable: async () => null } }));
vi.mock("@/server/data/sources/sample", () => ({ sampleSource: { id: "sample", label: "Sample", kind: "sample", unavailable: async () => null } }));

const KEY = "mdh_integration-key";
const encoder = new TextEncoder();
const requests: Array<{ path: string; query: URLSearchParams; auth: string | undefined }> = [];
let pushToStream: ((text: string) => void) | null = null;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
  requests.push({ path: url.pathname, query: url.searchParams, auth });
  if (url.origin !== "http://hub.test") throw new Error(`unexpected request to ${url.origin}`);
  if (url.pathname === "/v1/candles") {
    return json({ symbol: "SBIN", tf: "1d", from: 0, to: 0, complete: true, coverage: null, candles: [{ t: Date.UTC(2026, 10, 6), o: 1000, h: 1010, l: 990, c: 1005, v: 5, dp: 50 }] });
  }
  if (url.pathname === "/v1/quotes") {
    return json({ quotes: [{ symbol: "SBIN", ltp: 1006, ch: 1, chp: 0.1, open: 1000, high: 1010, low: 990, prevClose: 1005, volume: 5, ltt: 1, ts: 1, source: "socket", ageMs: 10, stale: false }], missing: [] });
  }
  if (url.pathname === "/v1/stream") {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        pushToStream = (text) => controller.enqueue(encoder.encode(text));
        pushToStream('retry: 3000\nevent: status\ndata: {"mode":"socket"}\n\n');
        init?.signal?.addEventListener("abort", () => {
          try {
            controller.error(new Error("aborted"));
          } catch {
            // already closed
          }
        });
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
  return new Response(JSON.stringify({ error: "not found", code: "not_found" }), { status: 404 });
};

beforeAll(() => {
  vi.stubEnv("HUB_URL", "http://hub.test");
  vi.stubEnv("HUB_KEY", KEY);
  vi.stubEnv("DATA_SOURCES", "");
  vi.stubGlobal("fetch", fakeFetch);
});

afterAll(async () => {
  const { hubStream } = await import("@/server/providers/hub");
  hubStream()?.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function until(condition: () => boolean, ms = 3_000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("hub mode", () => {
  it("builds the engine with the hub in place of Fyers", async () => {
    const { dataEngine } = await import("@/server/data");
    expect(dataEngine().sources.map((source) => source.id)).toEqual(["hub", "eod", "sample"]);
  });

  it("gets history and quotes from the hub, with the key as a bearer token", async () => {
    const { dataEngine } = await import("@/server/data");
    const history = await dataEngine().history({ symbol: "SBIN", interval: "1d", from: 0, kinds: ["broker"] });
    expect(history.source?.id).toBe("hub");
    expect(history.candles[0]).toMatchObject({ date: "2026-11-06T00:00:00.000Z", close: 1005 });
    const quotes = await dataEngine().quotes(["SBIN"], { maxAgeMs: 0 });
    expect(quotes).toEqual([expect.objectContaining({ symbol: "SBIN", ltp: 1006, source: "hub" })]);
    expect(requests.map((request) => request.path)).toEqual(["/v1/candles", "/v1/quotes"]);
    expect(requests.every((request) => request.auth === `Bearer ${KEY}`)).toBe(true);
  });

  it("feeds the market stream from the hub's SSE stream", async () => {
    const { marketStream } = await import("@/server/data");
    const stream = marketStream();
    const ticks: Tick[] = [];
    const stop = stream.onTick((tick) => ticks.push(tick));
    const status = await stream.subscribe(["SBIN", "NSE:SBIN26NOVFUT"]);
    expect(status.live).toEqual(["SBIN"]);
    await until(() => requests.some((request) => request.path === "/v1/stream") && pushToStream !== null);
    expect(requests.find((request) => request.path === "/v1/stream")!.query.get("symbols")).toBe("SBIN");
    pushToStream!(`id: 7\nevent: tick\ndata: ${JSON.stringify({ symbol: "SBIN", ltp: 1011, ch: 6, chp: 0.6, open: 1000, high: 1012, low: 990, prevClose: 1005, volume: 9, ltt: 7, ts: 8, source: "socket" })}\n\n`);
    await until(() => ticks.length > 0);
    expect(ticks.at(-1)).toMatchObject({ symbol: "SBIN", ltp: 1011, source: "hub" });
    stream.unsubscribe(["SBIN", "NSE:SBIN26NOVFUT"]);
    stop();
  });

  it("paces work from the hub's budget without touching Tradex's Fyers budget", async () => {
    const { asPriority, budgetFor, marketDataVia, planLimits } = await import("@/server/providers/marketBudget");
    expect(marketDataVia()).toBe("hub");
    expect(await asPriority("background", async () => "ran")).toBe("ran");
    expect(budgetFor("background").remainingToday).toBeGreaterThan(0);
    expect(planLimits().name).toBe("standard");
  });

  it("never ran or loaded any Fyers code", () => {
    expect(fyers.calls).toEqual([]);
    expect(fyers.sdkLoaded).toBe(false);
  });

  it("goes back to Fyers without the hub settings (still without running Fyers code just to build it)", async () => {
    vi.stubEnv("HUB_URL", "");
    const { dataEngine } = await import("@/server/data");
    expect(dataEngine().sources.map((source) => source.id)).toEqual(["fyers", "eod", "sample"]);
    expect(fyers.calls).toEqual([]);
    // …and the spies do catch Fyers being used: standalone, a quote asks Fyers for its login.
    await dataEngine().quotes(["SBIN"], { maxAgeMs: 0, kinds: ["broker"] });
    expect(fyers.calls).toContain("getFyersAccessToken");
    vi.stubEnv("HUB_URL", "http://hub.test");
  });
});
