import { describe, expect, it } from "vitest";
import { COST_PRESETS, legCosts, roundTripCosts, slipped, type CostModel } from "./costs";

const model = COST_PRESETS["futures-2026"].model;

describe("futures costs", () => {
  it("charges a ₹10 lakh buy as hand-computed", () => {
    // ₹1,000 × 1,000 = ₹10,00,000 turnover.
    const buy = legCosts("buy", 1000, 1000, model);
    expect(buy.brokerage).toBe(20); // min(₹20, 0.03% = ₹300)
    expect(buy.stt).toBe(0); // STT is sell-side only
    expect(buy.exchange).toBeCloseTo(18.3, 6); // ₹183 per crore
    expect(buy.sebi).toBeCloseTo(1, 6); // ₹10 per crore
    expect(buy.stamp).toBeCloseTo(20, 6); // 0.002%
    expect(buy.gst).toBeCloseTo(0.18 * (20 + 18.3 + 1), 6);
    expect(buy.total).toBeCloseTo(20 + 18.3 + 1 + 20 + 7.074, 6);
  });

  it("charges STT and no stamp duty on the sell", () => {
    const sell = legCosts("sell", 1000, 1000, model);
    expect(sell.stt).toBeCloseTo(500, 6); // 0.05%
    expect(sell.stamp).toBe(0);
    expect(sell.total).toBeCloseTo(20 + 500 + 18.3 + 1 + 7.074, 6);
  });

  it("caps brokerage at 0.03% on small orders", () => {
    const small = legCosts("buy", 100, 100, model); // ₹10,000 → 0.03% = ₹3
    expect(small.brokerage).toBeCloseTo(3, 6);
  });

  it("adds both legs in a round trip", () => {
    const trip = roundTripCosts(1000, 1100, 500, model);
    expect(trip.total).toBeCloseTo(legCosts("buy", 1000, 500, model).total + legCosts("sell", 1100, 500, model).total, 9);
  });

  it("is zero with the no-cost preset", () => {
    const none = COST_PRESETS.none.model;
    expect(roundTripCosts(1000, 1100, 500, none).total).toBe(0);
    expect(slipped("buy", 1000, none)).toBe(1000);
  });

  it("slips against you, in % or ticks", () => {
    expect(slipped("buy", 1000, model)).toBeCloseTo(1000.5, 9); // 0.05%
    expect(slipped("sell", 1000, model)).toBeCloseTo(999.5, 9);
    const ticks: CostModel = { ...model, slippage: { mode: "ticks", value: 2 } };
    expect(slipped("buy", 1000, ticks)).toBeCloseTo(1000.1, 9); // tick ₹0.05 at ₹1,000
    expect(slipped("sell", 200, ticks)).toBeCloseTo(199.98, 9); // tick ₹0.01 below ₹250
  });
});
