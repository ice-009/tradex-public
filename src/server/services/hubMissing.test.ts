import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Without HUB_URL / HUB_KEY Tradex has no market data of its own: the status
// routes say "Connect a Market Data Hub", charts get labelled sample candles,
// and the screener's store reports what to set — no Fyers or NSE fallback, and
// no request to anywhere.

vi.mock("@/server/data/historyStore", () => ({ getHistory: async () => [], peekHistory: async () => null }));
vi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs/promises")>()), mkdir: async () => undefined, writeFile: async () => undefined, readFile: async () => Promise.reject(new Error("no file")) }));

beforeAll(() => {
  vi.stubEnv("HUB_URL", "");
  vi.stubEnv("HUB_KEY", "");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    throw new Error(`unexpected request: ${String(input)}`);
  });
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("no Market Data Hub configured", () => {
  it("reports it from /api/broker/status and the top bar's usage", async () => {
    const { hubApiUsage, hubBrokerStatus, marketDataStatus } = await import("./marketConnection");
    const status = await hubBrokerStatus();
    expect(status).toMatchObject({ connected: false, mode: "hub", label: "Connect a Market Data Hub", hub: { configured: false, reachable: false } });
    expect(status.error).toMatch(/HUB_URL and HUB_KEY.*github\.com\/ice-009\/market-data-hub/);
    expect(await hubApiUsage()).toMatchObject({ usedToday: 0, hub: { configured: false } });
    expect(await marketDataStatus()).toMatchObject({ hub: { configured: false }, datasets: [], budget: null });
  });

  it("draws charts from labelled sample data and says why", async () => {
    const { getChart } = await import("./chart");
    const chart = await getChart("me@example.com", { symbol: "SBIN", interval: "1d", range: "1y" });
    expect(chart).toMatchObject({ source: "sample", sourceId: "sample", sourceReason: "No Market Data Hub is configured (HUB_URL, HUB_KEY)." });
    expect(chart.priceSeries.length).toBeGreaterThan(100);
  });

  it("gives the screener's store nothing to read and says what to set", async () => {
    const { screenerStore, HUB_REQUIRED } = await import("@/server/providers/dailyStore");
    await screenerStore.sync(["SBIN", "NIFTY"]);
    expect(screenerStore.progress).toMatchObject({ phase: "error", message: HUB_REQUIRED });
    expect(screenerStore.getBars("SBIN")).toEqual([]);
  });

  it("has no lot sizes, ban list or results calendar to offer", async () => {
    const { getFnoBan, getLotSizes, getResultsCalendar } = await import("@/server/providers/reference");
    expect(await getLotSizes()).toMatchObject({ lots: {}, source: "none" });
    expect(await getFnoBan()).toMatchObject({ available: false });
    expect(await getResultsCalendar()).toMatchObject({ available: false, events: [] });
  });
});
