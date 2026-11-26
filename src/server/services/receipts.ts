import "server-only";

import type { ReceiptsResponse } from "@/contracts/api";
import { variantKey } from "@/core/lab/engine";
import { FACTOR_SIGNALS, passingFactors, summarizeCard, type CardSummary } from "@/core/lab/receipt";
import { findSignal, resolveParams } from "@/core/lab/signals";
import { ideaIdOf } from "@/core/lab/trialInputs";
import { FACTOR_KEYS, type FactorKey } from "@/core/screener/score";
import { SCREENS, SCREEN_MAP } from "@/core/screener/screens";
import { log } from "@/server/log";
import { variantCard } from "./labCards";
import { isPromotable } from "./labTrials";

// Receipts (#29): the report-card half of every score factor's and screen's
// receipt (rules in src/core/lab/receipt.ts), and the factors whose card
// passes — the gate the setup score is given (src/core/screener/score.ts).
// The browser adds the plan's evidence and the live record it already loads.
//
// A receipt reads the DEFAULT variant of the signal — the one the score (or the
// screen) actually uses: its parameters at their defaults, not reversed, close
// → close. Another variant passing doesn't make the factor pass. Its verdict is
// judged against the trial record as it stands now (the deflated Sharpe ratio
// falls as more variants of the idea are tried), and isPromotable asks the
// record the same about this variant.

/**
 * The variant key of a signal's default parameters (what the score and the
 * screens use). An overnight (BTST) screen is the close → open variant: its
 * trades are bought at the close and sold at the next open, so that is the
 * forward return its card has to measure.
 */
export function defaultVariantKey(signalId: string): string | null {
  const signal = findSignal(signalId);
  if (!signal) return null;
  const screen = signalId.startsWith("screen:") ? SCREEN_MAP[signalId.slice("screen:".length)] : undefined;
  return variantKey(signal.id, resolveParams(signal, {}), screen?.exit === "next-open" ? { forward: "close-open" } : {});
}

/** A signal's default variant as a receipt reads it; null when it was never run (or can't be read). */
export function cardSummaryFor(signalId: string): CardSummary | null {
  const key = defaultVariantKey(signalId);
  if (!key) return null;
  try {
    const found = variantCard(signalId, key);
    if (!found) return null;
    let promotable = false;
    try {
      promotable = isPromotable(ideaIdOf(found.entry.report), key);
    } catch (error) {
      log.warn("Lab trials unreadable for a receipt", { signal: signalId, error: error instanceof Error ? error.message : String(error) });
    }
    return summarizeCard({ variantKey: key, runAt: found.entry.runAt, report: found.entry.report, verdict: found.verdict, promotable });
  } catch (error) {
    log.warn("Report card unreadable for a receipt", { signal: signalId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** Every factor's and screen's card summary, and the factors that pass. */
export function labReceipts(): ReceiptsResponse {
  const factors = Object.fromEntries(FACTOR_KEYS.map((key) => [key, cardSummaryFor(FACTOR_SIGNALS[key])])) as Record<FactorKey, CardSummary | null>;
  const screens = Object.fromEntries(SCREENS.map((screen) => [screen.id, cardSummaryFor(`screen:${screen.id}`)]));
  return { factors, screens, passing: passingFactors(factors), computedAt: Date.now() };
}
