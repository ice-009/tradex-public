import { describe, expect, it } from "vitest";
import { expiryOf, lastTuesday, lotsForRisk, nearMonthFuture, underlyingOf } from "./futures";

describe("stock futures contracts", () => {
  it("expires on the last Tuesday", () => {
    expect(new Date(lastTuesday(2026, 10)).getUTCDate()).toBe(24);
  });

  it("picks the near month, rolling the day after expiry", () => {
    expect(nearMonthFuture("SBIN", Date.UTC(2026, 10, 4))).toBe("NSE:SBIN26NOVFUT");
    expect(nearMonthFuture("SBIN", Date.UTC(2026, 10, 24))).toBe("NSE:SBIN26NOVFUT");
    expect(nearMonthFuture("SBIN", Date.UTC(2026, 10, 25))).toBe("NSE:SBIN26DECFUT");
    expect(nearMonthFuture("SBIN", Date.UTC(2026, 11, 30))).toBe("NSE:SBIN27JANFUT");
    expect(nearMonthFuture("SBIN", Date.UTC(2026, 10, 4), 1)).toBe("NSE:SBIN26DECFUT");
  });

  it("reads expiry and underlying back from a contract", () => {
    expect(expiryOf("NSE:SBIN26NOVFUT")).toBe(Date.UTC(2026, 10, 24));
    expect(expiryOf("NSE:SBIN-EQ")).toBeNull();
    expect(underlyingOf("NSE:M&MFIN26DECFUT")).toBe("M&MFIN");
  });

  it("sizes lots to a max loss", () => {
    expect(lotsForRisk(10_000, 10, 750)).toEqual({ lots: 1, riskPerLot: 7500 });
    expect(lotsForRisk(5_000, 10, 750).lots).toBe(0);
    expect(lotsForRisk(5_000, 0, 750).lots).toBe(0);
  });
});
