import { describe, expect, it } from "vitest";
import { applyQuotes, emptyState, type HLQuote } from "./highLow";

const q = (instrument: string, high: number, low: number, ltp: number, segment: HLQuote["segment"] = "cash"): HLQuote => ({
  symbol: "SBIN",
  segment,
  instrument,
  ltp,
  high,
  low,
  open: 800,
  prevClose: 800,
});

describe("day high / low detection", () => {
  it("prints new highs and lows after a baseline", () => {
    const state = emptyState(0);
    expect(applyQuotes(state, [q("NSE:SBIN-EQ", 810, 795, 805)], 1)).toHaveLength(0); // baseline
    expect(applyQuotes(state, [q("NSE:SBIN-EQ", 810, 795, 808)], 2)).toHaveLength(0); // unchanged

    const high = applyQuotes(state, [q("NSE:SBIN-EQ", 812, 795, 809)], 3);
    expect(high).toMatchObject([{ kind: "high", price: 812, previous: 810, count: 1 }]);

    const both = applyQuotes(state, [q("NSE:SBIN-EQ", 815, 790, 791)], 4);
    expect(both.map((event) => [event.kind, event.count])).toEqual([
      ["high", 2],
      ["low", 1],
    ]);

    const fut = applyQuotes(state, [q("NSE:SBIN26NOVFUT", 820, 798, 815, "fut"), q("NSE:SBIN26NOVFUT", 822, 798, 821, "fut")], 5);
    expect(fut).toMatchObject([{ segment: "fut", kind: "high" }]);

    expect(applyQuotes(state, [q("NSE:X-EQ", 0, 0, 0)], 6)).toHaveLength(0);
    expect(state.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
  });
});
