import { describe, expect, it } from "vitest";
import { aggregateStockFutures, foDaysToCheck, isoDayKey, parseFoBhav } from "./foBhavcopy";

// Rows copied from NSE's UDiFF F&O bhavcopy of 29 Oct 2025 (the day after the
// October expiry), trimmed to the columns' order as published.
const HEADER =
  "TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4";
const row = (symbol: string, type: string, expiry: string, close: number, prev: number, oi: number, chg: number, vol: number, date = "2025-10-29") =>
  `${date},${date},FO,NSE,${type},1,,${symbol},,${expiry},${expiry},,,${symbol}FUT,${prev},${close},${prev},${close},${close},${prev},${close - 3},${close},${oi},${chg},${vol},1000.00,10,F1,500,,,,,`;

const OCT29 = [
  HEADER,
  row("RELIANCE", "STF", "2025-11-25", 1510.7, 1493.9, 111675500, -1044500, 22357),
  row("RELIANCE", "STF", "2026-01-27", 1530.5, 1509.7, 65500, 65500, 180),
  row("RELIANCE", "STF", "2025-12-30", 1521.0, 1504.5, 3545000, 143000, 1339),
  row("TATAMOTORS", "STF", "2025-11-25", 414.25, 413.85, 40939200, 140800, 9935),
  row("BANKNIFTY", "IDF", "2025-12-30", 59093, 58834.2, 167125, 24640, 2143),
  row("RELIANCE", "STO", "2025-11-25", 12.5, 10.1, 50000, 500, 20),
].join("\n");

const DAY = isoDayKey("2025-10-29")!;

describe("NSE F&O bhavcopy (UDiFF)", () => {
  it("reads stock-futures rows only, by header name", () => {
    const parsed = parseFoBhav(OCT29);
    expect(parsed.tradeDate).toBe(DAY);
    expect(parsed.mixedDates).toBe(false);
    expect(parsed.badRows).toBe(0);
    expect(parsed.contracts.map((c) => c.symbol)).toEqual(["RELIANCE", "RELIANCE", "RELIANCE", "TATAMOTORS"]);
    expect(parsed.contracts[0]).toMatchObject({ expiry: isoDayKey("2025-11-25"), close: 1510.7, prevClose: 1493.9, oi: 111675500, chgOi: -1044500, volume: 22357, lot: 500 });
  });

  it("finds columns wherever they are and refuses files without them", () => {
    const cols = HEADER.split(",");
    const swap = (line: string) => {
      const cells = line.split(",");
      [cells[17], cells[21]] = [cells[21], cells[17]]; // ClsPric ↔ SttlmPric
      return cells.join(",");
    };
    const reordered = [swap(cols.join(",")), swap(row("SBIN", "STF", "2025-11-25", 943.6, 934.3, 100, 10, 5))].join("\n");
    expect(parseFoBhav(reordered).contracts[0]).toMatchObject({ close: 943.6, settle: 943.6 });
    expect(parseFoBhav("a,b,c\n1,2,3").contracts).toEqual([]);
  });

  it("skips malformed rows and flags a file with more than one trade date", () => {
    const parsed = parseFoBhav([HEADER, row("SBIN", "STF", "2025-11-25", 943.6, 934.3, 100, 10, 5), row("SB IN", "STF", "2025-11-25", 1, 1, 1, 1, 1), row("SBIN", "STF", "garbage", 1, 1, 1, 1, 1), row("ITC", "STF", "2025-11-25", 400, 399, 100, 1, 1, "2025-10-28")].join("\r\n"));
    expect(parsed.badRows).toBe(2);
    expect(parsed.mixedDates).toBe(true);
  });

  it("combines months, keeps near and next, and sums each month's OI change", () => {
    const [reliance, tmpv] = aggregateStockFutures(parseFoBhav(OCT29).contracts, DAY);
    expect(reliance.symbol).toBe("RELIANCE");
    expect(reliance.expiries).toBe(3);
    expect(reliance.near).toMatchObject({ expiry: isoDayKey("2025-11-25"), close: 1510.7, oi: 111675500 });
    expect(reliance.next).toMatchObject({ expiry: isoDayKey("2025-12-30"), close: 1521.0, oi: 3545000 });
    expect(reliance.oi).toBe(111675500 + 65500 + 3545000);
    // The expired October month isn't in the file: its roll-off doesn't count as unwinding.
    expect(reliance.chgOi).toBe(-1044500 + 65500 + 143000);
    expect(tmpv).toMatchObject({ symbol: "TMPV", nseSymbol: "TATAMOTORS", next: null });
  });

  it("drops contracts already past expiry and prefers the new ticker's own rows", () => {
    const contracts = parseFoBhav(
      [HEADER, row("LTIM", "STF", "2025-11-25", 5000, 4990, 900, 9, 3), row("LTM", "STF", "2025-11-25", 5001, 4991, 800, 8, 2), row("SBIN", "STF", "2025-10-28", 900, 890, 1, 1, 1), row("SBIN", "STF", "2025-11-25", 943, 934, 2, 2, 2)].join("\n"),
    ).contracts;
    const records = aggregateStockFutures(contracts, DAY);
    expect(records.map((r) => [r.symbol, r.nseSymbol, r.oi])).toEqual([
      ["LTM", "LTM", 800],
      ["SBIN", "SBIN", 2],
    ]);
  });
});

describe("which F&O days to download", () => {
  const thu = isoDayKey("2026-11-05")!;
  const days = (list: number[]) => list.map((d) => new Date(d).toISOString().slice(0, 10));

  it("lists unchecked weekdays newest first and waits for the evening for today", () => {
    const from = isoDayKey("2026-10-30")!;
    expect(days(foDaysToCheck({ today: thu, minutes: 17 * 60, from, checked: new Map() }))).toEqual(["2026-11-04", "2026-11-03", "2026-11-02", "2026-10-30"]);
    expect(days(foDaysToCheck({ today: thu, minutes: 18 * 60 + 5, from, checked: new Map([[isoDayKey("2026-11-03")!, "ok"]]) }))).toEqual(["2026-11-05", "2026-11-04", "2026-11-02", "2026-10-30"]);
  });

  it("includes known weekend sessions", () => {
    const days2 = foDaysToCheck({ today: isoDayKey("2026-02-02")!, minutes: 0, from: isoDayKey("2026-01-30")!, checked: new Map() });
    expect(days(days2)).toEqual(["2026-02-01", "2026-01-30"]);
  });

  it("re-asks only the statuses it is told to", () => {
    const checked = new Map([
      [isoDayKey("2026-11-04")!, "mismatch"],
      [isoDayKey("2026-11-03")!, "holiday"],
    ]);
    expect(days(foDaysToCheck({ today: thu, minutes: 0, from: isoDayKey("2026-11-03")!, checked, recheck: ["mismatch"] }))).toEqual(["2026-11-04"]);
  });
});
