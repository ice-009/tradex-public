import { useEffect, useSyncExternalStore } from "react";
import type { EvidenceResponse, TradeCloseRequest, TradeCreateRequest, TradesResponse, TradeUpdateRequest } from "@/contracts/api";
import type { ScreenEvidence } from "@/core/plan/evidence";
import { api } from "@/client/api";

// Shared state for the daily plan: the strategy evidence (which screens have
// an edge in which market) and your trade journal. The Plan tab, the Explore
// tab's "works in any market / uptrends only / no edge" labels and the dock
// badge all read it.

/** While the server replays the history (~10 s on first run each day). */
const COMPUTING_POLL_MS = 2_000;
/** The table changes once a day; a quiet re-check picks up the evening's new session. */
const EVIDENCE_REFRESH_MS = 30 * 60 * 1000;
/** Open trades' actions follow the stored bars (end of day); live prices are applied in the browser. */
const TRADES_REFRESH_MS = 5 * 60 * 1000;
const ERROR_RETRY_MS = 60_000;

export interface PlanFeed {
  evidence: EvidenceResponse | null;
  trades: TradesResponse | null;
  tradesError: string | null;
}

let feed: PlanFeed = { evidence: null, trades: null, tradesError: null };
const listeners = new Set<() => void>();

function setFeed(patch: Partial<PlanFeed>) {
  feed = { ...feed, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Select a slice of the feed. Selectors must return existing references. */
export function usePlanFeed<T>(selector: (current: PlanFeed) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(feed),
    () => selector(feed),
  );
}

/** Per-screen evidence once the table is ready (null before). */
export function useEvidenceScreens(): Record<string, ScreenEvidence> | null {
  return usePlanFeed((current) => (current.evidence?.status === "ready" ? current.evidence.table.screens : null));
}

export async function reloadTrades() {
  try {
    setFeed({ trades: await api.trades(), tradesError: null });
  } catch (error) {
    setFeed({ tradesError: (error as Error).message });
  }
}

/** Mount once (in the workspace): loads the evidence (polling while it is computed) and the journal. */
export function usePlanPolling() {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loadEvidence = async () => {
      let next = EVIDENCE_REFRESH_MS;
      try {
        const json = await api.evidence();
        if (cancelled) return;
        // Keep a ready table on screen if a refresh fails.
        if (json.status !== "error" || feed.evidence?.status !== "ready") setFeed({ evidence: json });
        next = json.status === "computing" || (json.status === "ready" && json.updating) ? COMPUTING_POLL_MS : json.status === "error" ? ERROR_RETRY_MS : EVIDENCE_REFRESH_MS;
      } catch (error) {
        if (!cancelled && feed.evidence?.status !== "ready") setFeed({ evidence: { status: "error", error: (error as Error).message } });
        next = ERROR_RETRY_MS;
      }
      if (!cancelled) timer = setTimeout(loadEvidence, next);
    };
    void loadEvidence();
    void reloadTrades();
    const tradesTimer = setInterval(() => void reloadTrades(), TRADES_REFRESH_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(tradesTimer);
    };
  }, []);
}

// ------------------------------------------------------------------ journal actions (each reloads the journal)

export async function takeTrade(body: TradeCreateRequest) {
  await api.createTrade(body);
  await reloadTrades();
}

export async function editTrade(id: string, body: TradeUpdateRequest) {
  await api.updateTrade(id, body);
  await reloadTrades();
}

export async function closeTrade(id: string, body: TradeCloseRequest) {
  await api.closeTrade(id, body);
  await reloadTrades();
}

export async function removeTrade(id: string) {
  await api.deleteTrade(id);
  await reloadTrades();
}
