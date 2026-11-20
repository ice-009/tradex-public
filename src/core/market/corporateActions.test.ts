import { describe, expect, it } from "vitest";
import { corporateActionMarker, shareRatio } from "./corporateActions";

// Chart markers for the hub's adjustment factors (market-data-hub#20). The
// factors below are real: KOTAKBANK's 1:5 split (14 Jan 2026), RELIANCE's 1:1
// bonus (28 Oct 2024), CONCOR's 1:4 bonus (4 Jul 2025), TATAMOTORS' demerger
// (14 Oct 2025), ADANIENT's rights issue (17 Nov 2025).

const event = (factor: number, action: string | null, source: "prev_close" | "corporate_action" | "price_gap" = "corporate_action") => ({ time: Date.UTC(2026, 0, 14), date: "2026-01-14", factor, source, action });

describe("corporate-action markers", () => {
  it("states the share ratio a price factor means", () => {
    expect(shareRatio(0.5)).toBe("2:1");
    expect(shareRatio(0.2)).toBe("5:1");
    expect(shareRatio(0.4)).toBe("5:2");
    expect(shareRatio(0.8)).toBe("5:4");
    expect(shareRatio(10)).toBe("1:10");
    expect(shareRatio(0.6054)).toBeNull();
  });

  it("names the action from NSE's purpose, or from the factor", () => {
    expect(corporateActionMarker(event(0.2, null, "price_gap"))).toEqual({ time: Date.UTC(2026, 0, 14), label: "Split/bonus 5:1", title: "2026-01-14: Split/bonus 5:1. Prices before are × 0.2 (from the price gap)." });
    expect(corporateActionMarker(event(0.5, "BONUS 1:1")).label).toBe("Bonus 2:1");
    expect(corporateActionMarker(event(0.8, "BONUS 1:4")).label).toBe("Bonus 5:4");
    expect(corporateActionMarker(event(0.1, "FV SPLIT RS.10 TO RE.1")).label).toBe("Split 10:1");
    expect(corporateActionMarker(event(0.6054, "DEMERGER"))).toMatchObject({ label: "Demerger", title: expect.stringContaining("NSE: DEMERGER") });
    expect(corporateActionMarker(event(0.9695, "RIGHTS 3:25@PRM RS 1799")).label).toBe("Rights");
    expect(corporateActionMarker(event(10, null, "prev_close")).title).toContain("NSE's adjusted previous close");
  });
});
