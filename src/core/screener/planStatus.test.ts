import { describe, expect, it } from "vitest";
import { planStatus } from "./planStatus";

const atMarket = { entry: 2290, stop: 2110 }; // buy-at-close plan made at 2,290
const buyStop = { entry: 2350, stop: 2160 }; // buy-stop above a 2,290 scan close

describe("planStatus", () => {
  it("is fine while the price stays near a buy-at-close entry", () => {
    expect(planStatus(atMarket, 2290, 2280, 40)).toEqual({ kind: "ok" });
  });

  it("flags a buy-at-close plan once the price has fallen well below the entry (the LAURUSLABS case)", () => {
    const status = planStatus(atMarket, 2290, 2190, 40);
    expect(status.kind).toBe("moved");
    if (status.kind === "moved") expect(status.pct).toBeCloseTo(-4.37, 1);
  });

  it("flags a run-up too (don't chase)", () => {
    expect(planStatus(atMarket, 2290, 2360, 40).kind).toBe("moved");
  });

  it("uses the larger of 1.5% and 0.75 ATR as the threshold", () => {
    // 2% move on a stock whose 0.75 ATR is ~2.6%: still fine.
    expect(planStatus(atMarket, 2290, 2244, 80).kind).toBe("ok");
  });

  it("marks a broken stop", () => {
    expect(planStatus(atMarket, 2290, 2100, 40).kind).toBe("stop-broken");
  });

  it("marks a buy-stop as triggered or too far to fill", () => {
    expect(planStatus(buyStop, 2290, 2355, 40).kind).toBe("triggered");
    expect(planStatus(buyStop, 2290, 2310, 40)).toEqual({ kind: "ok" }); // 1 ATR away: fine
    expect(planStatus(buyStop, 2290, 2250, 40).kind).toBe("far"); // 2.5 ATR away
  });

  it("does nothing without a price", () => {
    expect(planStatus(atMarket, 2290, 0, 40)).toEqual({ kind: "ok" });
  });
});
