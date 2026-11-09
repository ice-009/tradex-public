import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// With a Market Data Hub, lot sizes, the F&O ban list, the results calendar and
// the F&O list come from the hub and nothing is downloaded from NSE or Fyers.
// The hub client is a fake; any other fetch fails the test.

const hub = vi.hoisted(() => ({
  calls: [] as string[],
  client: {
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
  },
}));

vi.mock("@/server/providers/hub", () => ({ hubClient: () => hub.client }));
vi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs/promises")>()), mkdir: async () => undefined, writeFile: async () => undefined }));

beforeAll(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    throw new Error(`unexpected download: ${String(input)}`);
  });
});
afterAll(() => vi.unstubAllGlobals());

describe("reference data from the hub", () => {
  it("lot sizes", async () => {
    const { getLotSizes } = await import("./lotSizes");
    expect(await getLotSizes()).toEqual({ lots: { SBIN: 750, "M&M": 200 }, source: "hub", fetchedAt: 1_000 });
  });

  it("the F&O ban list", async () => {
    const { getFnoBan } = await import("./fnoBan");
    expect(await getFnoBan()).toMatchObject({ available: true, tradeDate: Date.UTC(2026, 10, 10), symbols: ["KAYNES"] });
  });

  it("the results calendar, one event per stock and day", async () => {
    const { getResultsCalendar } = await import("./resultsCalendar");
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
