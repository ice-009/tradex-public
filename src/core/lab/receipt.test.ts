import { describe, expect, it } from "vitest";
import { COST_PRESETS } from "@/core/backtest/costs";
import { bucketOf, verdictOf, type EvidenceTrade, type ScreenEvidence } from "@/core/plan/evidence";
import { FACTOR_KEYS } from "@/core/screener/score";
import type { DailyBar } from "@/core/types";
import { runLab } from "./engine";
import { FACTOR_SIGNALS, cardHref, cardPasses, factorReceipt, gateFor, passingFactors, provenFactors, receiptLine, screenReceipt, summarizeCard, worksIn, type CardSummary } from "./receipt";
import { LAB_SIGNALS } from "./signals";
import { signalVerdict } from "./verdict";

const DAY = 86_400_000;
const T0 = Date.UTC(2022, 1, 14);
const T1 = Date.UTC(2026, 10, 25);

const card = (over: Partial<CardSummary> = {}): CardSummary => ({
  signalId: "score-trend",
  variantKey: "score-trend {}",
  runAt: 1,
  period: { from: T0, to: T1 },
  label: "works",
  headline: "Works.",
  horizon: 10,
  net: 0.0012,
  t: 3.1,
  days: 1_150,
  deflation: "passes",
  promotable: true,
  ...over,
});

describe("receipts (#29)", () => {
  it("maps every score factor to a Lab signal", () => {
    const ids = new Set(LAB_SIGNALS.map((signal) => signal.id));
    for (const key of FACTOR_KEYS) expect(ids.has(FACTOR_SIGNALS[key])).toBe(true);
  });

  it("links to the card, encoding the signal id and variant", () => {
    expect(cardHref("screen:btst-20d-high")).toBe("/lab/screen%3Abtst-20d-high");
    expect(cardHref("score-trend", "score-trend {}")).toBe("/lab/score-trend?variant=score-trend%20%7B%7D");
  });

  it("a factor passes only with a 'works' verdict that survives the trial record", () => {
    expect(cardPasses(card())).toBe(true);
    expect(cardPasses(card({ promotable: false }))).toBe(false);
    expect(cardPasses(card({ label: "no edge" }))).toBe(false);
    expect(cardPasses(card({ label: "too little data", promotable: true }))).toBe(false);
    expect(cardPasses(null)).toBe(false);
    expect(worksIn("works in uptrends only")).toBe("up");
    expect(worksIn("no edge")).toBeNull();
  });

  it("an untested factor is unproven and says so", () => {
    const receipt = factorReceipt("pattern", null, "up");
    expect(receipt).toMatchObject({ subject: "factor", signalId: "score-pattern", cardHref: "/lab/score-pattern", hasCard: false, promotable: false, verdict: "not tested yet" });
    expect(receiptLine(receipt)).toBe("Not tested yet — run its report card");
  });

  it("a factor's receipt: period, market, net % per hold, days, verdict", () => {
    const receipt = factorReceipt("trend", card(), "down");
    expect(receipt.promotable).toBe(true);
    expect(receiptLine(receipt)).toBe("Feb 2022–Nov 2026 · any market · +0.120% per 10d net · 1,150 days · works");
    // Looks good but not past the luck check: shown, not promoted.
    const lucky = factorReceipt("trend", card({ promotable: false, deflation: "fails" }), "up");
    expect(lucky.promotable).toBe(false);
    expect(lucky.verdict).toBe("works, not yet past the luck check");
  });

  it("a regime-only factor counts only in that market", () => {
    const up = card({ label: "works in uptrends only" });
    expect(factorReceipt("trend", up, "up").promotable).toBe(true);
    expect(factorReceipt("trend", up, "down").promotable).toBe(false);
    expect(factorReceipt("trend", up, null).promotable).toBe(false);
    const cards = { trend: up, extension: card(), pattern: card({ promotable: false }), rr: null };
    expect(passingFactors(cards)).toEqual([
      { key: "trend", worksIn: "up" },
      { key: "extension", worksIn: "any" },
    ]);
    expect(gateFor(passingFactors(cards), "up")).toEqual(["trend", "extension"]);
    expect(gateFor(passingFactors(cards), "down")).toEqual(["extension"]);
    expect(gateFor([], "up")).toEqual([]);
    expect(provenFactors({ trend: factorReceipt("trend", up, "down"), extension: factorReceipt("extension", card(), "down") })).toEqual(["extension"]);
  });

  it("summarises a stored report at its verdict's horizon", () => {
    let state = 5;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296 - 0.5;
    const dates = Array.from({ length: 300 }, (_, i) => T0 + i * DAY);
    const symbols = Array.from({ length: 30 }, (_, s) => `S${s}`);
    const bars = new Map<string, DailyBar[]>(
      symbols.map((symbol, s) => {
        let close = 100;
        return [symbol, dates.map((t, i) => ({ t, o: close, h: close, l: close, c: (close *= i ? 1 + (s - 15) * 0.0003 + next() * 0.02 : 1), v: 1e6 }))];
      }),
    );
    const report = runLab({ signal: { id: "score-trend", name: "Trend", kind: "numeric", params: {} }, dates, symbols, bars, values: (_d, symbol) => Number(symbol.slice(1)), costs: COST_PRESETS.none.model, minStocks: 10 });
    const verdict = signalVerdict(report);
    const summary = summarizeCard({ variantKey: report.signal.variantKey, runAt: 7, report, verdict, promotable: false });
    const h = report.byHorizon.find((entry) => entry.horizon === verdict.horizon)!;
    expect(summary).toMatchObject({ signalId: "score-trend", variantKey: report.signal.variantKey, runAt: 7, label: verdict.label, horizon: verdict.horizon, deflation: verdict.deflation, promotable: false });
    expect(summary.period).toEqual({ from: report.period.from, to: report.period.to });
    if (worksIn(verdict.label) === "any") expect(summary.net).toBe(h.spread.net.mean);
    expect(summary.days).toBeGreaterThan(0);
  });

  it("a screen's receipt is the plan's evidence in today's market, with its card and live record", () => {
    const trades: EvidenceTrade[] = Array.from({ length: 80 }, (_, i) => ({
      screenId: "btst-20d-high",
      symbol: `S${i % 7}`,
      date: T0 + i * 3 * DAY,
      score: i,
      state: i % 4 === 0 ? "down" : "up",
      entry: 100,
      exit: 101,
      kind: "open",
      grossR: 0.2 + (i % 5) * 0.01,
      netR: i % 4 === 0 ? -0.1 : 0.1 + (i % 3) * 0.05,
    }));
    const up = bucketOf(trades.filter((trade) => trade.state === "up"), T1);
    const down = bucketOf(trades.filter((trade) => trade.state === "down"), T1);
    const all = bucketOf(trades, T1);
    const evidence: ScreenEvidence = { screenId: "btst-20d-high", up, down, all, verdict: verdictOf(up, down, all) };
    expect(evidence.verdict).toBe("uptrend");
    const live = { screenId: "btst-20d-high", since: T0, trades: 6, pending: 0, avgNetPct: 0.3, avgGrossPct: 0.4, winShare: 4 / 6, gapStops: 0 };
    const receipt = screenReceipt("btst-20d-high", { evidence, table: { from: T0, to: T1 }, state: "up", card: card({ signalId: "screen:btst-20d-high", label: "no edge", variantKey: "screen:btst-20d-high {}" }), live });
    expect(receipt).toMatchObject({ subject: "screen", signalId: "screen:btst-20d-high", hasCard: true, worksIn: "up", promotable: true, lab: "no edge", live: { wins: 4, trades: 6 } });
    expect(receipt.cardHref).toBe("/lab/screen%3Abtst-20d-high?variant=screen%3Abtst-20d-high%20%7B%7D");
    expect(receipt.expectancy).toEqual({ value: up.mean, unit: "R", horizon: 1 });
    expect(receiptLine(receipt)).toBe(`Feb 2022–Nov 2026 · uptrends only · +${up.mean!.toFixed(2)}R/trade (1d) · ${up.n} trades · live 4/6 · Uptrends only · Lab: no edge`);
    // In a downtrend it doesn't pass the plan's rule, and the downtrend bucket is the one shown.
    const inDown = screenReceipt("btst-20d-high", { evidence, table: { from: T0, to: T1 }, state: "down" });
    expect(inDown).toMatchObject({ promotable: false, sample: { n: down.n, unit: "trades" }, hasCard: false, live: null, lab: null });
    // No evidence and no card: untested.
    expect(screenReceipt("btst-20d-high", { state: "up" })).toMatchObject({ verdict: "not tested yet", period: null, promotable: false });
  });
});
