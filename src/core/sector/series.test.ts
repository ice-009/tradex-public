import { describe, expect, it } from "vitest";
import type { IndexCatalog } from "@/core/screener/sectorIndex";
import type { DailyBar } from "@/core/types";
import { longSectorSources, spliceSector } from "./series";

const DAY = 86_400_000;
const ERA = Date.UTC(2012, 1, 21);
const entry = (symbol: string, firstDay: number | null, synthetic = false) => ({ symbol, name: symbol, synthetic, firstDay, lastDay: Date.UTC(2026, 10, 1) });

const catalog: IndexCatalog = {
  available: true,
  indices: [
    entry("NIFTY", ERA),
    entry("NIFTYHEALTHCARE", Date.UTC(2016, 6, 7)),
    entry("NIFTYPHARMA", ERA),
    entry("NIFTYCAPGOODS", Date.UTC(2026, 5, 15)),
    entry("EW-HEALTHCARE", Date.UTC(1995, 8, 7), true),
    entry("EW-CAPGOODS", Date.UTC(1995, 8, 7), true),
    entry("EW-EMPTY", null, true),
  ],
  sectors: [
    { industry: "Healthcare", indices: ["NIFTYHEALTHCARE", "NIFTYPHARMA"], basket: "EW-HEALTHCARE" },
    { industry: "Capital Goods", indices: ["NIFTYCAPGOODS"], basket: "EW-CAPGOODS" },
    { industry: "Diversified", indices: [], basket: "EW-EMPTY" },
  ],
};

describe("long sector series", () => {
  it("uses the first index whose history starts with the index file, else the basket alone", () => {
    expect(longSectorSources(catalog)).toEqual([
      { industry: "Healthcare", index: "NIFTYPHARMA", basket: "EW-HEALTHCARE" },
      { industry: "Capital Goods", index: null, basket: "EW-CAPGOODS" },
      { industry: "Diversified", index: null, basket: null },
    ]);
    expect(longSectorSources({ ...catalog, available: false })).toEqual([]);
  });

  it("splices the basket in front of the index, scaled to meet it, and says until when", () => {
    const bars = (start: number, closes: number[]): DailyBar[] => closes.map((c, i) => ({ t: start + i * DAY, o: c, h: c, l: c, c, v: 0 }));
    const basket = bars(ERA - 2 * DAY, [10, 11, 12, 13]);
    const index = bars(ERA, [1200, 1300]);
    const series = spliceSector({ index: "NIFTYPHARMA", basket: "EW-HEALTHCARE" }, (symbol) => (symbol === "NIFTYPHARMA" ? index : basket));
    expect(series?.bars.map((bar) => bar.c)).toEqual([1000, 1100, 1200, 1300]);
    expect(series?.syntheticUntil).toBe(ERA - DAY);
    expect(series?.label).toContain("synthetic");

    const alone = spliceSector({ index: null, basket: "EW-CAPGOODS" }, () => basket);
    expect(alone?.syntheticUntil).toBe(basket.at(-1)!.t);
    expect(spliceSector({ index: null, basket: null }, () => undefined)).toBeNull();
  });
});
