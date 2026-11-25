import { describe, expect, it } from "vitest";
import { scanSignals, WARMUP_SESSIONS, type Signal } from "@/core/backtest/signals";
import type { DailyBar } from "@/core/types";
import { featureCursor } from "./featureCursor";
import { computeFeatures, rankRelativeStrength, type Features } from "./features";
import { SCREENS } from "./screens";

// Equivalence guard for issue #14: featureCursor(symbol, bars).at(i, from) must
// equal computeFeatures(symbol, bars.slice(from, i + 1), false) exactly — every
// field, bit for bit (toEqual compares numbers with Object.is, so even −0 vs 0
// would fail) — and every screen must see the same thing on every session.

const DAY = 86_400_000;
const T0 = Date.UTC(2022, 0, 3);
const SESSIONS = 620;
const WINDOW = 260;

/** Seeded PRNG (mulberry32) so the fixture is the same on every machine. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A regime-switching walk with the cases features branch on: big gaps on heavy
 * volume (event days), flat bars (zero range, zero change), zero-volume days,
 * inside days, long trends (pattern breakouts, 52-week highs), and delivery %
 * that is missing on some sessions — or, per `delivery`, mostly or entirely.
 */
function series(seed: number, count: number, delivery: "full" | "sparse" | "none" = "full"): DailyBar[] {
  const next = rng(seed);
  const bars: DailyBar[] = [];
  let close = 50 + next() * 2000;
  let drift = 0;
  let vol = 0.02;
  for (let i = 0; i < count; i += 1) {
    if (next() < 0.03) drift = (next() - 0.4) * 0.01;
    if (next() < 0.02) vol = 0.005 + next() * 0.04;
    const t = T0 + i * DAY;
    const dp = delivery === "none" || (delivery === "sparse" && next() < 0.8) || next() < 0.1 ? undefined : 20 + next() * 60;
    if (next() < 0.02) {
      // A flat session: no range, no change.
      bars.push({ t, o: close, h: close, l: close, c: close, v: next() < 0.5 ? 0 : 1e5, ...(dp === undefined ? {} : { dp }) });
      continue;
    }
    const event = next() < 0.03;
    const gap = event ? (next() < 0.5 ? -1 : 1) * (0.04 + next() * 0.06) : (next() - 0.5) * vol * 0.5;
    const o = close * (1 + gap);
    const c = Math.max(1, o * (1 + drift + (next() - 0.5) * 2 * vol));
    const h = Math.max(o, c) * (1 + next() * vol * 0.6);
    const l = Math.min(o, c) * (1 - next() * vol * 0.6);
    const v = Math.round((event ? 4 + next() * 4 : 0.4 + next() * 1.2) * 2e6);
    bars.push({ t, o, h, l, c, v, ...(dp === undefined ? {} : { dp }) });
    close = c;
  }
  return bars;
}

function universe() {
  const data = new Map<string, DailyBar[]>();
  for (let i = 0; i < 10; i += 1) data.set(`STK${i}`, series(1000 + i * 37, SESSIONS, i === 7 ? "sparse" : i === 8 ? "none" : "full"));
  // Listed late (shorter history, aligned to the same calendar).
  data.set("NEW", series(77, SESSIONS).slice(SESSIONS - 150));
  data.set("TINY", series(78, 40));
  // A bad row (NaN volume): the cursor falls back to computeFeatures for such stocks.
  const bad = series(79, SESSIONS);
  bad[300] = { ...bad[300], v: Number.NaN };
  data.set("BAD", bad);
  // A zero close and a zero-range bar at zero: odd but finite, so it stays on the fast path.
  const zero = series(80, SESSIONS);
  zero[420] = { ...zero[420], c: 0 };
  zero[421] = { ...zero[421], o: 0, h: 0, l: 0, c: 0 };
  data.set("ZERO", zero);
  return data;
}

const old = (symbol: string, bars: DailyBar[], i: number, from: number) => computeFeatures(symbol, bars.slice(from, i + 1), false);

describe("featureCursor", () => {
  const data = universe();

  it("equals computeFeatures on every session's sliding 260-bar window", () => {
    let checked = 0;
    for (const [symbol, bars] of data) {
      const cursor = featureCursor(symbol, bars);
      // Only the stock with a NaN bar falls back to computeFeatures; the rest test the fast path.
      expect(cursor.fast, symbol).toBe(symbol !== "BAD");
      for (let i = 0; i < bars.length; i += 1) {
        const from = Math.max(0, i - WINDOW + 1);
        expect(cursor.at(i, from), `${symbol} bar ${i}`).toEqual(old(symbol, bars, i, from));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(6000);
  });

  it("equals computeFeatures on other windows (whole history, arbitrary starts, one bar)", () => {
    const next = rng(5);
    for (const [symbol, bars] of data) {
      const cursor = featureCursor(symbol, bars);
      for (let trial = 0; trial < 120; trial += 1) {
        const i = Math.floor(next() * bars.length);
        const from = trial % 3 === 0 ? 0 : trial % 3 === 1 ? i : Math.floor(next() * (i + 1));
        expect(cursor.at(i, from), `${symbol} bars ${from}..${i}`).toEqual(old(symbol, bars, i, from));
      }
      expect(cursor.at(bars.length - 1)).toEqual(computeFeatures(symbol, bars, false));
    }
  });

  it("every screen gets the same rule results, score and plan on every session", () => {
    const cursors = new Map([...data].map(([symbol, bars]) => [symbol, featureCursor(symbol, bars)]));
    const ctx = { niftyRet126: 4 };
    let matches = 0;
    for (let d = WARMUP_SESSIONS - 1; d < SESSIONS; d += 1) {
      const date = T0 + d * DAY;
      const before: Features[] = [];
      const after: Features[] = [];
      for (const [symbol, bars] of data) {
        const i = bars.findIndex((bar) => bar.t === date);
        if (i < 0) continue;
        const from = Math.max(0, i - WINDOW + 1);
        before.push(old(symbol, bars, i, from));
        after.push(cursors.get(symbol)!.at(i, from));
      }
      rankRelativeStrength(before);
      rankRelativeStrength(after);
      expect(after).toEqual(before);
      for (const screen of SCREENS) {
        for (let k = 0; k < before.length; k += 1) {
          const rules = screen.rules.map((rule) => rule.test(before[k], ctx));
          expect(screen.rules.map((rule) => rule.test(after[k], ctx)), `${screen.id} ${before[k].symbol} ${d}`).toEqual(rules);
          if (!rules.every(Boolean)) continue;
          matches += 1;
          expect(screen.score(after[k])).toEqual(screen.score(before[k]));
          expect(screen.plan(after[k])).toEqual(screen.plan(before[k]));
        }
      }
    }
    // The fixture has to make screens fire, or this proves little.
    expect(matches).toBeGreaterThan(500);
  });

  it("scanSignals gives the same signals as replaying computeFeatures session by session", async () => {
    const symbols = [...data.keys()];
    const benchmark = series(4242, SESSIONS);
    const isMember = (symbol: string, date: number) => symbol !== "STK3" || date > T0 + 300 * DAY;
    const scan = await scanSignals({ symbols, getBars: (symbol) => data.get(symbol)!, benchmark, isMember });

    // The scan as it was before issue #14: computeFeatures on a fresh 260-bar slice every session.
    const expected = new Map<number, Signal[]>();
    for (let d = 0; d < SESSIONS; d += 1) {
      const date = T0 + d * DAY;
      const day: Array<{ f: Features; bars: DailyBar[]; i: number }> = [];
      for (const symbol of symbols) {
        const bars = data.get(symbol)!;
        if (bars.length < WARMUP_SESSIONS) continue;
        const i = bars.findIndex((bar) => bar.t === date);
        if (i < WARMUP_SESSIONS - 1 || !isMember(symbol, date)) continue;
        day.push({ f: old(symbol, bars, i, Math.max(0, i - WINDOW + 1)), bars, i });
      }
      if (!day.length) continue;
      rankRelativeStrength(day.map((item) => item.f));
      const ctx = { niftyRet126: d >= 126 ? (benchmark[d].c / benchmark[d - 126].c - 1) * 100 : NaN };
      const found: Signal[] = [];
      for (const screen of SCREENS) {
        for (const { f, bars, i } of day) {
          if (screen.basis === "eod" && bars[i].dp === undefined) continue;
          if (!screen.rules.every((rule) => rule.test(f, ctx))) continue;
          const plan = screen.plan(f);
          if (!(plan.entry - plan.stop > 0)) continue;
          const score = screen.score(f);
          found.push({ symbol: f.symbol, screenId: screen.id, date, index: i, score: Number.isFinite(score) ? score : 0, close: bars[i].c, entry: plan.entry, stop: plan.stop, target: plan.target });
        }
      }
      if (found.length) expected.set(date, found);
    }
    expect(scan.signals).toBeGreaterThan(500);
    expect(scan.byDate).toEqual(expected);
  });
});
