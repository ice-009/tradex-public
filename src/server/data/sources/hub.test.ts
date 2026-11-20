import { describe, expect, it } from "vitest";
import type { HubCandles, HubCandlesBatch, HubQuote, HubQuotes } from "@/server/providers/hub/client";
import type { HubStream, HubStreamListener } from "@/server/providers/hub/stream";
import { SourceSkip, type SourceTick } from "../types";
import { END_OF_DAY_INTRADAY, createHubSource, hubTimeframe, toHubSymbol } from "./hub";

const MIN = 60_000;
/** 09:15 IST on 2026-11-09, in UTC ms. */
const OPEN = Date.UTC(2026, 10, 9, 3, 45);

const quote = (symbol: string, ltp: number, extra: Partial<HubQuote> = {}): HubQuote => ({ symbol, ltp, ch: 1, chp: 0.1, open: ltp, high: ltp, low: ltp, prevClose: ltp - 1, volume: 10, ltt: 5, ts: 6, source: "socket", ...extra });

function fakeClient(
  candles: (symbol: string, tf: string, from: number) => HubCandles,
  quotes: (symbols: string[]) => HubQuotes = () => ({ quotes: [], missing: [] }),
  batch: (symbols: string[]) => HubCandlesBatch["series"] = () => ({}),
) {
  const calls = { candles: [] as Array<[string, string, number]>, quotes: [] as string[][], batch: [] as string[][], adjust: [] as Array<string | undefined> };
  return {
    calls,
    client: {
      candles: async (symbol: string, tf: string, from: number, options: { adjust?: string } = {}) => {
        calls.candles.push([symbol, tf, from]);
        calls.adjust.push(options.adjust);
        return candles(symbol, tf, from);
      },
      quotes: async (symbols: string[]) => {
        calls.quotes.push(symbols);
        return quotes(symbols);
      },
      candlesBatch: async (symbols: string[], tf: "1d" | "1w", from: number): Promise<HubCandlesBatch> => {
        calls.batch.push(symbols);
        return { tf, from, to: from, series: batch(symbols), queued: [], unknown: [] };
      },
    },
  };
}

/** A stand-in for HubStream that records the symbol set and lets tests push ticks. */
function fakeStream() {
  const listeners = new Set<HubStreamListener>();
  const state = { symbols: [] as string[], started: 0, healthy: true, restarts: 0 };
  const stream = {
    start: () => void (state.started += 1),
    healthy: () => state.healthy,
    setSymbols: (symbols: string[]) => void (state.symbols = [...new Set(symbols)].sort()),
    restart: () => void (state.restarts += 1),
    on: (listener: HubStreamListener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  } as unknown as HubStream;
  return { stream, state, push: (q: HubQuote) => listeners.forEach((listener) => listener.tick?.(q)) };
}

const answer = (candles: HubCandles["candles"], extra: Partial<HubCandles> = {}): HubCandles => ({ symbol: "SBIN", tf: "15m", from: 0, to: 0, complete: true, coverage: null, candles, ...extra });

describe("hub symbol and interval mapping", () => {
  it("maps app symbols to hub tickers, and refuses what the hub doesn't serve", () => {
    expect(toHubSymbol("sbin")).toBe("SBIN");
    expect(toHubSymbol("M&M")).toBe("M&M");
    expect(toHubSymbol("BAJAJ-AUTO")).toBe("BAJAJ-AUTO");
    expect(toHubSymbol("NIFTY")).toBe("NIFTY");
    expect(toHubSymbol("NSE:SBIN-EQ")).toBe("SBIN");
    expect(toHubSymbol("NSE:NIFTY50-INDEX")).toBe("NIFTY");
    expect(toHubSymbol("NSE:NIFTYBANK-INDEX")).toBe("BANKNIFTY");
    expect(toHubSymbol("NSE:SBIN26NOVFUT")).toBe("SBIN26NOVFUT");
    expect(toHubSymbol("SBIN26NOVFUT")).toBe("SBIN26NOVFUT");
    expect(toHubSymbol("NSE:M&M26DECFUT")).toBe("M&M26DECFUT");
    expect(toHubSymbol("SENSEX")).toBeNull();
    expect(toHubSymbol("BSE:SENSEX-INDEX")).toBeNull();
  });

  it("serves intervals from the nearest hub timeframe", () => {
    expect(hubTimeframe("1d")).toEqual({ tf: "1d", resampleMinutes: null });
    expect(hubTimeframe("30m")).toEqual({ tf: "15m", resampleMinutes: 30 });
    expect(hubTimeframe("10m")).toEqual({ tf: "5m", resampleMinutes: 10 });
    expect(hubTimeframe("4h")).toEqual({ tf: "1h", resampleMinutes: 240 });
    expect(hubTimeframe("1m")).toEqual({ tf: "1m", resampleMinutes: null });
    expect(hubTimeframe("3m")).toEqual({ tf: "1m", resampleMinutes: 3 });
  });
});

describe("hub source history", () => {
  const stream = () => fakeStream().stream;

  it("asks for the hub ticker and timeframe, and keeps the stored series key", async () => {
    const { client, calls } = fakeClient(() => answer([{ t: Date.UTC(2026, 10, 6), o: 1, h: 2, l: 0.5, c: 1.5, v: 100, dp: 55 }], { tf: "1d" }));
    const source = createHubSource({ client: () => client, stream });
    const result = await source.history!.fetch({ symbol: "NSE:SBIN-EQ", interval: "1d", from: 123 });
    expect(calls.candles).toEqual([["SBIN", "1d", 123]]);
    expect(calls.adjust).toEqual(["split"]); // charts, indicators and backtests read adjusted prices, asked for explicitly
    expect(result).toEqual({ candles: [{ date: "2026-11-06T00:00:00.000Z", open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }], complete: true });
    expect(source.kind).toBe("broker");
    expect(source.history!.cacheable).toBe(true);
    expect(source.history!.cacheKey!("SBIN", "1d")).toBe("NSE:SBIN-EQ:D");
    expect(source.history!.windowDays!("15m")).toBe(365);
    expect(source.history!.windowDays!("1m")).toBe(30);
  });

  it("builds 30-minute candles from the hub's 15-minute ones, aligned to 09:15 IST", async () => {
    const bars = [0, 15, 30, 45].map((offset, index) => ({ t: OPEN + offset * MIN, o: 10 + index, h: 20 + index, l: 5 - index, c: 11 + index, v: 1 }));
    const { client } = fakeClient(() => answer(bars));
    const { candles } = await createHubSource({ client: () => client, stream }).history!.fetch({ symbol: "SBIN", interval: "30m", from: 0 });
    expect(candles).toEqual([
      { date: new Date(OPEN).toISOString(), open: 10, high: 21, low: 4, close: 12, volume: 2 },
      { date: new Date(OPEN + 30 * MIN).toISOString(), open: 12, high: 23, low: 2, close: 14, volume: 2 },
    ]);
  });

  it("shows stored candles from a 503 but doesn't mark them complete; passes on when there are none", async () => {
    const partial = { code: "broker_unavailable", reason: "budget", message: "The broker is unavailable" };
    const some = fakeClient(() => answer([{ t: OPEN, o: 1, h: 1, l: 1, c: 1, v: 1 }], { partial }));
    expect((await createHubSource({ client: () => some.client, stream }).history!.fetch({ symbol: "SBIN", interval: "15m", from: 0 })).complete).toBe(false);
    const none = fakeClient(() => answer([], { partial }));
    await expect(createHubSource({ client: () => none.client, stream }).history!.fetch({ symbol: "SBIN", interval: "15m", from: 0 })).rejects.toBeInstanceOf(SourceSkip);
  });

  it("asks for futures contracts by their plain hub ticker", async () => {
    const { client, calls } = fakeClient(() => answer([{ t: OPEN, o: 1, h: 1, l: 1, c: 1, v: 1 }]));
    await createHubSource({ client: () => client, stream }).history!.fetch({ symbol: "NSE:SBIN26NOVFUT", interval: "15m", from: 7 });
    await createHubSource({ client: () => client, stream }).history!.fetch({ symbol: "SBIN26NOVFUT", interval: "1m", from: 7 });
    expect(calls.candles).toEqual([
      ["SBIN26NOVFUT", "15m", 7],
      ["SBIN26NOVFUT", "1m", 7],
    ]);
  });
});

describe("hub source quotes", () => {
  it("answers each app spelling; a stale (stored) quote is passed on marked delayed", async () => {
    const { client, calls } = fakeClient(
      () => answer([]),
      () => ({ quotes: [quote("SBIN", 1008), quote("INFY", 1490, { source: "store", stale: true }), quote("SBIN26NOVFUT", 1012)], missing: [] }),
    );
    const source = createHubSource({ client: () => client, stream: () => fakeStream().stream });
    const quotes = await source.quotes!.fetch(["SBIN", "NSE:SBIN-EQ", "INFY", "NSE:SBIN26NOVFUT", "SENSEX"]);
    expect(calls.quotes).toEqual([["SBIN", "INFY", "SBIN26NOVFUT"]]);
    expect(quotes.map((q) => [q.symbol, q.ltp, q.delayed ?? false])).toEqual([
      ["SBIN", 1008, false],
      ["NSE:SBIN-EQ", 1008, false],
      ["INFY", 1490, true],
      ["NSE:SBIN26NOVFUT", 1012, false],
    ]);
    expect(source.quotes!.delayed).toBe(false);
  });
});


describe("hub live feed", () => {
  it("streams subscribed symbols on one connection and maps ticks back to app symbols", async () => {
    const fake = fakeStream();
    const feed = createHubSource({ client: () => fakeClient(() => answer([])).client, stream: () => fake.stream }).stream!;
    const ticks: SourceTick[] = [];
    feed.onTick((tick) => ticks.push(tick));
    expect(await feed.start()).toBe(true);
    expect(await feed.subscribe(["SBIN", "NIFTY", "NSE:SBIN26NOVFUT", "SENSEX"])).toEqual(["SBIN", "NIFTY", "NSE:SBIN26NOVFUT"]); // BSE is polled instead
    expect(fake.state.symbols).toEqual(["NIFTY", "SBIN", "SBIN26NOVFUT"]);
    await feed.subscribe(["SBIN"]);
    fake.push(quote("SBIN", 1010));
    fake.push(quote("TCS", 4000)); // not subscribed
    expect(ticks).toEqual([{ symbol: "SBIN", ltp: 1010, ch: 1, chp: 0.1, open: 1010, high: 1010, low: 1010, prevClose: 1009, volume: 10, ltt: 5, ts: 6 }]);

    feed.unsubscribe(["SBIN"]);
    expect(fake.state.symbols).toEqual(["NIFTY", "SBIN", "SBIN26NOVFUT"]); // still one consumer left
    feed.unsubscribe(["SBIN", "NIFTY", "NSE:SBIN26NOVFUT"]);
    expect(fake.state.symbols).toEqual([]);
  });

  it("caps the stream at 100 symbols; the rest is left for polling", async () => {
    const fake = fakeStream();
    const feed = createHubSource({ client: () => fakeClient(() => answer([])).client, stream: () => fake.stream }).stream!;
    const symbols = Array.from({ length: 120 }, (_, index) => `S${index}`);
    expect(await feed.subscribe(symbols)).toHaveLength(100);
    expect(fake.state.symbols).toHaveLength(100);
  });

  it("reports the stream's health and restarts it", async () => {
    const fake = fakeStream();
    const feed = createHubSource({ client: () => fakeClient(() => answer([])).client, stream: () => fake.stream }).stream!;
    fake.state.healthy = false;
    expect(feed.isConnected()).toBe(false);
    expect(await feed.restart!("quiet")).toBe(false);
    expect(fake.state.restarts).toBe(1);
  });
});

describe("hub source in end-of-day mode (a hub without a broker)", () => {
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  const bar = (iso: string, c: number) => ({ t: day(iso), o: c - 1, h: c + 2, l: c - 3, c, v: 500 });

  it("offers daily history only, and marks a short answer for another try", async () => {
    const { client, calls } = fakeClient(() => answer([bar("2026-11-06", 100)], { tf: "1d", complete: false }));
    const source = createHubSource({ client: () => client, stream: () => fakeStream().stream, endOfDay: () => true });
    expect(source.history!.supports("1d")).toBe(true);
    for (const interval of ["1m", "5m", "15m", "1h", "4h"] as const) expect(source.history!.supports(interval), interval).toBe(false);
    await expect(source.history!.fetch({ symbol: "SBIN", interval: "15m", from: 0 })).rejects.toThrow(END_OF_DAY_INTRADAY);
    expect(await source.history!.fetch({ symbol: "SBIN", interval: "1d", from: 0 })).toMatchObject({ complete: false, candles: [{ close: 100 }] });
    expect(calls.candles).toHaveLength(1);
  });

  it("quotes the last daily close (delayed), from one batch call reused for a minute", async () => {
    const clock = { now: day("2026-11-08") };
    const { client, calls } = fakeClient(
      () => answer([]),
      () => {
        throw new Error("/v1/quotes must not be called without a broker");
      },
      (symbols) => Object.fromEntries(symbols.map((symbol) => [symbol, { complete: true, coverage: null, candles: [bar("2026-11-05", 100), bar("2026-11-06", 105)] }])),
    );
    const source = createHubSource({ client: () => client, stream: () => fakeStream().stream, endOfDay: () => true, now: () => clock.now });
    const quotes = await source.quotes!.fetch(["SBIN", "NSE:SBIN-EQ", "INFY"]);
    expect(quotes).toEqual([
      { symbol: "SBIN", ltp: 105, ch: 5, chp: 5, open: 104, high: 107, low: 102, prevClose: 100, volume: 500, delayed: true },
      { symbol: "NSE:SBIN-EQ", ltp: 105, ch: 5, chp: 5, open: 104, high: 107, low: 102, prevClose: 100, volume: 500, delayed: true },
      { symbol: "INFY", ltp: 105, ch: 5, chp: 5, open: 104, high: 107, low: 102, prevClose: 100, volume: 500, delayed: true },
    ]);
    await source.quotes!.fetch(["SBIN"]);
    expect(calls.batch).toEqual([["SBIN", "INFY"]]);
    clock.now += 61_000;
    await source.quotes!.fetch(["SBIN"]);
    expect(calls.batch).toHaveLength(2);
    expect(calls.quotes).toHaveLength(0);
  });

  it("keeps the stream closed: nothing is subscribed, so the market stream polls", async () => {
    const fake = fakeStream();
    const source = createHubSource({ client: () => fakeClient(() => answer([])).client, stream: () => fake.stream, endOfDay: () => true });
    expect(await source.stream!.start()).toBe(false);
    expect(await source.stream!.subscribe(["SBIN"])).toEqual([]);
    expect(source.stream!.isConnected()).toBe(false);
    expect(fake.state.started).toBe(0);
  });
});
