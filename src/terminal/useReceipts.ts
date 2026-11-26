"use client";

import { useMemo } from "react";
import { factorReceipt, gateFor, screenReceipt, type Receipt } from "@/core/lab/receipt";
import { FACTOR_KEYS, type FactorKey, type ScoreGate } from "@/core/screener/score";
import { usePlanFeed } from "@/client/planFeed";
import { useReceiptCards } from "@/client/receiptsFeed";
import { SCREENS } from "@/core/screener/screens";
import { useMarketState } from "./usePlan";

// Receipts (#29) for the terminal: the server's card summaries
// (client/receiptsFeed.ts) with the plan's evidence, the live record and
// today's market state, through the pure model in src/core/lab/receipt.ts.

/** Every score factor's receipt (null until the cards are loaded). */
export function useFactorReceipts(): Record<FactorKey, Receipt> | null {
  const cards = useReceiptCards();
  const state = useMarketState();
  return useMemo(() => (cards ? (Object.fromEntries(FACTOR_KEYS.map((key) => [key, factorReceipt(key, cards.factors[key], state)])) as Record<FactorKey, Receipt>) : null), [cards, state]);
}

/**
 * The setup score's gate: the factors whose card passes in today's market.
 * Null until the cards are loaded (the score is then ungated, as before).
 * The same reference until the list changes, so it can sit in memo deps.
 */
export function useScoreGate(): ScoreGate | null {
  const cards = useReceiptCards();
  const state = useMarketState();
  const proven = cards ? gateFor(cards.passing, state).join(",") : null;
  return useMemo(() => (proven === null ? null : { proven: proven ? (proven.split(",") as FactorKey[]) : [] }), [proven]);
}

/** Every screen's receipt (null until the evidence or the cards are in). */
export function useScreenReceipts(): Record<string, Receipt> | null {
  const cards = useReceiptCards();
  const state = useMarketState();
  const evidence = usePlanFeed((feed) => (feed.evidence?.status === "ready" ? feed.evidence : null));
  return useMemo(() => {
    if (!evidence && !cards) return null;
    return Object.fromEntries(
      SCREENS.map((screen) => [
        screen.id,
        screenReceipt(screen.id, {
          evidence: evidence?.table.screens[screen.id] ?? null,
          table: evidence ? { from: evidence.table.from, to: evidence.table.to } : null,
          state,
          card: cards?.screens[screen.id] ?? null,
          live: evidence?.live?.[screen.id] ?? null,
        }),
      ]),
    );
  }, [cards, state, evidence]);
}
