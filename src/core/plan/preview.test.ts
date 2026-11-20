import { describe, expect, it } from "vitest";
import { bucketOf, type EvidenceTrade, type ScreenEvidence } from "./evidence";
import { isPlanPreview, stoppedWorking } from "./preview";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
/** 2026-11-20 is a Friday; IST = UTC + 5:30. */
const ist = (hh: number, mm: number, day = "2026-11-20") => Date.parse(`${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`);

const trades = (means: number[]): EvidenceTrade[] =>
  means.flatMap((netR, day) => [0, 1].map((k) => ({ screenId: "x", symbol: `S${k}`, date: T0 + day * DAY, score: 0, state: "up" as const, entry: 100, exit: 100, kind: "open" as const, netR, grossR: netR })));
const evidence = (id: string, netRs: number[], recentFrom: number): ScreenEvidence => {
  const bucket = bucketOf(trades(netRs), recentFrom);
  return { screenId: id, all: bucket, up: bucket, down: bucket, verdict: bucket.eligible ? "any" : "none" };
};

describe("isPlanPreview", () => {
  it("is a preview from the open until the close window on a weekday, live scans only", () => {
    expect(isPlanPreview(true, ist(9, 10))).toBe(false); // before the open
    expect(isPlanPreview(true, ist(12, 2))).toBe(true);
    expect(isPlanPreview(true, ist(15, 9))).toBe(true);
    expect(isPlanPreview(true, ist(15, 10))).toBe(false); // the close window opens
    expect(isPlanPreview(true, ist(19, 0))).toBe(false);
    expect(isPlanPreview(false, ist(12, 2))).toBe(false); // stored close, not a live scan
    expect(isPlanPreview(true, ist(12, 2, "2026-11-21"))).toBe(false); // Saturday
  });
});

describe("stoppedWorking", () => {
  // 100 days: good for 80, losing for the last 20 (the "last 12 months").
  const fading = [...Array(80).fill(0.8), ...Array(20).fill(-0.6)];
  const recentFrom = T0 + 80 * DAY;

  it("names screens with a positive record whose recent trades lost, worst first, and skips eligible ones", () => {
    const screens = {
      "pos-trend-template": evidence("pos-trend-template", fading, recentFrom),
      "pos-52w-high": evidence("pos-52w-high", [...Array(80).fill(0.8), ...Array(20).fill(-0.3)], recentFrom),
      "btst-closing-strength": evidence("btst-closing-strength", Array(100).fill(0.2), recentFrom),
    };
    const out = stoppedWorking(screens, "up", ["btst-closing-strength"]);
    expect(out.map((entry) => entry.id)).toEqual(["pos-trend-template", "pos-52w-high"]);
    expect(out[0].recentR).toBeCloseTo(-0.6);
    expect(stoppedWorking(screens, "up", ["btst-closing-strength", "pos-trend-template", "pos-52w-high"])).toEqual([]);
  });

  it("says nothing without a market state or for screens missing from the evidence", () => {
    expect(stoppedWorking({}, "up", [])).toEqual([]);
    expect(stoppedWorking({ "pos-trend-template": evidence("pos-trend-template", fading, recentFrom) }, null, [])).toEqual([]);
  });
});
