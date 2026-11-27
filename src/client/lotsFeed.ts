import { useSyncExternalStore } from "react";
import type { LotsResponse } from "@/contracts/api";
import { api } from "@/client/api";
import { onTimeMachineChange, timeMachine } from "@/client/timeMachine";

// Stock-futures lot sizes (from the Market Data Hub), loaded once per page from /api/lots —
// and again when the Time Machine's day changes (lots as traded that day).

interface LotFeed {
  lots: Record<string, number>;
  source: LotsResponse["source"] | "loading";
  /** Time Machine: what the lots are (that day's, or a stand-in). */
  notes: string[];
}
let lotFeed: LotFeed = { lots: {}, source: "loading", notes: [] };
/** The day the lots were asked for ("" live); null before the first ask. */
let lotsRequestedFor: string | null = null;
const lotListeners = new Set<() => void>();

function loadLots() {
  const day = timeMachine().asOf ?? "";
  if (lotsRequestedFor === day) return;
  lotsRequestedFor = day;
  if (lotFeed.source !== "loading") lotFeed = { lots: {}, source: "loading", notes: [] };
  api
    .lots()
    .then((json) => {
      if (lotsRequestedFor !== day) return; // the day changed meanwhile
      lotFeed = { lots: json.lots ?? {}, source: json.source ?? "none", notes: json.asOf?.notes ?? [] };
    })
    .catch(() => {
      if (lotsRequestedFor === day) lotFeed = { lots: {}, source: "none", notes: [] };
    })
    .finally(() => lotListeners.forEach((listener) => listener()));
}

onTimeMachineChange(() => {
  if (lotListeners.size) loadLots();
  lotListeners.forEach((listener) => listener());
});

function useLotFeed(): LotFeed {
  return useSyncExternalStore(
    (listener) => {
      loadLots();
      lotListeners.add(listener);
      return () => {
        lotListeners.delete(listener);
      };
    },
    () => lotFeed,
    () => lotFeed,
  );
}

/** Futures lot size for a stock (null while loading or when no source had it). */
export function useLotSize(symbol: string): { lot: number | null; source: LotFeed["source"] } {
  const feedNow = useLotFeed();
  return { lot: feedNow.lots[symbol] ?? null, source: feedNow.source };
}

/** Every known lot size (empty while loading). */
export function useLotSizes(): LotFeed {
  return useLotFeed();
}
