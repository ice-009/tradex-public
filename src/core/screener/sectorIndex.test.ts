import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/core/types";
import { sectorIndexStat, sectorSources, strengthRanks, type IndexCatalog } from "./sectorIndex";

const DAY = 24 * 60 * 60 * 1000;
const d = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const bars = (closes: number[], start = d("2026-01-01")): DailyBar[] => closes.map((c, i) => ({ t: start + i * DAY, o: c, h: c, l: c, c, v: 0 }));

const catalog: IndexCatalog = {
  available: true,
  indices: [
    { symbol: "NIFTYIT", name: "Nifty IT", synthetic: false, firstDay: d("2012-03-01"), lastDay: d("2026-11-17") },
    { symbol: "NIFTYCAPGOODS", name: "Nifty Capital Goods", synthetic: false, firstDay: d("2025-06-01"), lastDay: d("2026-11-17") },
    { symbol: "NIFTYPHARMA", name: "Nifty Pharma", synthetic: false, firstDay: d("2012-03-01"), lastDay: d("2026-11-17") },
    { symbol: "NIFTYHEALTHCARE", name: "Nifty Healthcare Index", synthetic: false, firstDay: d("2024-01-01"), lastDay: d("2026-11-17") },
    { symbol: "NIFTYMEDIA", name: "Nifty Media", synthetic: false, firstDay: d("2012-03-01"), lastDay: d("2026-10-01") },
    { symbol: "EW-IT", name: "Equal-weight Information Technology basket (synthetic)", synthetic: true, firstDay: d("1994-11-04"), lastDay: d("2026-11-17") },
    { symbol: "EW-CAPGOODS", name: "Equal-weight Capital Goods basket (synthetic)", synthetic: true, firstDay: d("1994-11-04"), lastDay: d("2026-11-17") },
    { symbol: "EW-HEALTHCARE", name: "Equal-weight Healthcare basket (synthetic)", synthetic: true, firstDay: d("1994-11-04"), lastDay: d("2026-11-17") },
    { symbol: "EW-CHEMICALS", name: "Equal-weight Chemicals basket (synthetic)", synthetic: true, firstDay: d("2025-01-01"), lastDay: d("2026-11-17") },
    { symbol: "EW-MEDIA", name: "Equal-weight Media basket (synthetic)", synthetic: true, firstDay: null, lastDay: null },
  ],
  sectors: [
    { industry: "Information Technology", indices: ["NIFTYIT"], basket: "EW-IT" },
    { industry: "Capital Goods", indices: ["NIFTYCAPGOODS"], basket: "EW-CAPGOODS" },
    { industry: "Healthcare", indices: ["NIFTYHEALTHCARE", "NIFTYPHARMA"], basket: "EW-HEALTHCARE" },
    { industry: "Chemicals", indices: ["NIFTYCHEMICALS"], basket: "EW-CHEMICALS" },
    { industry: "Media Entertainment & Publication", indices: ["NIFTYMEDIA"], basket: "EW-MEDIA" },
  ],
};

describe("sector sources", () => {
  const needFrom = d("2021-12-01");
  const sources = sectorSources(catalog, ["Information Technology", "Capital Goods", "Healthcare", "Chemicals", "Media Entertainment & Publication", "Other"], needFrom);

  it("uses an NSE index whose history reaches back as far as the stocks'", () => {
    expect(sources.get("Information Technology")).toEqual({ symbol: "NIFTYIT", name: "Nifty IT", synthetic: false });
    // Nifty Healthcare starts in 2024; the older Nifty Pharma covers the window.
    expect(sources.get("Healthcare")?.symbol).toBe("NIFTYPHARMA");
  });

  it("falls back to the synthetic basket where no NSE index has that much history, labelled", () => {
    expect(sources.get("Capital Goods")).toEqual({ symbol: "EW-CAPGOODS", name: "Equal-weight Capital Goods basket (synthetic)", synthetic: true });
    // Neither reaches back: the one that starts earliest.
    expect(sources.get("Chemicals")?.symbol).toBe("EW-CHEMICALS");
    // A stale index and an empty basket: nothing.
    expect(sources.has("Media Entertainment & Publication")).toBe(false);
    expect(sources.has("Other")).toBe(false);
  });

  it("is empty with a hub that has no index catalogue", () => {
    expect(sectorSources({ available: false, indices: [], sectors: [] }, ["Information Technology"], needFrom).size).toBe(0);
  });
});

describe("sector index strength", () => {
  it("measures 1- and 3-month returns and the 3-month return against NIFTY on the same sessions", () => {
    const sector = bars(Array.from({ length: 70 }, (_, i) => 100 + i));
    const nifty = bars(Array.from({ length: 70 }, (_, i) => 1000 + i * 5));
    const stat = sectorIndexStat({ symbol: "NIFTYIT", name: "Nifty IT", synthetic: false }, sector, nifty);
    expect(stat.ret21).toBeCloseTo((169 / 148 - 1) * 100, 6);
    expect(stat.ret63).toBeCloseTo((169 / 106 - 1) * 100, 6);
    expect(stat.vsNifty63).toBeCloseTo((169 / 106 - 1) * 100 - (1345 / 1030 - 1) * 100, 6);
    expect(stat.asOf).toBe(sector[69].t);
  });

  it("says NaN without enough history or matching NIFTY sessions", () => {
    const short = sectorIndexStat({ symbol: "EW-IT", name: "basket", synthetic: true }, bars([1, 2, 3]), []);
    expect([short.ret21, short.ret63, short.vsNifty63].every(Number.isNaN)).toBe(true);
    const unmatched = sectorIndexStat({ symbol: "NIFTYIT", name: "Nifty IT", synthetic: false }, bars(Array.from({ length: 70 }, () => 1)), bars([1, 2], d("2020-01-01")));
    expect(unmatched.ret63).toBe(0);
    expect(unmatched.vsNifty63).toBeNaN();
  });

  it("ranks sectors 0 (weakest) to 1 (strongest), skipping unknowns", () => {
    const ranks = strengthRanks(new Map([["IT", 5], ["Auto", -2], ["FMCG", 1], ["Media", Number.NaN]]));
    expect([...ranks]).toEqual([["Auto", 0], ["FMCG", 0.5], ["IT", 1]]);
    expect(strengthRanks(new Map([["IT", 5]])).get("IT")).toBe(0.5);
  });
});
