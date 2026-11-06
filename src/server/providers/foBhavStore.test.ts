import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoDayKey } from "@/core/parsers/foBhavcopy";

const D1 = isoDayKey("2025-10-29")!;
const D2 = isoDayKey("2025-10-30")!;
const HOLIDAY = isoDayKey("2025-10-22")!;

let dir = "";
let store: typeof import("./foBhavStore");
let provider: typeof import("./foBhavcopy");

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "fobhav-"));
  process.env.MARKET_DB_PATH = path.join(dir, "market.db");
  store = await import("./foBhavStore");
  provider = await import("./foBhavcopy");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function realDay() {
  const result = provider.readFoZip(D1, readFileSync(path.join(__dirname, "fixtures", "fo-bhav-20251029.csv.zip")));
  if (result.kind !== "ok") throw new Error(result.kind);
  return result.records;
}

describe("F&O bhavcopy storage", () => {
  it("stores a day and reads it back unchanged", () => {
    const records = realDay();
    store.writeFoDay(D1, records, 100);
    expect(store.readFoDay(D1)).toEqual(records);
    expect(store.latestFoDay()).toEqual({ day: D1, records });
  });

  it("replaces a day on rewrite and keeps the other days", () => {
    const [first] = realDay();
    store.writeFoDay(D2, [{ ...first, day: D2, next: null }], 200);
    store.writeFoDay(D2, [{ ...first, day: D2, next: null, oi: 1 }], 300);
    expect(store.readFoDay(D2)).toEqual([{ ...first, day: D2, next: null, oi: 1 }]);
    expect(store.readFoSymbol("RELIANCE").map((r) => r.day)).toEqual([D1, D2]);
  });

  it("remembers holidays so a backfill never asks twice, and reports coverage", () => {
    store.markFoDay(HOLIDAY, "holiday", 400);
    expect([...store.checkedFoDays()].sort(([a], [b]) => a - b)).toEqual([
      [HOLIDAY, "holiday"],
      [D1, "ok"],
      [D2, "ok"],
    ]);
    expect(store.foCoverage()).toEqual({ days: 2, checked: 3, first: D1, last: D2, rows: 4 });
    expect(store.foCoverage(D2)).toEqual({ days: 1, checked: 1, first: D2, last: D2, rows: 1 });
  });

  it("gives point-in-time membership per stored day", () => {
    const membership = store.foMembership();
    expect([...membership.keys()].sort()).toEqual([D1, D2]);
    expect([...membership.get(D1)!].sort()).toEqual(["RELIANCE", "SBIN", "TMPV"]);
    expect([...membership.get(D2)!]).toEqual(["RELIANCE"]);
  });

  it("drops a day's rows when it turns out to be a wrong-date file", () => {
    store.markFoDay(D2, "mismatch", 500, "file is for 2025-10-29");
    expect(store.readFoDay(D2)).toEqual([]);
    expect(store.foMembership().has(D2)).toBe(false);
    expect(store.latestFoDay()?.day).toBe(D1);
  });
});
