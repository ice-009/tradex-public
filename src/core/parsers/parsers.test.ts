import { describe, expect, it } from "vitest";
import { parseBhav } from "./bhavcopy";
import { parseFyersLots, parseNseLots } from "./lotSizes";
import { dedupeEvents, parseCalendar, parseNseDate } from "./resultsCalendar";

describe("NSE lot file", () => {
  const csv = [
    "UNDERLYING                                        ,SYMBOL    ,NOV-26    ,DEC-26    ,JAN-27    ,",
    "Derivatives on Individual Securities,,,,,",
    "NIFTY 50                                           ,NIFTY     ,75        ,75        ,75        ,",
    "STATE BANK OF INDIA                               ,SBIN      ,750       ,750       ,750       ,",
    "HINDUSTAN AERONAUTICS LTD                         ,HAL       ,          ,150       ,150       ,",
    "M&M FINANCIAL SERVICES LTD                        ,M&MFIN    ,2000      ,2000      ,2000      ,",
  ].join("\r\n");

  it("reads the nearest month's lot by header name", () => {
    const lots = parseNseLots(csv);
    expect(lots.SBIN).toBe(750);
    expect(lots.HAL).toBe(150); // blank near month → next month
    expect(lots["M&MFIN"]).toBe(2000);
  });

  it("returns nothing without a header", () => {
    expect(parseNseLots("garbage\n1,2,3")).toEqual({});
  });
});

describe("Fyers symbol master", () => {
  it("reads lots from futures rows only", () => {
    const csv = [
      "101125110612345,SBIN 26 Nov 24 FUT,11,750,0.05,,0915-1530|1815-1915:,2026-11-01,1795600000,NSE:SBIN26NOVFUT,10,11,61234,SBIN,3045,-1.0,XX,10100000003045,None,0.0",
      "101125110612346,SBIN 26 Dec 29 FUT,11,750,0.05,,0915-1530|1815-1915:,2026-11-01,1798000000,NSE:SBIN26DECFUT,10,11,61235,SBIN,3045,-1.0,XX,10100000003045,None,0.0",
      "101125110612400,SBIN 26 Nov 800 CE,14,750,0.05,,0915-1530,2026-11-01,1795600000,NSE:SBIN26NOV800CE,10,11,61300,SBIN,3045,800.0,CE,10100000003045,None,0.0",
    ].join("\n");
    expect(parseFyersLots(csv)).toEqual({ SBIN: 750 });
  });
});

describe("NSE results calendar", () => {
  const rows = [
    { symbol: "TCS", company: "Tata Consultancy Services", purpose: "Financial Results/Dividend", date: "09-Oct-2026" },
    { symbol: "INFY", company: "Infosys", purpose: "Financial Results", date: "16-Oct-2026" },
    { symbol: "ABC", company: "ABC", purpose: "Fund Raising", date: "10-Oct-2026" },
    { symbol: "XYZ", sm_name: "XYZ Ltd", bm_purpose: "To consider Financial Results", bm_date: "2026-11-12" },
    { symbol: "BAD", purpose: "Financial Results", date: "not a date" },
  ];

  it("keeps results rows across field-name variants", () => {
    const events = parseCalendar(rows);
    expect(events.map((event) => event.symbol)).toEqual(["TCS", "INFY", "XYZ"]);
    expect(events[2]).toMatchObject({ company: "XYZ Ltd", date: Date.UTC(2026, 10, 12) });
    expect(parseCalendar({ data: rows })).toHaveLength(3);
    expect(parseCalendar("x")).toEqual([]);
    expect(parseCalendar(null)).toEqual([]);
  });

  it("parses NSE dates", () => {
    expect(parseNseDate("1-Jan-2027")).toBe(Date.UTC(2027, 0, 1));
    expect(parseNseDate("2027-01-01")).toBe(Date.UTC(2027, 0, 1));
    expect(parseNseDate(42)).toBeNull();
  });

  it("keeps one event per symbol and date", () => {
    const day = Date.UTC(2026, 10, 4);
    const events = dedupeEvents([
      { symbol: "EUROPRATIK", company: "Euro Pratik", purpose: "Financial Results", date: day },
      { symbol: "EUROPRATIK", company: "Euro Pratik", purpose: "Financial Results/Dividend", date: day },
      { symbol: "TIRUPATIFL", company: "Tirupati Forge", purpose: "Financial Results", date: day },
      { symbol: "TIRUPATIFL", company: "Tirupati Forge", purpose: "Financial Results", date: day },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0].purpose).toBe("Financial Results · Financial Results/Dividend");
  });
});

describe("NSE bhavcopy", () => {
  const header = "SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER";
  it("reads EQ rows and delivery %", () => {
    const rows = parseBhav(
      [
        header,
        "SBIN, EQ, 04-Nov-2026, 800.00, 801.00, 812.00, 795.00, 810.00, 810.50, 805.00, 1000000, 8050.00, 50000, 450000, 45.00",
        "SBIN, N1, 04-Nov-2026, 100, 100, 100, 100, 100, 100, 100, 10, 1, 1, -, -",
        "XYZ, BE, 04-Nov-2026, 50, 51, 52, 49, 50, 50.5, 50, 1000, 1, 1, 1000, -",
      ].join("\n"),
    );
    expect(rows.SBIN).toEqual({ prevClose: 800, open: 801, high: 812, low: 795, close: 810.5, volume: 1000000, deliveryPct: 45 });
    expect(rows.XYZ.deliveryPct).toBeNull(); // trade-for-trade series kept; "-" delivery → null
  });
});
