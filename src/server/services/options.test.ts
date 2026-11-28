import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OptionDay, OptionLeg } from "@/core/options/summary";
import { HubClient } from "@/server/providers/hub/client";

// The Options panel's server side (issue #36) against a scripted Market Data
// Hub: the real HubClient over a fake fetch, so the requests Tradex makes (and
// the hub's error answers) are exactly what goes over the wire.
//
//  - No look-ahead: an underlying's history and the day's cross-section as of a
//    past day D come out the same from two hubs that differ only after D — one
//    of which also ignores `to` and sends every later day anyway — and Tradex
//    never asks for a day after D. A cross-section dated after D is refused.
//  - A hub too old to have the endpoints (404), one with nothing stored yet
//    (503 not_ready, not retried) and a day with nothing on or before it each
//    get their own message.

const DAY = 86_400_000;
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const D = day("2024-06-14");
const TODAY = day("2026-11-27");
const PAST = { day: D, requested: D, snapped: false, note: null };

const SESSIONS = (() => {
  const out: number[] = [];
  for (let t = day("2022-01-03"); t <= TODAY; t += DAY) if (new Date(t).getUTCDay() % 6 !== 0) out.push(t);
  return out;
})();

type Variant = "A" | "B";

function leg(t: number, spot: number, iv: number, days: number, flags: string[] = []): OptionLeg {
  const forward = spot * (1 + 0.07 * (days / 365));
  const straddle = 0.8 * iv * Math.sqrt(days / 365) * forward;
  const strike = Math.round(forward / 10) * 10;
  return {
    expiry: iso(t + days * DAY),
    expiryDay: t + days * DAY,
    days,
    forward,
    atmStrike: strike,
    straddle,
    expectedMovePct: (100 * straddle) / forward,
    atmIv: iv,
    callIv: iv,
    putIv: iv + 0.002,
    cpSpread: -0.002,
    iv25Put: iv + 0.02,
    iv25Call: iv - 0.01,
    skew25: 0.03,
    maxPain: strike - 10,
    callWall: strike + 50,
    callWallOi: 1_000_000,
    putWall: strike - 50,
    putWallOi: 900_000,
    callOi: 5_000_000,
    putOi: 4_000_000,
    pcrOi: 0.8,
    strikes: 30,
    liquidStrikes: 25,
    flags,
  };
}

/** A day's summary of `symbol`: the same up to D in both variants; after D, B's IV is far higher and its prices different. */
function summary(symbol: string, t: number, variant: Variant): OptionDay & { symbol: string } {
  const i = SESSIONS.indexOf(t);
  const after = t > D && variant === "B";
  const spot = (symbol === "NIFTY" ? 22_000 : 1_000) * (1 + 0.1 * Math.sin(i / 50)) * (after ? 1.5 : 1);
  const iv30 = (symbol === "NIFTY" ? 0.13 : 0.28) + 0.04 * Math.sin(i / 17) + (after ? 0.5 : 0);
  return {
    symbol,
    date: iso(t),
    day: t,
    ticker: symbol,
    kind: symbol === "NIFTY" ? "index" : "stock",
    spot,
    lot: 500,
    lotEstimated: false,
    expiries: 3,
    callOi: 6_000_000,
    putOi: 5_000_000,
    callChgOi: 10_000,
    putChgOi: -5_000,
    callVolume: 20_000,
    putVolume: 15_000,
    pcrOi: 0.8333,
    pcrVolume: 0.75,
    optionShares: 17_500_000,
    stockVolume: 4_000_000,
    optionToStock: 4.375,
    iv30,
    ivPercentile: 50,
    flags: [],
    near: leg(t, spot, iv30 - 0.01, 13, symbol === "NIFTY" ? ["FORWARD_PARITY"] : []),
    next: leg(t, spot, iv30 + 0.01, 41),
  };
}

const UNDERLYINGS = ["NIFTY", "SBIN", "RELIANCE"];

const hub = vi.hoisted(() => ({
  variant: "A" as "A" | "B",
  /** Ignore the summary's `to` and answer up to today (a cross-section from after D is its own test). */
  leaky: false,
  /** A scripted answer instead of the generated data. */
  reply: null as null | ((url: URL) => { status: number; body: unknown }),
  requests: [] as URL[],
  client: null as unknown,
}));

function answer(url: URL): { status: number; body: unknown } {
  if (hub.reply) return hub.reply(url);
  if (url.pathname === "/v1/options/summary") {
    const symbol = url.searchParams.get("symbol")!;
    const from = day(url.searchParams.get("from") ?? iso(TODAY - 365 * DAY));
    const to = hub.leaky ? TODAY : day(url.searchParams.get("to") ?? iso(TODAY));
    const days = UNDERLYINGS.includes(symbol) ? SESSIONS.filter((t) => t >= from && t <= to).map((t) => summary(symbol, t, hub.variant)) : [];
    return { status: 200, body: { symbol, from: iso(from), to: iso(to), knownFrom: "2022-01-03", knownFromDay: day("2022-01-03"), lastDate: iso(TODAY), lastDay: TODAY, days: days.map((entry) => ({ ...entry, symbol: undefined })) } };
  }
  if (url.pathname === "/v1/options/day") {
    const asked = day(url.searchParams.get("date") ?? iso(TODAY));
    const t = SESSIONS.filter((session) => session <= asked).at(-1)!;
    return { status: 200, body: { date: iso(t), day: t, count: UNDERLYINGS.length, rows: UNDERLYINGS.map((symbol) => summary(symbol, t, hub.variant)) } };
  }
  return { status: 404, body: { error: "Not found.", code: "not_found" } };
}

vi.mock("@/server/providers/hub", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/providers/hub")>()), hubClient: () => hub.client }));

function freshHub() {
  hub.requests = [];
  hub.client = new HubClient(
    { url: "http://hub.test", key: "mdh_test", timeoutMs: 5_000 },
    {
      sleep: async () => {},
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        hub.requests.push(url);
        const { status, body } = answer(url);
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch,
    },
  );
}

/** The service with no caches left from an earlier test. */
async function service() {
  delete (globalThis as { hubOptions?: unknown }).hubOptions;
  vi.resetModules();
  return import("./options");
}

beforeEach(() => {
  hub.variant = "A";
  hub.leaky = false;
  hub.reply = null;
  freshHub();
});

/** Numbers to 9 significant digits, so the comparison isn't about float noise. */
const normal = (value: unknown): unknown =>
  typeof value === "number" ? Number(value.toPrecision(9)) : Array.isArray(value) ? value.map(normal) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normal(entry)])) : value;

describe("as of a past day, nothing after it", () => {
  async function asOfD(variant: Variant, leaky: boolean) {
    hub.variant = variant;
    hub.leaky = leaky;
    freshHub();
    const { optionsFor, optionsDayFor } = await service();
    const history = await optionsFor("SBIN", "5y", PAST, TODAY);
    const index = await optionsFor("NIFTY", "1y", PAST, TODAY);
    const cross = await optionsDayFor(null, PAST, TODAY);
    return { history, index, cross, requests: hub.requests };
  }

  it("answers the same whatever happened after D, and never asks the hub for a later day", async () => {
    const a = await asOfD("A", false);
    const b = await asOfD("B", true);
    expect(a.history.status).toBe("ready");
    if (a.history.status !== "ready") return;
    expect(a.history.day.day).toBe(D);
    expect(a.history.history.at(-1)!.day).toBe(D);
    expect(a.history.history[0].day).toBeGreaterThanOrEqual(day("2022-01-03"));
    expect(a.history.lastDate).toBeNull(); // the hub's newest day is after D: not said
    expect(a.history.rank?.days).toBeGreaterThan(200);
    expect(a.history.rank?.to).toBe(D);
    expect(a.cross).toMatchObject({ status: "ready", day: D });
    // B's hub sent ~2.5 years of days after D, with IVs 50 points higher: none of them got in.
    expect(normal({ ...b, requests: [] })).toEqual(normal({ ...a, requests: [] }));
    for (const url of [...a.requests, ...b.requests]) {
      const last = url.searchParams.get("to") ?? url.searchParams.get("date");
      expect(last, url.toString()).toBe(iso(D));
    }
  });

  it("refuses a cross-section from after D (a hub ignoring `date`)", async () => {
    hub.reply = () => ({ status: 200, body: { date: iso(TODAY), day: TODAY, count: 1, rows: [summary("SBIN", SESSIONS.at(-1)!, "A")] } });
    const { optionsDayFor } = await service();
    expect(await optionsDayFor(null, PAST, TODAY)).toMatchObject({ status: "unavailable", reason: "not_found" });
  });
});

describe("one underlying", () => {
  it("reads the newest day in full, with the IV history and its rank", async () => {
    const { optionsFor } = await service();
    const live = await optionsFor("SBIN", "1y", null, TODAY);
    expect(live.status).toBe("ready");
    if (live.status !== "ready") return;
    expect(live.day.day).toBe(SESSIONS.at(-1));
    expect(live.lastDate).toBe(iso(TODAY));
    expect(live.view.term.near?.days).toBe(13);
    expect(live.view.move?.pct).toBeCloseTo(live.day.near!.expectedMovePct!, 6);
    expect(live.view.levels?.callWall?.strike).toBe(live.day.near!.callWall);
    // The year up to the day (the range's first day, exactly 365 days back, is outside the window).
    expect(live.rank?.days).toBe(live.history.filter((point) => point.day > live.day.day - 365 * DAY).length);
    expect(live.notes.at(-1)).toMatch(/prices as traded on/);
    expect(hub.requests[0].searchParams.get("from")).toBe(iso(TODAY - 365 * DAY));
  });

  it("asks a future's underlying, and says so for a symbol without NSE options", async () => {
    const { optionsFor } = await service();
    expect(await optionsFor("SBIN26NOVFUT", "1y", null, TODAY)).toMatchObject({ status: "ready", symbol: "SBIN" });
    expect(await optionsFor("NSE:NIFTY50-INDEX", "1y", null, TODAY)).toMatchObject({ status: "ready", symbol: "NIFTY" });
    expect(await optionsFor("SENSEX", "1y", null, TODAY)).toMatchObject({ status: "empty", message: expect.stringMatching(/no NSE options/) });
    expect(await optionsFor("TINYCO", "1y", null, TODAY)).toMatchObject({ status: "empty", message: expect.stringMatching(/No option summaries for TINYCO/) });
  });

  it("says when the hub's archive doesn't reach back to the day yet", async () => {
    const { optionsFor } = await service();
    expect(await optionsFor("SBIN", "1y", { ...PAST, day: day("2015-07-08") }, TODAY)).toMatchObject({ status: "empty", message: expect.stringMatching(/start on 3 Jan 2022/) });
  });

  it("asks for all of it back to June 2001 on 'all'", async () => {
    const { optionsFor } = await service();
    await optionsFor("NIFTY", "all", null, TODAY);
    expect(hub.requests[0].searchParams.get("from")).toBe("2001-06-04");
  });
});

describe("a hub that can't answer", () => {
  it("an old hub (404 on /v1/options) is told to update", async () => {
    hub.reply = () => ({ status: 404, body: { error: "Not found.", code: "not_found" } });
    const { optionsFor, optionsDayFor } = await service();
    expect(await optionsFor("SBIN", "1y", null, TODAY)).toMatchObject({ status: "unavailable", reason: "old_hub", message: expect.stringMatching(/update it to a version with market-data-hub#30/) });
    expect(await optionsDayFor(null, null, TODAY)).toMatchObject({ status: "unavailable", reason: "old_hub" });
  });

  it("a hub with nothing stored yet (not_ready) points at the backfill, asked once, not retried", async () => {
    hub.reply = () => ({ status: 503, body: { error: "No option summaries are stored yet…", code: "not_ready" } });
    const { optionsFor } = await service();
    expect(await optionsFor("SBIN", "1y", null, TODAY)).toMatchObject({ status: "unavailable", reason: "not_ready", message: expect.stringMatching(/hub data nse-history --only options/) });
    expect(hub.requests).toHaveLength(1);
    // Kept for a minute: asking again doesn't go to the hub.
    await optionsFor("SBIN", "1y", null, TODAY);
    expect(hub.requests).toHaveLength(1);
  });

  it("a day with nothing on or before it, a key without the fo scope, and no hub", async () => {
    hub.reply = (url) =>
      url.pathname === "/v1/options/day"
        ? { status: 404, body: { error: "No option summaries stored on or before 2001-01-01.", code: "not_found" } }
        : { status: 403, body: { error: 'This key lacks the "fo" scope.', code: "forbidden" } };
    const { optionsFor, optionsDayFor } = await service();
    expect(await optionsDayFor(null, { ...PAST, day: day("2001-01-01") }, TODAY)).toMatchObject({ status: "unavailable", reason: "not_found", message: "No option summaries stored on or before 2001-01-01." });
    expect(await optionsFor("SBIN", "1y", null, TODAY)).toMatchObject({ status: "unavailable", reason: "error", message: expect.stringMatching(/needs the "fo" scope/) });
    hub.client = null;
    const fresh = await service();
    expect(await fresh.optionsFor("SBIN", "1y", null, TODAY)).toMatchObject({ status: "unavailable", reason: "no_hub" });
  });
});

describe("the screener's option facts", () => {
  it("are the day's rows as of the date, filtered by kind in the cross-section", async () => {
    const { optionsDayFor } = await service();
    const stocks = await optionsDayFor("stock", null, TODAY);
    expect(stocks.status === "ready" && stocks.rows.map((row) => row.symbol)).toEqual(["SBIN", "RELIANCE"]);
    const { optionFactsWithin, optionFactsNow } = await import("@/server/providers/options");
    const facts = await optionFactsWithin(iso(D), true, 2_000);
    expect(facts?.day).toBe(D);
    expect(facts?.bySymbol.get("SBIN")).toMatchObject({ day: D, iv30: summary("SBIN", D, "A").iv30, moveDays: 13 });
    // The same answer, from the cache, without waiting.
    expect(optionFactsNow(iso(D), true)).toBe(facts);
  });
});
