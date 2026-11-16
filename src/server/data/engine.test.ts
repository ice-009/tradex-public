import { describe, expect, it } from "vitest";
import type { PricePoint } from "@/contracts/api";
import { DataEngine, REST_MS, type HistoryStore } from "./engine";
import { SourceSkip, type DataSource, type HistoryRequest, type SourceQuote } from "./types";

const DAY = 86_400_000;
const NOW = 1_000 * DAY;
const candle = (day: number, close = 100): PricePoint => ({ date: new Date(day * DAY).toISOString(), open: close, high: close, low: close, close, volume: 1 });
const quote = (symbol: string, ltp: number): SourceQuote => ({ symbol, ltp, ch: 0, chp: 0, open: ltp, high: ltp, low: ltp, prevClose: ltp, volume: 1 });

/** A fake source that records calls and answers from scripts. */
function fakeSource(id: string, kind: DataSource["kind"], behaviour: { history?: (request: HistoryRequest) => PricePoint[] | Error; quotes?: (symbols: string[]) => SourceQuote[] | Error; down?: string; delayed?: boolean; intervals?: string[]; windowDays?: number; cacheable?: boolean }) {
  const calls = { history: [] as HistoryRequest[], quotes: [] as string[][] };
  const source: DataSource = {
    id,
    label: id.toUpperCase(),
    kind,
    unavailable: async () => behaviour.down ?? null,
    history: behaviour.history && {
      supports: (interval) => !behaviour.intervals || behaviour.intervals.includes(interval),
      windowDays: behaviour.windowDays ? () => behaviour.windowDays! : undefined,
      cacheable: behaviour.cacheable ?? false,
      async fetch(request) {
        calls.history.push(request);
        const out = behaviour.history!(request);
        if (out instanceof Error) throw out;
        return { candles: out, complete: true };
      },
    },
    quotes: behaviour.quotes && {
      delayed: behaviour.delayed ?? false,
      async fetch(symbols) {
        calls.quotes.push(symbols);
        const out = behaviour.quotes!(symbols);
        if (out instanceof Error) throw out;
        return out;
      },
    },
  };
  return { source, calls };
}

const passThroughStore: HistoryStore = { get: async ({ from, download }) => (await download(from)).candles };

function engine(sources: DataSource[], clock = { now: NOW }) {
  return new DataEngine(sources, { historyStore: passThroughStore, now: () => clock.now, log: () => {} });
}

describe("DataEngine history", () => {
  it("answers from the first source that can, and says which", async () => {
    const broker = fakeSource("broker", "broker", { history: () => [candle(999)] });
    const sample = fakeSource("sample", "sample", { history: () => [candle(1)] });
    const answer = await engine([broker.source, sample.source]).history({ symbol: "SBIN", interval: "1d", from: NOW - 10 * DAY });
    expect(answer.source?.id).toBe("broker");
    expect(sample.calls.history).toHaveLength(0);
  });

  it("falls back past a source that's down, fails, or has no data, explaining why", async () => {
    const down = fakeSource("down", "broker", { history: () => [candle(1)], down: "not connected" });
    const empty = fakeSource("empty", "sample", { history: () => [] });
    const sample = fakeSource("sample", "sample", { history: () => [candle(1)] });
    const answer = await engine([down.source, empty.source, sample.source]).history({ symbol: "SBIN", interval: "1d", from: 0 });
    expect(answer.source?.id).toBe("sample");
    expect(answer.skipped).toEqual(["DOWN: not connected", "EMPTY: no data for SBIN"]);
  });

  it("skips sources that don't support the interval or kind", async () => {
    const eod = fakeSource("eod", "sample", { history: () => [candle(1)], intervals: ["1d"] });
    const sample = fakeSource("sample", "sample", { history: () => [candle(2)] });
    const e = engine([eod.source, sample.source]);
    expect((await e.history({ symbol: "SBIN", interval: "15m", from: 0 })).source?.id).toBe("sample");
    expect((await e.history({ symbol: "SBIN", interval: "1d", from: 0, kinds: ["broker"] })).source).toBeNull();
  });

  it("clamps the request to the source's history window", async () => {
    const broker = fakeSource("broker", "broker", { history: () => [candle(999)], windowDays: 365 });
    await engine([broker.source]).history({ symbol: "SBIN", interval: "1d", from: NOW - 5 * 365 * DAY });
    expect(broker.calls.history[0].from).toBe(NOW - 365 * DAY);
  });

  it("rests a source after a source-wide failure, but not after a bad-symbol error", async () => {
    const clock = { now: NOW };
    let error = new Error("Market Data Hub 422 bad_request: candles fetch failed");
    const broker = fakeSource("broker", "broker", { history: () => error });
    const sample = fakeSource("sample", "sample", { history: () => [candle(1)] });
    const e = engine([broker.source, sample.source], clock);

    await e.history({ symbol: "BAD", interval: "1d", from: 0 });
    await e.history({ symbol: "SBIN", interval: "1d", from: 0 });
    expect(broker.calls.history).toHaveLength(2); // 422 is about that symbol: broker still asked

    error = new Error("fetch failed: ECONNRESET");
    await e.history({ symbol: "SBIN", interval: "1d", from: 0 });
    await e.history({ symbol: "TCS", interval: "1d", from: 0 });
    expect(broker.calls.history).toHaveLength(3); // resting: TCS went straight to sample
    expect(e.status()[0].lastError).toContain("ECONNRESET");

    clock.now += REST_MS + 1;
    await e.history({ symbol: "TCS", interval: "1d", from: 0 });
    expect(broker.calls.history).toHaveLength(4); // tried again after the rest
  });

  it("passes over a SourceSkip (e.g. budget spent) without resting the source", async () => {
    let skip = true;
    const broker = fakeSource("broker", "broker", { history: () => (skip ? new SourceSkip("budget spent") : [candle(1)]) });
    const sample = fakeSource("sample", "sample", { history: () => [candle(2)] });
    const e = engine([broker.source, sample.source]);
    expect((await e.history({ symbol: "SBIN", interval: "1d", from: 0 })).source?.id).toBe("sample");
    skip = false;
    expect((await e.history({ symbol: "SBIN", interval: "1d", from: 0 })).source?.id).toBe("broker");
  });

  it("uses the disk store only for cacheable sources", async () => {
    const keys: string[] = [];
    const store: HistoryStore = { get: async ({ key, from, download }) => (keys.push(key), (await download(from)).candles) };
    const broker = fakeSource("broker", "broker", { history: () => [candle(1)], cacheable: true });
    const e = new DataEngine([broker.source], { historyStore: store, now: () => NOW, log: () => {} });
    await e.history({ symbol: "SBIN", interval: "15m", from: 0 });
    expect(keys).toEqual(["broker:SBIN:15m"]);
  });
});

describe("DataEngine quotes", () => {
  it("fills what the broker misses from the next source, marking delayed quotes", async () => {
    const broker = fakeSource("broker", "broker", { quotes: (symbols) => symbols.filter((s) => s !== "NEWLIST").map((s) => quote(s, 10)) });
    const eod = fakeSource("eod", "sample", { quotes: (symbols) => symbols.map((s) => quote(s, 9)), delayed: true });
    const quotes = await engine([broker.source, eod.source]).quotes(["sbin", "NEWLIST"], { maxAgeMs: 60_000 });
    expect(quotes).toEqual([
      { ...quote("SBIN", 10), source: "broker" },
      { ...quote("NEWLIST", 9), source: "eod", delayed: true },
    ]);
    expect(eod.calls.quotes).toEqual([["NEWLIST"]]);
  });

  it("serves live quotes from cache within the caller's max age", async () => {
    const clock = { now: NOW };
    const broker = fakeSource("broker", "broker", { quotes: (symbols) => symbols.map((s) => quote(s, 10)) });
    const e = engine([broker.source], clock);
    await e.quotes(["SBIN"], { maxAgeMs: 60_000 });
    clock.now += 30_000;
    await e.quotes(["SBIN"], { maxAgeMs: 60_000 });
    expect(broker.calls.quotes).toHaveLength(1);
    await e.quotes(["SBIN"], { maxAgeMs: 5_000 }); // this caller wants fresher
    expect(broker.calls.quotes).toHaveLength(2);
  });

  it("shares one fetch between concurrent callers", async () => {
    const broker = fakeSource("broker", "broker", { quotes: (symbols) => symbols.map((s) => quote(s, 10)) });
    const e = engine([broker.source]);
    await Promise.all([e.quotes(["SBIN", "TCS"], { maxAgeMs: 1 }), e.quotes(["SBIN", "TCS"], { maxAgeMs: 1 })]);
    expect(broker.calls.quotes).toHaveLength(1);
  });

  it("never caches delayed quotes as fresh, and honours a kinds filter", async () => {
    const eod = fakeSource("eod", "sample", { quotes: (symbols) => symbols.map((s) => quote(s, 9)), delayed: true });
    const e = engine([eod.source]);
    await e.quotes(["SBIN"], { maxAgeMs: 60_000 });
    await e.quotes(["SBIN"], { maxAgeMs: 60_000 });
    expect(eod.calls.quotes).toHaveLength(2);
    expect(await e.quotes(["SBIN"], { maxAgeMs: 60_000, kinds: ["broker"] })).toEqual([]);
  });

  it("answers a live source's stale quote marked delayed, without caching it", async () => {
    const hub = fakeSource("hub", "broker", { quotes: (symbols) => symbols.map((s) => (s === "INFY" ? { ...quote(s, 9), delayed: true } : quote(s, 10))) });
    const e = engine([hub.source]);
    expect(await e.quotes(["SBIN", "INFY"], { maxAgeMs: 60_000 })).toEqual([
      { ...quote("SBIN", 10), source: "hub" },
      { ...quote("INFY", 9), source: "hub", delayed: true },
    ]);
    expect(e.cachedQuote("INFY")).toBeNull();
    await e.quotes(["SBIN", "INFY"], { maxAgeMs: 60_000 });
    expect(hub.calls.quotes).toEqual([["SBIN", "INFY"], ["INFY"]]); // SBIN from the cache, INFY asked again
  });

  it("falls back when the broker is down", async () => {
    const broker = fakeSource("broker", "broker", { quotes: () => [quote("SBIN", 10)], down: "logged out" });
    const eod = fakeSource("eod", "sample", { quotes: (symbols) => symbols.map((s) => quote(s, 9)), delayed: true });
    const quotes = await engine([broker.source, eod.source]).quotes(["SBIN"], { maxAgeMs: 60_000 });
    expect(quotes[0]).toMatchObject({ source: "eod", delayed: true });
    expect(broker.calls.quotes).toHaveLength(0);
  });
});
