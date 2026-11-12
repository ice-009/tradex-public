import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Lot sizes, the ban list, the results calendar, the F&O list, open interest,
// point-in-time membership and futures contracts all come from the hub. The
// hub client is a fake; any other fetch (NSE, a broker) fails the test.

const hub = vi.hoisted(() => ({
  calls: [] as string[],
  contracts: new Map<string, unknown>(),
}));

const DAY = 86_400_000;
const today = () => {
  const ist = Date.now() + 5.5 * 3_600_000;
  return ist - (ist % DAY);
};
const iso = (day: number) => new Date(day).toISOString().slice(0, 10);

vi.mock("@/server/providers/hub", async () => {
  const { HubError: Error404 } = await import("@/server/providers/hub/client");
  const client = {
    lots: async () => {
      hub.calls.push("lots");
      return { source: "nse_mktlots", fetchedAt: 1_000, count: 2, lots: { SBIN: 750, "M&M": 200 } };
    },
    foBan: async () => {
      hub.calls.push("foBan");
      return { tradeDate: "2026-11-10", symbols: ["KAYNES"], fetchedAt: 2_000, current: true };
    },
    resultsCalendar: async (from: string, to: string) => {
      hub.calls.push(`results ${from}..${to}`);
      return {
        from,
        to,
        fetchedAt: 3_000,
        events: [
          { symbol: "SBIN", date: "2026-11-12", day: Date.UTC(2026, 10, 12), company: "State Bank of India", purpose: "Financial Results" },
          { symbol: "SBIN", date: "2026-11-12", day: Date.UTC(2026, 10, 12), company: "State Bank of India", purpose: "Dividend" },
        ],
      };
    },
    universe: async (name: string) => {
      hub.calls.push(`universe ${name}`);
      const members = Array.from({ length: 60 }, (_, index) => ({ symbol: `STOCK${index}`, name: index ? `Stock ${index}` : "", industry: "" }));
      return { name, source: "nse_fo_bhavcopy", asOf: "2026-11-06", count: members.length, members: [{ symbol: "sbin", name: "", industry: "" }, ...members] };
    },
    foOiDay: async () => {
      hub.calls.push("foOiDay");
      const day = today() - DAY;
      const leg = (expiry: string, close: number, prevClose: number) => ({ expiry, close, settle: close, prevClose, volume: 10, oi: 1_000, chgOi: 60 });
      return {
        date: iso(day),
        day,
        rows: [{ symbol: "SBIN", date: iso(day), day, nseSymbol: "SBIN", expiries: 3, lot: 750, underlying: 1000, near: leg("2026-11-24", 1010, 1000), next: leg("2026-12-29", 1015, 1004), oi: 1_060, chgOi: 60 }],
      };
    },
    foMembers: async (from: number, to: number) => {
      hub.calls.push(`members ${iso(from)}..${iso(to)}`);
      return { from: iso(from), to: iso(to), days: [{ date: "2026-11-05", day: Date.UTC(2026, 10, 5), symbols: ["SBIN", "OLDCO"] }] };
    },
    foContracts: async (symbol: string) => {
      hub.calls.push(`contracts ${symbol}`);
      const answer = hub.contracts.get(symbol);
      if (!answer) throw new Error404("Market Data Hub 404 not_found: no futures", 404, "not_found");
      return answer;
    },
  };
  return { hubClient: () => client, HubError: Error404 };
});
vi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs/promises")>()), mkdir: async () => undefined, writeFile: async () => undefined }));

beforeAll(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    throw new Error(`unexpected download: ${String(input)}`);
  });
});
afterAll(() => vi.unstubAllGlobals());

describe("reference data from the hub", () => {
  it("lot sizes", async () => {
    const { getLotSizes } = await import("./reference");
    expect(await getLotSizes()).toEqual({ lots: { SBIN: 750, "M&M": 200 }, source: "hub", fetchedAt: 1_000 });
  });

  it("the F&O ban list", async () => {
    const { getFnoBan } = await import("./reference");
    expect(await getFnoBan()).toMatchObject({ available: true, tradeDate: Date.UTC(2026, 10, 10), symbols: ["KAYNES"] });
  });

  it("the results calendar, one event per stock and day", async () => {
    const { getResultsCalendar } = await import("./reference");
    const calendar = await getResultsCalendar();
    expect(calendar.available).toBe(true);
    expect(calendar.events).toEqual([{ symbol: "SBIN", company: "State Bank of India", date: Date.UTC(2026, 10, 12), purpose: "Financial Results · Dividend" }]);
  });

  it("the F&O list, with names filled in from the Nifty 500 file", async () => {
    const { getUniverse } = await import("./universe");
    const fno = await getUniverse("fno");
    expect(fno).toHaveLength(61);
    expect(fno[0]).toMatchObject({ symbol: "SBIN", name: "State Bank of India", industry: "Financial Services" });
    expect(hub.calls).toContain("universe fno");
  });
});

describe("F&O data from the hub", () => {
  it("OI facts for the screener from the newest F&O day", async () => {
    const { latestOiFacts, oiSettled } = await import("./foData");
    expect(latestOiFacts()).toBeNull(); // never waits: the first call starts the request
    await oiSettled();
    const facts = latestOiFacts()!;
    expect(facts.day).toBe(today() - DAY);
    expect(facts.bySymbol.get("SBIN")).toMatchObject({ buildup: "long-buildup", oiPct: expect.closeTo(6, 5), basisPct: expect.closeTo(1, 5) });
    expect(hub.calls.filter((call) => call === "foOiDay")).toHaveLength(1);
  });

  it("maps a hub row's expiries to day keys", async () => {
    const { toFoRecord } = await import("./foData");
    const leg = { expiry: "2026-11-24", close: 1, settle: 1, prevClose: 1, volume: 1, oi: 1, chgOi: 0 };
    expect(toFoRecord({ symbol: "SBIN", date: "2026-11-05", day: Date.UTC(2026, 10, 5), near: leg, next: null, oi: 1, chgOi: 0 })).toMatchObject({ day: Date.UTC(2026, 10, 5), near: { expiry: Date.UTC(2026, 10, 24) }, next: null });
    expect(toFoRecord({ symbol: "SBIN", date: "2026-11-05", day: Date.UTC(2026, 10, 5), near: { ...leg, expiry: "soon" }, oi: 1, chgOi: 0 })).toBeNull();
  });

  it("point-in-time F&O membership over a range, cached", async () => {
    const { foMembership } = await import("./foData");
    const from = Date.UTC(2022, 0, 1);
    const to = Date.UTC(2026, 10, 10);
    const byDay = await foMembership(from, to);
    expect([...byDay.entries()].map(([day, symbols]) => [day, [...symbols]])).toEqual([[Date.UTC(2026, 10, 5), ["SBIN", "OLDCO"]]]);
    await foMembership(from, to);
    expect(hub.calls.filter((call) => call.startsWith("members"))).toEqual(["members 2022-01-01..2026-11-10"]);
  });
});

describe("futures contracts from the hub", () => {
  it("reads a stock's contracts as hub tickers with day-key expiries and the lot", async () => {
    hub.contracts.set("SBIN", { symbol: "SBIN", asOf: "2026-11-05", lot: 750, contracts: [{ ticker: "SBIN26NOVFUT", expiry: "2099-11-24", kind: "near" }, { ticker: "SBIN26DECFUT", expiry: "2099-12-29", kind: "next" }] });
    const { getFutures } = await import("@/server/services/futures");
    expect(await getFutures("sbin")).toEqual({
      symbol: "SBIN",
      available: true,
      lot: 750,
      contracts: [
        { ticker: "SBIN26NOVFUT", expiry: Date.UTC(2099, 10, 24), kind: "near" },
        { ticker: "SBIN26DECFUT", expiry: Date.UTC(2099, 11, 29), kind: "next" },
      ],
    });
    await getFutures("SBIN");
    expect(hub.calls.filter((call) => call === "contracts SBIN")).toHaveLength(1);
  });

  it("remembers a stock with no futures (404 not_found) and refuses junk symbols", async () => {
    const { getFutures } = await import("@/server/services/futures");
    expect(await getFutures("TCS")).toEqual({ symbol: "TCS", available: false, lot: null, contracts: [] });
    await getFutures("TCS");
    expect(hub.calls.filter((call) => call === "contracts TCS")).toHaveLength(1);
    expect((await getFutures("../etc")).available).toBe(false);
    expect(hub.calls.some((call) => call.includes("etc"))).toBe(false);
  });

  it("lists the near-month tickers already known, loading the rest in the background", async () => {
    hub.contracts.set("INFY", { symbol: "INFY", asOf: "2026-11-05", lot: 400, contracts: [{ ticker: "INFY99NOVFUT", expiry: "2099-11-24", kind: "near" }] });
    const { knownNearFutures } = await import("./futures");
    expect(knownNearFutures(["SBIN", "INFY"])).toEqual(new Map([["SBIN", "SBIN26NOVFUT"]]));
    await vi.waitFor(() => expect(knownNearFutures(["SBIN", "INFY"]).get("INFY")).toBe("INFY99NOVFUT"));
  });
});

