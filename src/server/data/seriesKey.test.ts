import { describe, expect, it } from "vitest";
import { brokerInstrument, historySeriesKey } from "./seriesKey";

describe("historySeriesKey", () => {
  it("keeps the keys the market database already uses", () => {
    expect(historySeriesKey("SBIN", "1d")).toBe("NSE:SBIN-EQ:D");
    expect(historySeriesKey("nifty", "15m")).toBe("NSE:NIFTY50-INDEX:15");
    expect(historySeriesKey("RELIANCE", "1h")).toBe("NSE:RELIANCE-EQ:60");
    expect(historySeriesKey("RELIANCE", "4h")).toBe("NSE:RELIANCE-EQ:240");
    expect(historySeriesKey("NSE:SBIN26NOVFUT", "5m")).toBe("NSE:SBIN26NOVFUT:5");
  });

  it("maps indices and passes full exchange symbols through", () => {
    expect(brokerInstrument("BANKNIFTY")).toBe("NSE:NIFTYBANK-INDEX");
    expect(brokerInstrument("SENSEX")).toBe("BSE:SENSEX-INDEX");
    expect(brokerInstrument(" m&m ")).toBe("NSE:M&M-EQ");
  });
});
