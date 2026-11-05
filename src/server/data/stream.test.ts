import { describe, expect, it } from "vitest";
import type { Tick } from "@/contracts/api";
import { DataEngine } from "./engine";
import { MarketStream } from "./stream";
import type { DataSource, SourceQuote, SourceTick } from "./types";

const quote = (symbol: string, ltp: number): SourceQuote => ({ symbol, ltp, ch: 0, chp: 0, open: ltp, high: ltp, low: ltp, prevClose: ltp, volume: 1 });
const tick = (symbol: string, ltp: number): SourceTick => ({ ...quote(symbol, ltp), ltt: 0, ts: 0 });

/** A broker with a socket we can connect/disconnect, a symbol limit, and pollable quotes. */
function fakeBroker(maxSymbols = 2) {
  const state = { connected: true, subscribed: new Set<string>(), listeners: new Set<(t: SourceTick) => void>(), prices: new Map<string, number>(), quoteCalls: 0, restarts: 0 };
  const source: DataSource = {
    id: "broker",
    label: "Broker",
    kind: "broker",
    unavailable: async () => null,
    quotes: {
      delayed: false,
      async fetch(symbols) {
        state.quoteCalls += 1;
        return symbols.map((symbol) => quote(symbol, state.prices.get(symbol) ?? 100));
      },
    },
    stream: {
      maxSymbols,
      start: async () => state.connected,
      isConnected: () => state.connected,
      async subscribe(symbols) {
        symbols.forEach((symbol) => state.subscribed.add(symbol));
        return symbols;
      },
      unsubscribe: (symbols) => symbols.forEach((symbol) => state.subscribed.delete(symbol)),
      onTick(listener) {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      async restart() {
        state.restarts += 1;
        return state.connected;
      },
    },
  };
  const push = (t: SourceTick) => state.listeners.forEach((listener) => listener(t));
  return { source, state, push };
}

function streamFor(sources: DataSource[], pollMs = 15_000, clock?: { now: number; open: boolean }) {
  const engine = new DataEngine(sources, { historyStore: { get: async () => [] }, log: () => {}, ...(clock ? { now: () => clock.now } : {}) });
  // Manual timers: tests drive polling with pollOnce() and the watchdog with check().
  const stream = new MarketStream(engine, {
    pollMs,
    setInterval: () => 1,
    clearInterval: () => {},
    log: () => {},
    isMarketOpen: () => clock?.open ?? false,
    ...(clock ? { now: () => clock.now } : {}),
  });
  const ticks: Tick[] = [];
  stream.onTick((t) => ticks.push(t));
  return { stream, ticks };
}

describe("MarketStream", () => {
  it("streams from the socket, highest priority first, and polls what doesn't fit", async () => {
    const broker = fakeBroker(2);
    const { stream } = streamFor([broker.source]);
    const status = await stream.subscribe(["CHART", "ROW1", "ROW2"]);
    expect(status).toMatchObject({ mode: "polling", live: ["CHART", "ROW1"], polled: ["ROW2"] });
    expect([...broker.state.subscribed]).toEqual(["CHART", "ROW1"]);
  });

  it("forwards socket ticks with the source id, only for subscribed symbols", async () => {
    const broker = fakeBroker(5);
    const { stream, ticks } = streamFor([broker.source]);
    await stream.subscribe(["SBIN"]);
    broker.push(tick("SBIN", 101));
    broker.push(tick("OTHER", 5));
    expect(ticks).toEqual([{ ...tick("SBIN", 101), source: "broker" }]);
  });

  it("polls quotes into ticks when there is no socket, only on change", async () => {
    const broker = fakeBroker(5);
    broker.state.connected = false;
    const { stream, ticks } = streamFor([broker.source], 2_000); // polls accept quotes ≤ 1 s old
    const status = await stream.subscribe(["SBIN"]);
    expect(status).toMatchObject({ mode: "polling", live: [], polled: ["SBIN"] });
    await stream.pollOnce(); // the poll subscribe started
    await new Promise((r) => setTimeout(r, 1_100));
    await stream.pollOnce(); // same price: no new tick
    broker.state.prices.set("SBIN", 105);
    await new Promise((r) => setTimeout(r, 1_100)); // past the engine's quote cache
    await stream.pollOnce();
    expect(ticks.map((t) => [t.ltp, t.polled, t.source])).toEqual([
      [100, true, "broker"],
      [105, true, "broker"],
    ]);
  });

  it("moves polled symbols onto the socket when it reconnects", async () => {
    const broker = fakeBroker(5);
    broker.state.connected = false;
    const { stream } = streamFor([broker.source]);
    await stream.subscribe(["SBIN", "TCS"]);
    await stream.pollOnce(); // the poll subscribe started
    broker.state.connected = true;
    await stream.pollOnce();
    expect(stream.status()).toMatchObject({ mode: "live", live: ["SBIN", "TCS"], polled: [] });
  });

  it("keeps a symbol while any consumer wants it", async () => {
    const broker = fakeBroker(5);
    const { stream } = streamFor([broker.source]);
    await stream.subscribe(["SBIN"]);
    await stream.subscribe(["SBIN", "TCS"]);
    stream.unsubscribe(["SBIN"]);
    expect([...broker.state.subscribed].sort()).toEqual(["SBIN", "TCS"]);
    stream.unsubscribe(["SBIN", "TCS"]);
    expect([...broker.state.subscribed]).toEqual([]);
  });

  it("is offline with no source at all, or when the only live source is down", async () => {
    expect(await streamFor([]).stream.subscribe(["SBIN"])).toMatchObject({ mode: "offline", source: null });
    const broker = fakeBroker(5);
    broker.state.connected = false;
    broker.source.unavailable = async () => "logged out";
    expect(await streamFor([broker.source]).stream.subscribe(["SBIN"])).toMatchObject({ mode: "offline", source: null });
  });

  describe("watchdog (market hours)", () => {
    it("restarts a connected-but-silent socket and polls its symbols meanwhile, then goes back to live", async () => {
      const clock = { now: 1_000_000, open: true };
      const broker = fakeBroker(5);
      const { stream, ticks } = streamFor([broker.source], 15_000, clock);
      await stream.subscribe(["SBIN"]);
      expect(stream.status()).toMatchObject({ mode: "live", live: ["SBIN"] });

      clock.now += 61_000; // a minute with no ticks
      await stream.check();
      expect(broker.state.restarts).toBe(1);
      expect(stream.status()).toMatchObject({ mode: "polling", polled: ["SBIN"] });

      clock.now += 61_000; // still silent after the restart: polled prices keep coming
      await stream.check();
      expect(ticks.at(-1)).toMatchObject({ symbol: "SBIN", polled: true, source: "broker" });

      broker.push(tick("SBIN", 101)); // socket is back
      expect(stream.status()).toMatchObject({ mode: "live", live: ["SBIN"] });
      expect(ticks.at(-1)).toMatchObject({ ltp: 101, source: "broker" });
      expect(ticks.at(-1)?.polled).toBeUndefined();
    });

    it("restarts at most once a minute", async () => {
      const clock = { now: 1_000_000, open: true };
      const broker = fakeBroker(5);
      const { stream } = streamFor([broker.source], 15_000, clock);
      await stream.subscribe(["SBIN"]);
      clock.now += 61_000;
      await stream.check();
      clock.now += 30_000;
      await stream.check();
      expect(broker.state.restarts).toBe(1);
      clock.now += 31_000;
      await stream.check();
      expect(broker.state.restarts).toBe(2);
    });

    it("leaves a quiet socket alone outside market hours", async () => {
      const clock = { now: 1_000_000, open: false };
      const broker = fakeBroker(5);
      const { stream } = streamFor([broker.source], 15_000, clock);
      await stream.subscribe(["SBIN"]);
      clock.now += 10 * 60_000;
      await stream.check();
      expect(broker.state.restarts).toBe(0);
      expect(stream.status()).toMatchObject({ mode: "live" });
    });

    it("polls one symbol that stopped ticking while others still tick", async () => {
      const clock = { now: 1_000_000, open: true };
      const broker = fakeBroker(5);
      const { stream } = streamFor([broker.source], 15_000, clock);
      await stream.subscribe(["SBIN", "ILLIQUID"]);
      for (let i = 0; i < 4; i += 1) {
        clock.now += 50_000;
        broker.push(tick("SBIN", 100 + i)); // the socket is alive
      }
      expect(stream.status()).toMatchObject({ live: ["SBIN"], polled: ["ILLIQUID"] });
      expect(broker.state.restarts).toBe(0);
    });
  });
});
