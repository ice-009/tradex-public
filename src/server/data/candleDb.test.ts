import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DAY = 86_400_000;
const candle = (day: number, close: number) => ({ date: new Date(day * DAY).toISOString(), open: close, high: close + 1, low: close - 1, close, volume: 10 });

let dir = "";
let db: typeof import("./candleDb");

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "candledb-"));
  process.env.MARKET_DB_PATH = path.join(dir, "market.db");
  db = await import("./candleDb");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("candle database", () => {
  it("stores a series and reads it back in order", () => {
    db.writeSeries("A:D", { coveredFrom: 0, syncedAt: 5, candles: [candle(2, 102), candle(0, 100), candle(1, 101)] }, -Infinity);
    expect(db.readCandles("A:D").map((c) => c.close)).toEqual([100, 101, 102]);
    expect(db.readSeries("A:D")).toMatchObject({ coveredFrom: 0, syncedAt: 5, count: 3, firstT: 0, lastT: 2 * DAY });
  });

  it("replaces only from the tail onward and keeps older candles", () => {
    db.writeSeries("A:D", { coveredFrom: 0, syncedAt: 6, candles: [candle(2, 103), candle(3, 104)] }, 2 * DAY);
    expect(db.readCandles("A:D").map((c) => c.close)).toEqual([100, 101, 103, 104]);
  });

  it("drops candles older than the coverage and reads from a date", () => {
    db.writeSeries("A:D", { coveredFrom: 1 * DAY, syncedAt: 7, candles: [] }, 10 * DAY);
    expect(db.readCandles("A:D").map((c) => c.close)).toEqual([101, 103, 104]);
    expect(db.readCandles("A:D", 3 * DAY).map((c) => c.close)).toEqual([104]);
  });

  it("reports many series and totals", () => {
    db.writeSeries("B:15", { coveredFrom: 0, syncedAt: 1, candles: [candle(0, 50)] }, -Infinity);
    expect([...db.readSeriesMany(["A:D", "B:15", "missing"]).keys()]).toEqual(["A:D", "B:15"]);
    expect(db.dbStats()).toMatchObject({ series: 2, candles: 4 });
  });
});
