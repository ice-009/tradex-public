import { describe, expect, it } from "vitest";
import type { HubCandle, HubCandlesBatch, HubSource } from "@/server/providers/hub/client";
import { LONG_BATCH_SYMBOLS, LongBars, longWarnings } from "./longBars";

// Daily bars for periods older than the screener's store, read from the hub per
// run. The fake hub below serves what market-data-hub#22 serves: one series per
// company across its ticker renames, with `sources` saying where each stretch came from.

const d = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const SESSIONS = ["2011-06-24", "2011-06-27", "2011-06-28", "2011-06-29", "2011-06-30", "2011-07-01"].map(d);
const candles = (days: number[], base: number): HubCandle[] => days.map((t, i) => ({ t, o: base + i, h: base + i, l: base + i, c: base + i, v: 1, dp: null }));

interface FakeSeries {
  days: number[];
  sources?: HubSource[];
  complete?: boolean;
}

function fakeHub(series: Record<string, FakeSeries>) {
  const calls: Array<{ symbols: string[]; from: number; to: number }> = [];
  const batch = async (symbols: string[], from: number, to: number): Promise<HubCandlesBatch> => {
    calls.push({ symbols, from, to });
    const out: HubCandlesBatch = { tf: "1d", from, to, series: {}, queued: [], unknown: [] };
    for (const symbol of symbols) {
      const entry = series[symbol];
      if (!entry) out.unknown.push(symbol);
      else out.series[symbol] = { complete: entry.complete ?? true, coverage: null, candles: candles(entry.days, 100), sources: entry.sources };
    }
    return out;
  };
  return { batch, calls };
}

describe("long daily bars from the hub", () => {
  it("keeps a renamed stock continuous, and says which were joined, scaled, incomplete or missing", async () => {
    const hub = fakeHub({
      // INFOSYSTCH became INFY on 29 Jun 2011: the hub joins the two (market-data-hub#22).
      INFY: { days: SESSIONS, sources: [{ source: "archive", from: SESSIONS[0], to: SESSIONS[5], names: ["INFOSYSTCH", "INFY"] }] },
      CONCOR: { days: SESSIONS, sources: [{ source: "archive", from: SESSIONS[0], to: SESSIONS[3], names: ["CONCOR"], scale: 0.8 }, { source: "broker", from: SESSIONS[4], to: SESSIONS[5] }] },
      // A hub without the join: the new ticker's history starts at the rename.
      SPLIT: { days: [SESSIONS[0], SESSIONS[4], SESSIONS[5]], complete: false },
    });
    const set = await new LongBars({ batch: hub.batch }).load(["INFY", "CONCOR", "SPLIT", "GONE"], SESSIONS[0], SESSIONS[5]);
    expect(set.bars.get("INFY")!.map((bar) => bar.t)).toEqual(SESSIONS);
    expect(set.renamed).toEqual(new Map([["INFY", ["INFOSYSTCH", "INFY"]]]));
    expect(set.scaled).toEqual(new Map([["CONCOR", 0.8]]));
    expect(set.missing).toEqual(["GONE"]);
    expect(set.incomplete).toEqual(["SPLIT"]);
    // The continuity check: the joined series has no gap, the unjoined one does.
    expect(set.gaps.has("INFY")).toBe(false);
    expect(set.gaps.get("SPLIT")).toEqual(SESSIONS.slice(1, 4));
    const warnings = longWarnings({ from: SESSIONS[0], to: SESSIONS[5], set, standInUntil: d("2011-12-30") }, 3);
    expect(warnings.join("\n")).toMatch(/INFOSYSTCH → INFY/);
    expect(warnings.join("\n")).toMatch(/equal-weight NIFTY 50 basket/);
    expect(warnings.join("\n")).toMatch(/SPLIT 3/);
  });

  it("asks in groups of symbols, and answers the same request again from memory", async () => {
    const series = Object.fromEntries(Array.from({ length: LONG_BATCH_SYMBOLS + 5 }, (_, i) => [`S${i}`, { days: SESSIONS }]));
    const hub = fakeHub(series);
    const bars = new LongBars({ batch: hub.batch });
    const symbols = Object.keys(series);
    const set = await bars.load(symbols, SESSIONS[0], SESSIONS[5]);
    expect(set.bars.size).toBe(symbols.length);
    expect(hub.calls.map((call) => call.symbols.length)).toEqual([LONG_BATCH_SYMBOLS, 5]);
    expect(await bars.load([...symbols].reverse(), SESSIONS[0], SESSIONS[5])).toBe(set);
    expect(hub.calls).toHaveLength(2);
    await bars.load(symbols, SESSIONS[1], SESSIONS[5]);
    expect(hub.calls).toHaveLength(4);
  });
});
