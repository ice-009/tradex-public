import { useSyncExternalStore } from "react";
import { api } from "@/client/api";

// Stock-futures lot sizes (from the Market Data Hub), loaded once per page from /api/lots.

interface LotFeed {
  lots: Record<string, number>;
  source: "hub" | "disk" | "none" | "loading";
}
let lotFeed: LotFeed = { lots: {}, source: "loading" };
let lotsRequested = false;
const lotListeners = new Set<() => void>();

function loadLots() {
  if (lotsRequested) return;
  lotsRequested = true;
  api
    .lots()
    .then((json) => {
      lotFeed = { lots: json.lots ?? {}, source: json.source ?? "none" };
    })
    .catch(() => {
      lotFeed = { lots: {}, source: "none" };
    })
    .finally(() => lotListeners.forEach((listener) => listener()));
}

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
