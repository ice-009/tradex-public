import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LiveEntry } from "@/core/screener/liveRecord";

const DAY = Date.parse("2026-11-05T00:00:00Z");
const NEXT = Date.parse("2026-11-06T00:00:00Z");
const entry = (symbol: string, price: number, at: number): LiveEntry => ({ screenId: "btst-closing-strength", symbol, day: DAY, firstSeenAt: 1, firstPrice: 100, entryAt: at, entryPrice: price, stop: 98 });

let dir = "";
let store: typeof import("./btstRecord");

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "btstrecord-"));
  process.env.MARKET_DB_PATH = path.join(dir, "market.db");
  store = await import("./btstRecord");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("BTST live record storage", () => {
  it("upserts a day's entries and remembers the days watched", () => {
    store.writeEntries(DAY, 10, [entry("AAA", 100, 10), entry("BBB", 50, 10)]);
    store.writeEntries(DAY, 20, [entry("AAA", 101, 20)]);
    expect(store.readDay(DAY).map((item) => [item.symbol, item.entryPrice, item.entryAt, item.firstPrice])).toEqual([
      ["AAA", 101, 20, 100],
      ["BBB", 50, 10, 100],
    ]);
    expect(store.watchedDays()).toEqual({ since: DAY, days: 1 });
  });

  it("settles once and leaves a settled entry alone", () => {
    expect(store.readUnsettled(NEXT)).toHaveLength(2);
    expect(store.readUnsettled(DAY)).toHaveLength(0);
    const settled = { exitDay: NEXT, exitPrice: 103, grossPct: 1.98, netPct: 1.8, gapStop: false };
    store.writeSettlements([{ entry: entry("AAA", 101, 20), settled, qty: 250, costPreset: "futures-2026" }]);
    store.writeEntries(DAY, 30, [entry("AAA", 99, 30)]);
    expect(store.readUnsettled(NEXT).map((item) => item.symbol)).toEqual(["BBB"]);
    const trades = store.readTrades();
    expect(trades.find((trade) => trade.symbol === "AAA")).toMatchObject({ entryPrice: 101, settled });
    expect(trades.find((trade) => trade.symbol === "BBB")?.settled).toBeNull();
  });
});
