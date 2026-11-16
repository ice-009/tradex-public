import { describe, expect, it } from "vitest";
import { HubClient } from "./client";

// The hub endpoints Tradex reads instead of fetching market data itself:
// batch candles, one F&O day, F&O membership ranges and futures contracts.
// A scripted fetch stands in for the hub; no network.

const KEY = "mdh_secret-key-123";
const DAY = 86_400_000;

type Reply = { status: number; body?: unknown };

function fakeHub(replies: Reply[]) {
  const requests: URL[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    requests.push(new URL(String(input)));
    const reply = replies.shift() ?? { status: 500, body: { error: "no more replies", code: "test" } };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  }) as typeof globalThis.fetch;
  return { client: new HubClient({ url: "http://hub.test", key: KEY, timeoutMs: 5_000 }, { fetch, sleep: async () => {}, retries: 0 }), requests };
}

const batch = (names: string[], extra: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: { tf: "1d", from: 1, to: 2, series: Object.fromEntries(names.map((name) => [name, { complete: true, coverage: null, candles: [] }])), queued: [], unknown: [], ...extra },
});

describe("GET /v1/candles/batch", () => {
  it("asks 300 symbols at a time and merges series, queued, unknown and the broker warning", async () => {
    const symbols = Array.from({ length: 450 }, (_, index) => `S${index}`);
    const { client, requests } = fakeHub([batch(["S0"], { queued: ["S1"] }), batch(["S300"], { unknown: ["S449"], warning: `budget spent (${KEY})`, reason: "budget" })]);
    const answer = await client.candlesBatch(symbols, "1d", 1_000.5);
    expect(requests.map((url) => url.pathname)).toEqual(["/v1/candles/batch", "/v1/candles/batch"]);
    expect(requests.map((url) => url.searchParams.get("symbols")!.split(",").length)).toEqual([300, 150]);
    expect(requests[0].searchParams.get("tf")).toBe("1d");
    expect(requests[0].searchParams.get("from")).toBe("1000");
    expect(Object.keys(answer.series)).toEqual(["S0", "S300"]);
    expect(answer).toMatchObject({ queued: ["S1"], unknown: ["S449"], reason: "budget" });
    expect(answer.warning).toContain("budget spent");
    expect(answer.warning).not.toContain(KEY);
  });
});

describe("GET /v1/fo/members?from&to", () => {
  it("asks in ranges of at most 400 days and joins the days", async () => {
    const from = Date.UTC(2022, 0, 1);
    const { client, requests } = fakeHub([
      { status: 200, body: { from: "", to: "", days: [{ date: "2022-01-03", day: Date.UTC(2022, 0, 3), symbols: ["SBIN"] }] } },
      { status: 200, body: { from: "", to: "", days: [] } },
      { status: 200, body: { from: "", to: "", days: [{ date: "2024-09-26", day: Date.UTC(2024, 8, 26), symbols: ["INFY"] }] } },
    ]);
    const answer = await client.foMembers(from, from + 999 * DAY);
    expect(requests.map((url) => [url.pathname, url.searchParams.get("from"), url.searchParams.get("to")])).toEqual([
      ["/v1/fo/members", "2022-01-01", "2023-02-04"],
      ["/v1/fo/members", "2023-02-05", "2024-03-10"],
      ["/v1/fo/members", "2024-03-11", "2024-09-26"],
    ]);
    expect(answer.days.map((entry) => entry.symbols[0])).toEqual(["SBIN", "INFY"]);
  });
});

describe("GET /v1/fo/oi/day and /v1/fo/contracts", () => {
  it("reads the newest F&O day (no date) and a stock's contracts as hub tickers", async () => {
    const { client, requests } = fakeHub([
      { status: 200, body: { date: "2026-11-05", day: Date.UTC(2026, 10, 5), rows: [] } },
      { status: 200, body: { symbol: "M&M", asOf: "2026-11-05", lot: 200, contracts: [{ ticker: "M&M26NOVFUT", expiry: "2026-11-24", kind: "near" }] } },
    ]);
    expect((await client.foOiDay()).date).toBe("2026-11-05");
    expect(requests[0].pathname).toBe("/v1/fo/oi/day");
    expect(requests[0].search).toBe("");
    expect((await client.foContracts("M&M")).contracts[0].ticker).toBe("M&M26NOVFUT");
    expect(requests[1].searchParams.get("symbol")).toBe("M&M");
  });

  it("passes the hub's 404s on with their codes", async () => {
    const { client } = fakeHub([
      { status: 404, body: { error: "no F&O file for that day", code: "no_data" } },
      { status: 404, body: { error: "no futures", code: "not_found" } },
    ]);
    await expect(client.foOiDay("2026-11-08")).rejects.toMatchObject({ status: 404, code: "no_data" });
    await expect(client.foContracts("TCS")).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});
