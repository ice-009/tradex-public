import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Replay (issue #32): stepping the Time Machine day by day computes the plan's
// evidence for each day from ONE read and ONE scan of the replay block, cut at
// the day — and must give exactly the table, note and run stamp that day gets
// computed from scratch on its own (a fresh server, reading only up to the
// day). The fake hub has, inside the block, a 1:1 bonus (the prices a scan sees
// change: a second scan), a stock leaving the F&O list and one joining it, and
// a stretch years before with no F&O files (the day's own list stands in
// there, so the stand-in is part of what a scan is for).

const DAY = 86_400_000;
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

const LAST = day("2026-11-20");
const BONUS_DAY = day("2019-06-20");
const OLDCO_LEAVES = day("2019-06-25");
const NEWCO_JOINS = day("2019-05-01");
const NO_FILES = { from: day("2016-03-01"), to: day("2016-03-25") };

const SESSIONS = (() => {
  const out: number[] = [];
  for (let t = day("2012-01-02"); t <= LAST; t += DAY) {
    const weekday = new Date(t).getUTCDay();
    if (weekday !== 0 && weekday !== 6) out.push(t);
  }
  return out;
})();

const STOCKS = Array.from({ length: 24 }, (_, i) => `S${String(i).padStart(2, "0")}`);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (text: string) => [...text].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261);

/** Daily bars as the hub serves them: adjusted to today (S00 halved before its bonus). */
function bars(symbol: string) {
  const rand = rng(seedOf(symbol));
  const index = symbol === "NIFTY";
  let price = index ? 10_000 : 100 + rand() * 900;
  let drift = 0;
  const out = [];
  for (const [i, t] of SESSIONS.entries()) {
    if (i % 40 === 0) drift = (rand() - 0.45) * 0.006;
    const open = price * (1 + (rand() - 0.5) * 0.01);
    const close = open * (1 + drift + (rand() - 0.5) * 0.03);
    const high = Math.max(open, close) * (1 + rand() * 0.01);
    const low = Math.min(open, close) * (1 - rand() * 0.01);
    price = close;
    out.push({ t, o: open, h: high, l: low, c: close, v: index ? 0 : Math.round(100_000 + rand() * 900_000), dp: index ? null : 40 });
  }
  if (symbol === "S00") return out.map((bar) => (bar.t < BONUS_DAY ? { ...bar, o: bar.o / 2, h: bar.h / 2, l: bar.l / 2, c: bar.c / 2, v: bar.v * 2 } : bar));
  if (symbol === "NEWCO") return out.filter((bar) => bar.t >= day("2018-01-01"));
  return out;
}

function members(t: number): string[] {
  return [...STOCKS, ...(t < OLDCO_LEAVES ? ["OLDCO"] : []), ...(t >= NEWCO_JOINS ? ["NEWCO"] : [])];
}

const hub = vi.hoisted(() => ({ candleCalls: [] as Array<{ from: number; to: number | undefined }> }));

const fake = {
  calendar: async (from: string, to: string) => ({ from, to, tradingDays: SESSIONS.filter((t) => t >= day(from) && t <= day(to)).map(iso), holidays: [] }),
  candlesBatch: async (symbols: string[], _tf: string, from: number, to?: number) => {
    hub.candleCalls.push({ from, to });
    const series: Record<string, unknown> = {};
    for (const symbol of symbols) {
      // Ignores `to`: cutting at the day is Tradex's own doing.
      const list = bars(symbol).filter((bar) => bar.t >= from);
      if (list.length) series[symbol] = { complete: true, coverage: { from: list[0].t, to: list.at(-1)!.t }, candles: list };
    }
    return { tf: "1d", adjust: "split", from, to: to ?? LAST, series, queued: [], unknown: symbols.filter((symbol) => !series[symbol]) };
  },
  adjustmentsBatch: async (symbols: string[]) => ({
    derivedAt: 0,
    series: Object.fromEntries(symbols.filter((symbol) => symbol !== "NIFTY").map((symbol) => [symbol, { current: symbol, factors: symbol === "S00" ? [{ date: iso(BONUS_DAY), day: BONUS_DAY, symbol, factor: 0.5, cumulative: 0.5, source: "corporate_action", action: "BONUS 1:1" }] : [] }])),
  }),
  foMembers: async (from: number, to: number) => ({ from: iso(from), to: iso(to), days: SESSIONS.filter((t) => t >= from && t <= to && !(t >= NO_FILES.from && t <= NO_FILES.to)).map((t) => ({ date: iso(t), day: t, symbols: members(t) })) }),
  universe: async (name: string) => ({ name, source: "fake", asOf: iso(LAST), count: 25, members: members(LAST).map((symbol) => ({ symbol, name: symbol, industry: "" })) }),
  lots: async () => ({ source: "fake", fetchedAt: 1, count: 25, lots: Object.fromEntries(members(LAST).map((symbol) => [symbol, 500])) }),
  lotHistory: async () => ({ from: null, to: iso(LAST), knownFrom: "2024-07-08", knownFromDay: day("2024-07-08"), lastDate: iso(LAST), lastDay: LAST, lots: {} }),
  foBan: async () => ({ tradeDate: iso(LAST), symbols: [], fetchedAt: 1, current: true }),
  foBanHistory: async () => ({ knownFrom: "2026-11-11", knownFromDay: day("2026-11-11"), days: [] }),
  symbolChanges: async () => ({ count: 0, changes: [] }),
  resultsCalendar: async (from: string, to: string) => ({ from, to, fetchedAt: 1, events: [] }),
  indices: async () => ({ indices: [], baskets: [], sectors: [], basketMethod: "" }),
};

vi.mock("@/server/providers/hub", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/providers/hub")>()), hubClient: () => fake }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = ((file: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => (String(file).includes(".cache") ? Promise.reject(new Error("no cache in tests")) : (fs.readFile as (...args: unknown[]) => unknown)(file, ...rest))) as typeof fs.readFile;
  return { ...fs, readFile, mkdir: async () => undefined, writeFile: async () => undefined };
});

beforeAll(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    throw new Error(`unexpected request: ${String(input)}`);
  });
});
afterAll(() => vi.unstubAllGlobals());

const globalsBefore = new Set(Object.keys(globalThis));

/** A fresh server: no caches, no replay blocks. */
async function freshServer() {
  for (const key of Object.keys(globalThis)) if (!globalsBefore.has(key) && !/prisma|debug/i.test(key)) delete (globalThis as Record<string, unknown>)[key];
  vi.resetModules();
  return { ...(await import("./timeMachine")), ...(await import("./evidence")) };
}

type Server = Awaited<ReturnType<typeof freshServer>>;

async function evidenceOn(server: Server, date: string, replay: boolean) {
  const past = (await server.pastDay(date, replay ? "1" : null))!;
  const started = Date.now();
  const answer = await vi.waitFor(
    async () => {
      const result = await server.strategyEvidence(null, past);
      if (result.status !== "ready") throw new Error(`evidence ${result.status}: ${result.status === "error" ? result.error : ""}`);
      return result;
    },
    { timeout: 60_000, interval: 25 },
  );
  return { answer, ms: Date.now() - started };
}

/** Sessions the replay steps through: before the bonus, across it, across the list changes. */
const DAYS = ["2019-06-03", "2019-06-04", "2019-06-19", "2019-06-20", "2019-06-24", "2019-06-25", "2019-07-15"];

describe("replay evidence equals the from-scratch past day", { timeout: 300_000 }, () => {
  const replayed = new Map<string, Awaited<ReturnType<typeof evidenceOn>>>();
  let replayCalls: Array<{ from: number; to: number | undefined }> = [];

  beforeAll(async () => {
    hub.candleCalls = [];
    const server = await freshServer();
    for (const date of DAYS) replayed.set(date, await evidenceOn(server, date, true));
    replayCalls = [...hub.candleCalls];
  }, 300_000);

  it("reads the block once, ahead of the days, and steps fast after the first", () => {
    // One read for the whole block (through about three months after the first day), not one per day.
    expect(replayCalls.length).toBeLessThanOrEqual(2);
    expect(Math.max(...replayCalls.map((call) => call.to ?? 0))).toBeGreaterThan(day("2019-08-15"));
    const first = replayed.get(DAYS[0])!.ms;
    const sameScan = replayed.get(DAYS[1])!.ms;
    expect(sameScan).toBeLessThan(first / 2);
  });

  for (const date of DAYS) {
    it(`gives ${date} the same table, note and stamp as computing it on its own`, async () => {
      hub.candleCalls = [];
      const scratch = (await evidenceOn(await freshServer(), date, false)).answer;
      // On its own, nothing after the day was read.
      expect(hub.candleCalls.every((call) => call.to !== undefined && call.to <= day(date))).toBe(true);
      const replay = replayed.get(date)!.answer;
      if (scratch.status !== "ready" || replay.status !== "ready") throw new Error("not ready");
      expect(replay.table).toEqual(scratch.table);
      expect(replay.universeNote).toBe(scratch.universeNote);
      expect(replay.stamp.data).toEqual(scratch.stamp.data);
      expect(replay.stamp.hash).toBe(scratch.stamp.hash);
      expect(replay.stamp.resultHash).toBe(scratch.stamp.resultHash);
      expect(replay.stamp.params).toEqual(scratch.stamp.params);
      expect(replay.table.to).toBeLessThanOrEqual(day(date));
      expect(replay.table.trades).toBeGreaterThan(0);
    });
  }
});
