import { readFileSync } from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { aggregateStockFutures, isoDayKey, parseFoBhav } from "@/core/parsers/foBhavcopy";
import { combinedOiChangePct, oiFact } from "@/core/market/openInterest";
import { foBhavFileName, foBhavUrl, readFoZip } from "./foBhavcopy";
import { ZipError, unzipSingle } from "./unzip";

// Fixtures are real NSE UDiFF rows, trimmed to a few underlyings:
//   fo-bhav-20251001.csv      1 Oct 2025, with tickers NSE later renamed (LTIM, TATAMOTORS, ICICIPRULI)
//   fo-bhav-20251029.csv(.zip) 29 Oct 2025, the day after the October expiry, zipped the way NSE ships it
const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures", name));

/** A one-file zip, built by hand (stored or deflated), to test the reader's edges. */
function makeZip(name: string, data: Buffer, method: 0 | 8 = 8, files = 1): Buffer {
  const body = method === 8 ? deflateRawSync(data) : data;
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const centralOffset = local.length + nameBytes.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files, 8);
  end.writeUInt16LE(files, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBytes, body, central, nameBytes, end]);
}

describe("unzip", () => {
  it("reads NSE's single-file zip", () => {
    const { name, data } = unzipSingle(fixture("fo-bhav-20251029.csv.zip"));
    expect(name).toBe("BhavCopy_NSE_FO_0_0_0_20251029_F_0000.csv");
    expect(data.equals(fixture("fo-bhav-20251029.csv"))).toBe(true);
  });

  it("reads stored and deflated entries and refuses the rest", () => {
    const text = Buffer.from("hello,world\n".repeat(50));
    expect(unzipSingle(makeZip("a.csv", text, 0)).data.equals(text)).toBe(true);
    expect(unzipSingle(makeZip("a.csv", text, 8)).data.equals(text)).toBe(true);
    expect(() => unzipSingle(Buffer.from("<html>Access denied</html>"))).toThrow(ZipError);
    expect(() => unzipSingle(makeZip("a.csv", text, 8, 2))).toThrow(/one file/);
    expect(() => unzipSingle(makeZip("a.csv", text, 8), 100)).toThrow(/too large/);
    const zip = makeZip("a.csv", text, 8);
    expect(() => unzipSingle(zip.subarray(0, zip.length - 30))).toThrow(ZipError);
  });
});

describe("F&O bhavcopy file", () => {
  it("names the archive URL by date", () => {
    expect(foBhavFileName(Date.UTC(2026, 10, 4))).toBe("BhavCopy_NSE_FO_0_0_0_20261104_F_0000.csv.zip");
    expect(foBhavUrl(Date.UTC(2026, 10, 4))).toBe("https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_20261104_F_0000.csv.zip");
  });

  it("reads a real day's zip into per-underlying records", () => {
    const day = isoDayKey("2025-10-29")!;
    const result = readFoZip(day, fixture("fo-bhav-20251029.csv.zip"));
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.records.map((r) => r.symbol)).toEqual(["RELIANCE", "SBIN", "TMPV"]);
    const sbin = result.records.find((r) => r.symbol === "SBIN")!;
    // Day after expiry: −23.4 L in November, +0.68 L and +0.45 L in the later months.
    expect(sbin.chgOi).toBe(-2343000 + 68250 + 45000);
    expect(combinedOiChangePct(sbin)).toBeCloseTo((-2229750 / (79837500 + 2229750)) * 100, 6);
    expect(oiFact(sbin).buildup).toBe("short-covering");
  });

  it("rejects a file served for another day (the holiday trap)", () => {
    const result = readFoZip(isoDayKey("2025-10-30")!, fixture("fo-bhav-20251029.csv.zip"));
    expect(result).toMatchObject({ kind: "mismatch", note: "file is for 2025-10-29" });
  });

  it("files renamed tickers under their new names", () => {
    const day = isoDayKey("2025-10-01")!;
    const parsed = parseFoBhav(fixture("fo-bhav-20251001.csv").toString("utf8"));
    expect(parsed.tradeDate).toBe(day);
    const records = aggregateStockFutures(parsed.contracts, day);
    expect(records.map((r) => `${r.nseSymbol}→${r.symbol}`)).toEqual(["ICICIPRULI→ICICILIFE", "LTIM→LTM", "RELIANCE→RELIANCE", "TATAMOTORS→TMPV"]);
    // Index futures (IDF) and stock options (STO) are not stock futures.
    expect(parsed.contracts).toHaveLength(12);
  });
});
