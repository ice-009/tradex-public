import { describe, expect, it } from "vitest";
import { marketRegime } from "./regime";

describe("market regime", () => {
  it("is healthy with NIFTY above both averages and broad participation", () => {
    expect(marketRegime({ niftyClose: 110, niftySma50: 105, niftySma200: 100, aboveSma50: 60, counted: 100 }).state).toBe("healthy");
  });
  it("is risk-off with NIFTY below its 200-day and weak breadth", () => {
    const regime = marketRegime({ niftyClose: 90, niftySma50: 95, niftySma200: 100, aboveSma50: 20, counted: 100 });
    expect(regime.state).toBe("risk-off");
    expect(regime.reasons.join(" ")).toMatch(/below its 200-day/);
  });
  it("is caution in between", () => {
    expect(marketRegime({ niftyClose: 110, niftySma50: 105, niftySma200: 100, aboveSma50: 40, counted: 100 }).state).toBe("caution");
    expect(marketRegime({ niftyClose: 95, niftySma50: 98, niftySma200: 100, aboveSma50: 50, counted: 100 }).state).toBe("caution");
  });
});
