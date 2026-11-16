import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Tick } from "@/contracts/api";

// The real wiring (src/server/data/index.ts) gets history, quotes and live
// prices from the Market Data Hub only, and falls back to labelled sample data
// without one. The hub is a fake fetch; any other request fails the test. No network.

// Keep the test off disk: a pass-through history store.
vi.mock("@/server/data/historyStore", () => ({
  getHistory: async ({ from, download }: { from: number; download: (from: number) => Promise<{ candles: unknown[] }> }) => (await download(from)).candles,
  peekHistory: async () => null,
}));

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
    const symbol = url.searchParams.get("symbol");
    const tf = url.searchParams.get("tf");
    const t = tf === "1m" ? Date.UTC(2026, 10, 9, 3, 45) : Date.UTC(2026, 10, 6);
    const candles = tf === "1m" ? [0, 1, 2, 3].map((minute) => ({ t: t + minute * 60_000, o: 10 + minute, h: 20 + minute, l: 5, c: 11 + minute, v: 1 })) : [{ t, o: 1000, h: 1010, l: 990, c: 1005, v: 5, dp: 50 }];
    return json({ symbol, tf, from: 0, to: 0, complete: true, coverage: null, candles });
  }
  if (url.pathname === "/v1/quotes") {
    const symbols = url.searchParams.get("symbols")!.split(",");
    return json({ quotes: symbols.map((symbol) => ({ symbol, ltp: 1006, ch: 1, chp: 0.1, open: 1000, high: 1010, low: 990, prevClose: 1005, volume: 5, ltt: 1, ts: 1, source: "socket", ageMs: 10, stale: false })), missing: [] });
  }
  if (url.pathname === "/v1/status") {
    return json({ healthy: true, problems: [], warnings: [], service: "market-data-hub", version: "0.2.0", broker: { configured: true, connected: true, budget: { plan: "prime", usedToday: 10, dayCap: 475_000, usedThisMinute: 1, minuteCap: 400, strikes: 0 } } });
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

describe("market data from the hub", () => {
  it("builds the engine from the hub, then sample data", async () => {
    const { dataEngine } = await import("@/server/data");
    expect(dataEngine().sources.map((source) => source.id)).toEqual(["hub", "sample"]);
  });

  it("gets history and quotes from the hub as plain tickers, with the key as a bearer token", async () => {
    const { dataEngine } = await import("@/server/data");
    const history = await dataEngine().history({ symbol: "NSE:SBIN-EQ", interval: "1d", from: 0, kinds: ["broker"] });
    expect(history.source?.id).toBe("hub");
    expect(history.candles[0]).toMatchObject({ date: "2026-11-06T00:00:00.000Z", close: 1005 });
    const quotes = await dataEngine().quotes(["SBIN", "NSE:SBIN26NOVFUT"], { maxAgeMs: 0 });
    expect(quotes).toEqual([expect.objectContaining({ symbol: "SBIN", ltp: 1006, source: "hub" }), expect.objectContaining({ symbol: "NSE:SBIN26NOVFUT", source: "hub" })]);
    expect(requests.find((request) => request.path === "/v1/candles")!.query.get("symbol")).toBe("SBIN");
    expect(requests.find((request) => request.path === "/v1/quotes")!.query.get("symbols")).toBe("SBIN,SBIN26NOVFUT");
    expect(requests.every((request) => request.auth === `Bearer ${KEY}`)).toBe(true);
  });

  it("builds 3-minute candles from the hub's 1-minute ones", async () => {
    const { dataEngine } = await import("@/server/data");
    const answer = await dataEngine().history({ symbol: "SBIN", interval: "3m", from: Date.now() - 86_400_000, kinds: ["broker"] });
    expect(requests.at(-1)!.query.get("tf")).toBe("1m");
    expect(answer.candles).toEqual([
      { date: new Date(Date.UTC(2026, 10, 9, 3, 45)).toISOString(), open: 10, high: 22, low: 5, close: 13, volume: 3 },
      { date: new Date(Date.UTC(2026, 10, 9, 3, 48)).toISOString(), open: 13, high: 23, low: 5, close: 14, volume: 1 },
    ]);
  });

  it("feeds the market stream from the hub's SSE stream, futures included", async () => {
    const { marketStream } = await import("@/server/data");
    const stream = marketStream();
    const ticks: Tick[] = [];
    const stop = stream.onTick((tick) => ticks.push(tick));
    const status = await stream.subscribe(["SBIN", "SBIN26NOVFUT"]);
    expect(status.live).toEqual(["SBIN", "SBIN26NOVFUT"]);
    await until(() => requests.some((request) => request.path === "/v1/stream") && pushToStream !== null);
    expect(requests.find((request) => request.path === "/v1/stream")!.query.get("symbols")).toBe("SBIN,SBIN26NOVFUT");
    pushToStream!(`id: 7\nevent: tick\ndata: ${JSON.stringify({ symbol: "SBIN26NOVFUT", ltp: 1011, ch: 6, chp: 0.6, open: 1000, high: 1012, low: 990, prevClose: 1005, volume: 9, ltt: 7, ts: 8, source: "socket" })}\n\n`);
    await until(() => ticks.length > 0);
    expect(ticks.at(-1)).toMatchObject({ symbol: "SBIN26NOVFUT", ltp: 1011, source: "hub" });
    stream.unsubscribe(["SBIN", "SBIN26NOVFUT"]);
    stop();
  });

  it("paces work from the hub's broker budget", async () => {
    const { hubHealth } = await import("@/server/providers/hub");
    await hubHealth({ wait: true });
    const { budgetFor, planLimits } = await import("@/server/providers/hub/budget");
    expect(planLimits().name).toBe("prime");
    expect(budgetFor("background").remainingToday).toBe(Math.floor(475_000 * 0.7) - 10);
  });

  it("has only labelled sample data without the hub settings, and says to connect one", async () => {
    vi.stubEnv("HUB_URL", "");
    const { dataEngine } = await import("@/server/data");
    expect(dataEngine().sources.map((source) => source.id)).toEqual(["sample"]);
    const before = requests.length;
    const answer = await dataEngine().history({ symbol: "SBIN", interval: "1d", from: Date.now() - 30 * 86_400_000 });
    expect(answer.source?.kind).toBe("sample");
    expect(await dataEngine().quotes(["SBIN"], { maxAgeMs: 0 })).toEqual([]);
    expect(requests.length).toBe(before); // nothing was fetched from anywhere
    vi.stubEnv("HUB_URL", "http://hub.test");
  });
});
