import { describe, expect, it } from "vitest";
import { nseTickSize, roundToTick, safeTickSize } from "./ticks";

describe("roundToTick", () => {
  it.each([
    [186.227, "nearest", 186.25],
    [736.72, "nearest", 736.7],
    [736.72, "up", 736.8],
    [4958.19, "down", 4958],
    [5079.1, "up", 5080],
    [5260.47, "nearest", 5260],
    [50925.4, "down", 50925],
  ] as const)("%f %s → %f", (price, mode, want) => {
    expect(roundToTick(price, mode)).toBe(want);
  });

  it("is a multiple of both the band tick and the safe tick across ₹1–30,000", () => {
    const isMultiple = (p: number, t: number) => Math.abs(p / t - Math.round(p / t)) < 1e-6;
    for (let price = 1; price < 30000; price *= 1.013) {
      const rounded = roundToTick(price);
      expect(isMultiple(rounded, nseTickSize(price)), `${price} → ${rounded}`).toBe(true);
      expect(isMultiple(rounded, safeTickSize(price)), `${price} → ${rounded}`).toBe(true);
    }
  });
});
