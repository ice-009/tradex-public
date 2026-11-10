import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HubClient, type HubQuote } from "./client";
import { HubStream } from "./stream";

// The stream follower against a real HTTP server on 127.0.0.1 that speaks the
// hub's /v1/stream protocol. No outside network.

const KEY = "mdh_stream-test-key";

interface Connection {
  symbols: string[];
  lastEventId: string | undefined;
  auth: string | undefined;
  res: ServerResponse;
}

async function mockHub(handle: (connection: Connection, index: number, req: IncomingMessage) => void) {
  const connections: Connection[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const connection: Connection = {
      symbols: (url.searchParams.get("symbols") ?? "").split(",").filter(Boolean),
      lastEventId: req.headers["last-event-id"] as string | undefined,
      auth: req.headers.authorization,
      res,
    };
    connections.push(connection);
    handle(connection, connections.length - 1, req);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const client = new HubClient({ url: `http://127.0.0.1:${port}`, key: KEY, timeoutMs: 2_000 });
  return { server, client, connections };
}

const sse = (res: ServerResponse) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  res.flushHeaders();
};
const tick = (symbol: string, ltp: number, id: number) => `id: ${id}\nevent: tick\ndata: ${JSON.stringify({ symbol, ltp, ch: 0, chp: 0, open: ltp, high: ltp, low: ltp, prevClose: ltp, volume: 1, ltt: id, ts: id, source: "socket" })}\n\n`;

async function until(condition: () => boolean, ms = 3_000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function follow(client: HubClient, options: Partial<ConstructorParameters<typeof HubStream>[0]> = {}) {
  const stream = new HubStream({ open: (symbols, lastEventId, signal) => client.openStream(symbols, lastEventId, signal), minReconnectMs: 20, debounceMs: 20, log: () => {}, ...options });
  const ticks: HubQuote[] = [];
  const modes: string[] = [];
  stream.on({ tick: (quote) => ticks.push(quote), status: (status) => modes.push(status.mode) });
  cleanup.push(() => stream.close());
  return { stream, ticks, modes };
}

describe("HubStream", () => {
  it("opens one authorised stream for the symbols and delivers status and ticks", async () => {
    const hub = await mockHub(({ res }) => {
      sse(res);
      res.write('retry: 50\nevent: status\ndata: {"mode":"socket","socket":"connected"}\n\n');
      res.write('event: snapshot\ndata: {"quotes":[],"missing":[]}\n\n');
      res.write(": ping 1\n\n");
      res.write(tick("SBIN", 1008.1, 1000));
    });
    cleanup.push(() => hub.server.close());
    const { stream, ticks, modes } = follow(hub.client);
    stream.setSymbols(["SBIN", "INFY", "SBIN"]);
    await until(() => ticks.length === 1);
    expect(hub.connections).toHaveLength(1);
    expect(hub.connections[0].symbols).toEqual(["INFY", "SBIN"]);
    expect(hub.connections[0].auth).toBe(`Bearer ${KEY}`);
    expect(modes).toEqual(["socket"]);
    expect(ticks[0]).toMatchObject({ symbol: "SBIN", ltp: 1008.1 });
    expect(stream.isOpen()).toBe(true);
    expect(stream.healthy()).toBe(true);
    expect(stream.lastEventId).toBe("1000");
  });

  it("reconnects after the hub drops the stream, resuming with Last-Event-ID", async () => {
    const hub = await mockHub(({ res }, index) => {
      sse(res);
      res.write("retry: 30\n\n");
      res.write(tick("SBIN", 100 + index, 1000 + index));
      if (index === 0) res.end(); // a hub restart
    });
    cleanup.push(() => hub.server.close());
    const { stream, ticks } = follow(hub.client);
    stream.setSymbols(["SBIN"]);
    await until(() => ticks.length === 2);
    expect(hub.connections[0].lastEventId).toBeUndefined();
    expect(hub.connections[1].lastEventId).toBe("1000");
    expect(ticks.map((quote) => quote.ltp)).toEqual([100, 101]);
    expect(stream.connects).toBe(2);
  });

  it("reopens the stream with the new list when the symbols change (coalescing quick changes)", async () => {
    const hub = await mockHub(({ res }) => {
      sse(res);
      res.write(": hello\n\n");
    });
    cleanup.push(() => hub.server.close());
    const { stream } = follow(hub.client);
    stream.setSymbols(["SBIN"]);
    await until(() => stream.isOpen());
    stream.setSymbols(["SBIN", "INFY"]);
    stream.setSymbols(["SBIN", "INFY", "TCS"]);
    await until(() => hub.connections.length === 2 && stream.isOpen());
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(hub.connections.map((connection) => connection.symbols)).toEqual([["SBIN"], ["INFY", "SBIN", "TCS"]]);
  });

  it("backs off after a refused connection, reports it, and recovers", async () => {
    const hub = await mockHub(({ res }, index) => {
      if (index < 2) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid API key.", code: "unauthorized" }));
        return;
      }
      sse(res);
      res.write(tick("NIFTY", 25_000, 5));
    });
    cleanup.push(() => hub.server.close());
    const { stream, ticks } = follow(hub.client);
    stream.setSymbols(["NIFTY"]);
    await until(() => stream.lastError !== null);
    expect(stream.healthy()).toBe(false);
    expect(stream.lastError).toContain("401 unauthorized");
    expect(stream.lastError).not.toContain(KEY);
    await until(() => ticks.length === 1);
    expect(stream.healthy()).toBe(true);
    expect(stream.lastError).toBeNull();
    expect(hub.connections).toHaveLength(3);
  });

  it("treats a silent stream as dead and reconnects", async () => {
    const hub = await mockHub(({ res }, index) => {
      sse(res);
      if (index > 0) res.write(tick("SBIN", 1, 1));
      // the first connection never sends anything: no heartbeat either
    });
    cleanup.push(() => hub.server.close());
    const { stream, ticks } = follow(hub.client, { idleMs: 150 });
    stream.setSymbols(["SBIN"]);
    await until(() => stream.isOpen());
    await until(() => ticks.length === 1);
    expect(hub.connections.length).toBe(2);
    expect(stream.healthy()).toBe(true);
  });

  it("closes the connection when the last symbol goes", async () => {
    let closed = 0;
    const hub = await mockHub(({ res }, _index, req) => {
      sse(res);
      res.write(": hi\n\n");
      req.on("close", () => (closed += 1));
    });
    cleanup.push(() => hub.server.close());
    const { stream } = follow(hub.client);
    stream.setSymbols(["SBIN"]);
    await until(() => stream.isOpen());
    stream.setSymbols([]);
    await until(() => closed === 1);
    expect(stream.isOpen()).toBe(false);
    expect(hub.connections).toHaveLength(1);
  });
});
