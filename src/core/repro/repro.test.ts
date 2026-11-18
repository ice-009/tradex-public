import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/core/types";
import { canonicalJson, canonicalNumber } from "./canonical";
import { Sha256, sha256 } from "./sha256";
import { compareRuns, diffValues, hashBars, hashDataset, lotsOf, makeStamp, withDataPart, type DataStamp } from "./stamp";

describe("sha256", () => {
  it("matches the FIPS 180-4 test vectors", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(sha256("a".repeat(1_000_000))).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });

  it("hashes UTF-8 and gives the same digest however the input is split", () => {
    expect(sha256("₹")).toBe(sha256(new Uint8Array([0xe2, 0x82, 0xb9])));
    const text = "The quick brown fox jumps over the lazy dog ₹ ".repeat(37);
    for (const size of [1, 3, 55, 56, 63, 64, 65, 200]) {
      const hash = new Sha256();
      for (let i = 0; i < text.length; i += size) hash.update(text.slice(i, i + size));
      expect(hash.hex()).toBe(sha256(text));
    }
  });
});

describe("canonical JSON", () => {
  it("sorts keys at every level and drops undefined like JSON", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, undefined, "x"], c: null }, e: undefined })).toBe('{"a":{"c":null,"d":[1,null,"x"]},"b":1}');
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("formats numbers one way", () => {
    expect(canonicalNumber(-0)).toBe("0");
    expect(canonicalNumber(1730419200000)).toBe("1730419200000");
    expect(canonicalNumber(0.1 + 0.2)).toBe("0.3");
    expect(canonicalNumber(1234567.891234567)).toBe("1234567.89123");
    expect(canonicalNumber(1e-9 / 3)).toBe("3.33333333333e-10");
    expect(canonicalNumber(NaN)).toBe('"NaN"');
    expect(canonicalNumber(-Infinity)).toBe('"-Infinity"');
    // A last-bit difference in floating-point maths doesn't change the text.
    expect(canonicalNumber(Math.exp(1))).toBe(canonicalNumber(Math.E * (1 + Number.EPSILON)));
  });

  it("writes Maps as sorted objects and Sets as sorted arrays", () => {
    const value = new Map<number, Set<string>>([
      [2, new Set(["B", "A"])],
      [10, new Set(["C"])],
    ]);
    expect(canonicalJson(value)).toBe('{"10":["C"],"2":["A","B"]}');
  });
});

const bar = (t: number, c: number, dp?: number): DailyBar => ({ t, o: c, h: c + 1, l: c - 1, c, v: 1000, dp });

describe("data stamp", () => {
  const bars = new Map([
    ["SBIN", [bar(1, 100, 40), bar(2, 101)]],
    ["INFY", [bar(1, 50), bar(3, 52)]],
    ["NIFTY", [bar(1, 20000), bar(2, 20100), bar(3, 20200)]],
  ]);

  it("hashes the content, not the order or identity of the inputs", async () => {
    const a = await hashDataset({ bars, benchmark: "NIFTY", lots: { SBIN: 750, INFY: 400, TCS: 175 }, universe: ["SBIN", "INFY"] });
    const b = await hashDataset({
      bars: new Map([...bars].reverse().map(([symbol, series]) => [symbol, series.map((item) => ({ ...item }))])),
      benchmark: "NIFTY",
      lots: { INFY: 400, SBIN: 750, TCS: 999 }, // TCS isn't in the dataset: its lot size doesn't count
      universe: ["INFY", "SBIN"],
    });
    expect(b.hash).toBe(a.hash);
    expect(a.symbols).toEqual(["INFY", "SBIN"]);
    expect(a).toMatchObject({ from: 1, to: 3, sessions: 3, bars: 7 });
  });

  it("changes when a bar, a lot size or the F&O list changes", async () => {
    const base = await hashDataset({ bars, benchmark: "NIFTY", lots: { SBIN: 750 }, membership: new Map([[1, new Set(["SBIN"])]]) });
    const moved = new Map(bars);
    moved.set("SBIN", [bar(1, 100, 40), { ...bar(2, 101), c: 101.05 }]);
    const changedBar = await hashDataset({ bars: moved, benchmark: "NIFTY", lots: { SBIN: 750 }, membership: new Map([[1, new Set(["SBIN"])]]) });
    const changedLots = await hashDataset({ bars, benchmark: "NIFTY", lots: { SBIN: 1500 }, membership: new Map([[1, new Set(["SBIN"])]]) });
    const changedList = await hashDataset({ bars, benchmark: "NIFTY", lots: { SBIN: 750 }, membership: new Map([[1, new Set(["SBIN", "INFY"])]]) });
    const later = await hashDataset({ bars, benchmark: "NIFTY", lots: { SBIN: 750 }, membership: new Map([[1, new Set(["SBIN"])], [9, new Set(["X"])]]) });
    expect(changedBar.parts.bars).not.toBe(base.parts.bars);
    expect(changedLots.parts.lots).not.toBe(base.parts.lots);
    expect(changedList.parts.membership).not.toBe(base.parts.membership);
    // F&O lists after the last session can't affect the run.
    expect(later.hash).toBe(base.hash);
    expect(new Set([base.hash, changedBar.hash, changedLots.hash, changedList.hash]).size).toBe(4);
  });

  it("adds a part later with the same hash as hashing it up front", async () => {
    const full = await hashDataset({ bars, benchmark: "NIFTY", lots: { SBIN: 750 } });
    const later = withDataPart(await hashDataset({ bars, benchmark: "NIFTY" }), "lots", lotsOf({ SBIN: 750, TCS: 1 }, full));
    expect(later.hash).toBe(full.hash);
  });

  it("hashes a series like the canonical JSON of its rows", () => {
    const series = bars.get("SBIN")!;
    expect(hashBars(series)).toBe(sha256(canonicalJson(series.map((item) => [item.t, item.o, item.h, item.l, item.c, item.v, item.dp ?? null]))));
    const long = Array.from({ length: 3000 }, (_, i) => bar(i, 100 + i / 7));
    expect(hashBars(long)).toBe(sha256(canonicalJson(long.map((item) => [item.t, item.o, item.h, item.l, item.c, item.v, null]))));
  });
});

describe("run comparison", () => {
  const data: DataStamp = { hash: "d1", parts: { bars: "b1" }, symbols: ["A", "B"], benchmark: "NIFTY", from: 0, to: 86_400_000, sessions: 2, bars: 6, membership: null, hub: null };
  const code = { commit: "abc1234", engine: "backtest/6" };
  const stamp = (overrides: { data?: DataStamp; params?: Record<string, unknown>; result: unknown }) =>
    makeStamp({ kind: "backtest", code, data: overrides.data ?? data, params: overrides.params ?? { riskPct: 1 }, result: overrides.result, createdAt: 0 });

  it("calls a run with the same inputs and result identical", () => {
    const result = { trades: [{ pnl: 10.5 }], total: 10.5 };
    const a = stamp({ result });
    const b = stamp({ result: JSON.parse(JSON.stringify(result)) });
    expect(b.hash).toBe(a.hash);
    expect(compareRuns({ stamp: a, result }, { stamp: b, result })).toMatchObject({ identical: true, changes: [], differences: [] });
  });

  it("names what changed and where the results differ", () => {
    const before = { trades: [{ pnl: 10.5 }], total: 10.5 };
    const after = { trades: [{ pnl: 10.5 }, { pnl: -3 }], total: 7.5 };
    const a = stamp({ result: before });
    const b = stamp({ data: { ...data, hash: "d2", parts: { bars: "b2" }, to: 2 * 86_400_000, symbols: ["A"] }, params: { riskPct: 2 }, result: after });
    const comparison = compareRuns({ stamp: a, result: before }, { stamp: b, result: after });
    expect(comparison.identical).toBe(false);
    expect(comparison.sameInputs).toBe(false);
    expect(comparison.changes.join(" ")).toMatch(/Data changed: bars\. History 1970-01-01 – 1970-01-02 → 1970-01-01 – 1970-01-03\. 1 fewer symbol \(B\)/);
    expect(comparison.changes.join(" ")).toMatch(/Parameters: riskPct 1 → 2/);
    expect(comparison.differences).toEqual([
      { path: "total", before: "10.5", after: "7.5" },
      { path: "trades.length", before: "1", after: "2" },
    ]);
  });

  it("ignores float noise below 12 significant digits", () => {
    expect(diffValues({ x: 0.1 + 0.2 }, { x: 0.3 }).total).toBe(0);
    expect(diffValues({ x: 0.3 }, { x: 0.30001 }).total).toBe(1);
  });
});
