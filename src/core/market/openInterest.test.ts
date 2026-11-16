import { describe, expect, it } from "vitest";
import type { FoDayRecord } from "./openInterest";
import { combinedOiChangePct, oiBuildup, oiFact, oiTag, oiTooltip } from "./openInterest";

const record = (close: number, prevClose: number, oi: number, chgOi: number): FoDayRecord => ({
  day: Date.UTC(2025, 9, 29),
  symbol: "RELIANCE",
  nseSymbol: "RELIANCE",
  expiries: 3,
  lot: 500,
  underlying: 1500,
  near: { expiry: Date.UTC(2025, 10, 25), close, settle: close, prevClose, volume: 100, oi, chgOi },
  next: null,
  oi,
  chgOi,
});

describe("OI buildup", () => {
  it("crosses the price and OI signs", () => {
    expect(oiBuildup(1, 1)).toBe("long-buildup");
    expect(oiBuildup(-1, 1)).toBe("short-buildup");
    expect(oiBuildup(1, -1)).toBe("short-covering");
    expect(oiBuildup(-1, -1)).toBe("long-unwinding");
    expect(oiBuildup(0, 1)).toBeNull();
    expect(oiBuildup(1, 0)).toBeNull();
    expect(oiBuildup(NaN, 1)).toBeNull();
  });

  it("measures the combined OI change against the previous session's OI", () => {
    expect(combinedOiChangePct({ oi: 106, chgOi: 6 })).toBeCloseTo(6);
    expect(combinedOiChangePct({ oi: 94, chgOi: -6 })).toBeCloseTo(-6 / 100 * 100);
    expect(combinedOiChangePct({ oi: 50, chgOi: 50 })).toBeNull(); // newly listed
  });

  it("builds the screener's fact and short tag", () => {
    const fact = oiFact(record(1510, 1500, 1_06_00_000, 6_00_000));
    expect(fact.buildup).toBe("long-buildup");
    expect(fact.pricePct).toBeCloseTo(0.667, 2);
    expect(fact.oiPct).toBeCloseTo(6);
    expect(fact.basisPct).toBeCloseTo(0.667, 2);
    expect(oiTag(fact)).toBe("Long buildup · OI +6.0%");
    expect(oiTag(oiFact(record(1490, 1500, 75, -25)))).toBe("Long unwinding · OI −25%");
    expect(oiTag(oiFact(record(1500, 1500, 110, 10)))).toBe("OI +10%");
  });

  it("says in the tooltip that it isn't scored", () => {
    const text = oiTooltip(oiFact(record(1510, 1500, 1_06_00_000, 6_00_000)), "29 Oct");
    expect(text).toContain("29 Oct");
    expect(text).toContain("+6.0 L");
    expect(text).toMatch(/no tested edge/);
    expect(text).toMatch(/not part of the score/);
  });
});
