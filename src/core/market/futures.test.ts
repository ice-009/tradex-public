import { describe, expect, it } from "vitest";
import { expiryDayKey, lotsForRisk, pickContract, type FuturesContract } from "./futures";

const NOV = Date.UTC(2026, 10, 24);
const DEC = Date.UTC(2026, 11, 29);
const contracts: FuturesContract[] = [
  { ticker: "SBIN26DECFUT", expiry: DEC, kind: "next" },
  { ticker: "SBIN26NOVFUT", expiry: NOV, kind: "near" },
];

describe("stock futures contracts", () => {
  it("reads the hub's expiry dates", () => {
    expect(expiryDayKey("2026-11-24")).toBe(NOV);
    expect(expiryDayKey("24-Nov-2026")).toBeNull();
  });

  it("trades the near month unless it expires inside the holding period", () => {
    expect(pickContract(contracts, Date.UTC(2026, 10, 4), 1)).toMatchObject({ near: { ticker: "SBIN26NOVFUT" }, next: { ticker: "SBIN26DECFUT" }, rollToNext: false });
    expect(pickContract(contracts, Date.UTC(2026, 10, 4), 25).rollToNext).toBe(true);
    expect(pickContract(contracts, Date.UTC(2026, 10, 22), 1).rollToNext).toBe(true);
  });

  it("ignores an expired contract and copes with no next month", () => {
    const picked = pickContract(contracts, Date.UTC(2026, 10, 25), 1);
    expect(picked.near?.ticker).toBe("SBIN26DECFUT");
    expect(picked.next).toBeNull();
    expect(picked.rollToNext).toBe(false);
    expect(pickContract([], Date.UTC(2026, 10, 4), 1)).toEqual({ near: null, next: null, rollToNext: false });
  });

  it("sizes lots to a max loss", () => {
    expect(lotsForRisk(10_000, 10, 750)).toEqual({ lots: 1, riskPerLot: 7500 });
    expect(lotsForRisk(5_000, 10, 750).lots).toBe(0);
    expect(lotsForRisk(5_000, 0, 750).lots).toBe(0);
  });
});
