import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The Time Machine's no-look-ahead guarantee (issue #31), end to end on the
// server: the screener, the track record, the plan's evidence, quotes, lots and
// results for a past day D are computed twice from a fake Market Data Hub —
// once with one future after D, once with a very different one (every bar after
// D rewritten, a stock joining the F&O list and another leaving it, a 1:1 bonus
// whose adjustment rescales the hub's bars before D, a ban, a lot change and a
// results date after D) — and must come out the same. The fake hub also ignores
// the `to` of every candle request, so cutting the bars off at D is Tradex's
// own doing, not the hub's.

const DAY = 86_400_000;
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** D: requested as Sunday 16 Jun 2019, which snaps to Friday 14 Jun 2019. */
const REQUESTED = "2019-06-16";
const D = day("2019-06-14");
const BONUS_DAY = day("2022-05-02");
const LAST = day("2026-11-20");

const SESSIONS = (() => {
  const out: number[] = [];
  for (let t = day("2012-01-02"); t <= LAST; t += DAY) {
    const weekday = new Date(t).getUTCDay();
    if (weekday !== 0 && weekday !== 6) out.push(t);
  }
  return out;
})();

const STOCKS = Array.from({ length: 30 }, (_, i) => `S${String(i).padStart(2, "0")}`);

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

type Variant = "A" | "B";

/** A stock's daily bars as the hub serves them (adjusted to today) in a variant; the same up to D in both, apart from B's bonus adjustment. */
function bars(symbol: string, variant: Variant) {
  const before = rng(seedOf(symbol));
  const after = rng(seedOf(`${symbol}:${variant}`));
  const index = symbol === "NIFTY";
  let price = index ? 10_000 : 100 + before() * 900;
  let drift = 0;
  const out = [];
  for (const [i, t] of SESSIONS.entries()) {
    const rand = t <= D ? before : after;
    if (i % 40 === 0) drift = (rand() - 0.45) * (variant === "B" && t > D ? 0.02 : 0.004);
    const open = price * (1 + (rand() - 0.5) * 0.01);
    const close = open * (1 + drift + (rand() - 0.5) * 0.03);
    const high = Math.max(open, close) * (1 + rand() * 0.01);
    const low = Math.min(open, close) * (1 - rand() * 0.01);
    price = close;
    out.push({ t, o: open, h: high, l: low, c: close, v: index ? 0 : Math.round(100_000 + rand() * 900_000), dp: index ? null : 40 });
  }
  // B: S00's 1:1 bonus after D — the hub's adjusted history halves every price before it.
  if (variant === "B" && symbol === "S00") return out.map((bar) => (bar.t < BONUS_DAY ? { ...bar, o: bar.o / 2, h: bar.h / 2, l: bar.l / 2, c: bar.c / 2, v: bar.v * 2 } : bar));
  return out;
}

const hub = vi.hoisted(() => ({ variant: "A" as "A" | "B", candleCalls: [] as Array<{ to: number | undefined }> }));

/** The F&O list on a day: OLDCO leaves it after D in B; NEWCO joins it after D in B. */
function members(t: number, variant: Variant): string[] {
  const list = [...STOCKS, "OLDCO"];
  if (variant === "B" && t > D) return [...STOCKS, "NEWCO"];
  return list;
}

const fake = {
  calendar: async (from: string, to: string) => ({ from, to, tradingDays: SESSIONS.filter((t) => t >= day(from) && t <= day(to)).map(iso), holidays: [] }),
  candlesBatch: async (symbols: string[], _tf: string, from: number, to?: number) => {
    hub.candleCalls.push({ to });
    const series: Record<string, unknown> = {};
    for (const symbol of symbols) {
      if (symbol === "NEWCO" && hub.variant === "A") continue;
      // Ignores `to`: every bar to the end is sent back.
      let list = bars(symbol, hub.variant).filter((bar) => bar.t >= from);
      if (symbol === "NEWCO") list = list.filter((bar) => bar.t > D);
      if (list.length) series[symbol] = { complete: true, coverage: { from: list[0].t, to: list.at(-1)!.t }, candles: list };
    }
    return { tf: "1d", adjust: "split", from, to: to ?? LAST, series, queued: [], unknown: symbols.filter((symbol) => !series[symbol]) };
  },
  adjustmentsBatch: async (symbols: string[]) => ({
    derivedAt: 0,
    series: Object.fromEntries(symbols.filter((symbol) => symbol !== "NIFTY").map((symbol) => [symbol, { current: symbol, factors: hub.variant === "B" && symbol === "S00" ? [{ date: iso(BONUS_DAY), day: BONUS_DAY, symbol, factor: 0.5, cumulative: 0.5, source: "corporate_action", action: "BONUS 1:1" }] : [] }])),
  }),
  foMembers: async (from: number, to: number) => ({ from: iso(from), to: iso(to), days: SESSIONS.filter((t) => t >= from && t <= to).map((t) => ({ date: iso(t), day: t, symbols: members(t, hub.variant) })) }),
  universe: async (name: string) => ({ name, source: "fake", asOf: iso(LAST), count: 31, members: members(LAST, hub.variant).map((symbol) => ({ symbol, name: symbol, industry: "" })) }),
  lots: async () => ({ source: "fake", fetchedAt: 1, count: 31, lots: Object.fromEntries(members(LAST, hub.variant).map((symbol) => [symbol, hub.variant === "B" ? 999 : 500])) }),
  lotHistory: async () => ({ from: null, to: iso(LAST), knownFrom: "2024-07-08", knownFromDay: day("2024-07-08"), lastDate: iso(LAST), lastDay: LAST, lots: hub.variant === "B" ? { NEWCO: [{ date: "2025-01-01", day: day("2025-01-01"), lot: 900 }] } : {} }),
  foBan: async () => ({ tradeDate: iso(LAST), symbols: hub.variant === "B" ? ["S01"] : [], fetchedAt: 1, current: true }),
  foBanHistory: async () => ({ knownFrom: "2026-11-11", knownFromDay: day("2026-11-11"), days: hub.variant === "B" ? [{ date: "2026-11-12", day: day("2026-11-12"), symbols: ["S01"] }] : [] }),
  symbolChanges: async () => ({ count: 0, changes: [] }),
  resultsCalendar: async (from: string, to: string) => ({ from, to, fetchedAt: 1, events: hub.variant === "B" ? [{ symbol: "S02", date: "2019-06-20", day: day("2019-06-20"), company: "S02", purpose: "Financial Results" }] : [] }),
  indices: async () => ({ indices: [], baskets: [], sectors: [], basketMethod: "" }),
};

vi.mock("@/server/providers/hub", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/providers/hub")>()), hubClient: () => fake }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  // No caches: nothing from a previous run (or the developer's own .cache) is read back, nothing is written.
  const readFile = ((file: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => (String(file).includes(".cache") ? Promise.reject(new Error("no cache in tests")) : (fs.readFile as (...args: unknown[]) => unknown)(file, ...rest))) as typeof fs.readFile;
  return { ...fs, readFile, mkdir: async () => undefined, writeFile: async () => undefined };
});

beforeAll(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    throw new Error(`unexpected request: ${String(input)}`);
  });
});
afterAll(() => vi.unstubAllGlobals());

/** Numbers to 6 significant digits; volatile fields (timings, stamps) dropped. */
function normal(value: unknown): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toPrecision(6)) : String(value);
  if (Array.isArray(value)) return value.map(normal);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["computedAt", "ms", "stamp", "startedAt", "finishedAt", "fetchedAt"].includes(key))
        .map(([key, entry]) => [key, normal(entry)]),
    );
  }
  return value;
}

const globalsBefore = new Set(Object.keys(globalThis));

/** Everything the Time Machine answers for D, with a fresh server (no caches) reading variant `variant` of the hub. */
async function asOfD(variant: Variant) {
  hub.variant = variant;
  // The app keeps its caches on globalThis (to survive hot reloads): start from none. (Prisma keeps its own.)
  for (const key of Object.keys(globalThis)) if (!globalsBefore.has(key) && !/prisma|debug/i.test(key)) delete (globalThis as Record<string, unknown>)[key];
  vi.resetModules();
  const { pastDay, quotesAsOf, lotsAsOf, resultsAsOf } = await import("./timeMachine");
  const { runScreener, trackRecord } = await import("./screener");
  const { strategyEvidence } = await import("./evidence");
  const { riskReturns } = await import("./riskReturns");
  const past = (await pastDay(REQUESTED))!;
  const screener = await vi.waitFor(
    async () => {
      const answer = await runScreener("fno", true, past);
      if (answer.status !== "ready") throw new Error(`screener ${answer.status}: ${answer.error ?? answer.progress?.message}`);
      return answer;
    },
    { timeout: 30_000, interval: 100 },
  );
  const track = await trackRecord("fno", past);
  const evidence = await vi.waitFor(
    async () => {
      const answer = await strategyEvidence(null, past);
      if (answer.status !== "ready") throw new Error(`evidence ${answer.status}: ${answer.error ?? ""}`);
      return answer;
    },
    { timeout: 60_000, interval: 200 },
  );
  const quotes = await quotesAsOf(["S00", "S01", "S02", "OLDCO", "NEWCO"], past.day);
  const returns = await vi.waitFor(
    async () => {
      const answer = await riskReturns(["S00", "S01", "S02", "OLDCO"], past);
      if (answer.status !== "ready") throw new Error(`returns ${answer.status}`);
      return answer;
    },
    { timeout: 30_000, interval: 100 },
  );
  return { past, screener, track, evidence, quotes, returns, lots: await lotsAsOf(past.day), results: await resultsAsOf(past.day) };
}

describe("the Time Machine reads nothing after the day shown", { timeout: 120_000 }, () => {
  let a: Awaited<ReturnType<typeof asOfD>>;
  let b: Awaited<ReturnType<typeof asOfD>>;

  beforeAll(async () => {
    a = await asOfD("A");
    b = await asOfD("B");
  }, 120_000);

  it("snaps the requested Sunday to the Friday before it", () => {
    expect(a.past).toMatchObject({ day: D, snapped: true, note: expect.stringMatching(/16 Jun 2019 was a Sunday: showing 14 Jun 2019/) });
  });

  it("runs the screener on bars up to D only, with that day's F&O list and prices as they traded then", () => {
    expect(a.screener.status).toBe("ready");
    expect(a.screener.timeMachine?.day).toBe(D);
    expect(a.screener.asOf?.eodDate).toBe(D);
    expect(a.screener.asOf?.live).toBe(false);
    expect(a.screener.universe?.count).toBe(31); // 30 stocks + OLDCO, on the list that day
    // The hub was asked for bars ending at D, and sent later ones anyway: they were cut off.
    expect(hub.candleCalls.every((call) => call.to !== undefined && call.to <= D)).toBe(true);
    expect(normal(b.screener)).toEqual(normal(a.screener));
  });

  it("replays the track record and the plan's evidence on trades that closed by D", () => {
    expect(a.track.status).toBe("ready");
    expect(a.track.to).toBeLessThanOrEqual(D);
    expect(normal(b.track)).toEqual(normal(a.track));
    expect(a.evidence.status).toBe("ready");
    if (a.evidence.status !== "ready" || b.evidence.status !== "ready") return;
    expect(a.evidence.asOf).toBe(D);
    expect(a.evidence.live).toBeNull();
    // The five years ending D, nothing after it.
    expect(a.evidence.table.to).toBeLessThanOrEqual(D);
    expect(a.evidence.table.from).toBeGreaterThanOrEqual(D - (5 * 365 - 3) * DAY);
    expect(a.evidence.stamp.params.asOf).toBe(D);
    expect(normal(b.evidence.table)).toEqual(normal(a.evidence.table));
    expect(b.evidence.universeNote).toBe(a.evidence.universeNote);
  });

  it("quotes D's closes, with S00 at the price it traded at before the later bonus", () => {
    expect(a.quotes.quotes.map((quote) => quote.symbol)).toEqual(["S00", "S01", "S02", "OLDCO"]); // NEWCO didn't trade yet
    expect(a.quotes.quotes.every((quote) => quote.asOf === D && quote.delayed)).toBe(true);
    const s00 = bars("S00", "A").find((bar) => bar.t === D)!;
    expect(a.quotes.quotes[0].ltp).toBeCloseTo(s00.c, 6);
    // B's hub serves S00 halved before its bonus; as of D it is the same price again.
    expect(b.quotes.quotes[0].ltp).toBeCloseTo(s00.c, 6);
    expect(normal(b.quotes)).toEqual(normal(a.quotes));
  });

  it("gives the plan's risk model the 120 sessions of returns ending at D (#40)", () => {
    expect(a.returns.status).toBe("ready");
    if (a.returns.status !== "ready") return;
    expect(a.returns.sessions).toHaveLength(120);
    expect(a.returns.sessions.at(-1)).toBe(D);
    expect(a.returns.returns.S00.every((value) => value !== null)).toBe(true);
    // B's later bonus rescales S00's bars before D: returns don't change.
    expect(b.returns).toEqual(a.returns);
  });

  it("gives lots and results as known on D, never today's", () => {
    // Lots weren't in NSE's files in 2019: a ₹5 lakh stand-in at D's close, not today's lots (which differ in B).
    expect(a.lots.asOf?.notes[0]).toMatch(/₹5 lakh/);
    expect(a.lots.lots.S00).toBe(Math.round(500_000 / bars("S00", "A").find((bar) => bar.t === D)!.c));
    expect(normal(b.lots)).toEqual(normal(a.lots));
    // B's results date on 20 Jun 2019 is after D: not shown.
    expect(b.results.events).toEqual([]);
    expect(normal(b.results)).toEqual(normal(a.results));
  });
});
