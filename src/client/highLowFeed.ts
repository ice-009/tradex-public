import { useEffect, useSyncExternalStore } from "react";
import type { HLEvent } from "@/core/scanner/highLow";
import type { ScanStatus } from "@/contracts/api";
import { api } from "@/client/api";

// Browser side of the Day High / Low scan: polls /api/highlow for events after
// the last sequence number and keeps the day's list in one shared store.

const POLL_MS = 5_000;
const KEEP = 1500;

export interface Feed {
  status: ScanStatus | "error";
  day: number;
  seq: number;
  events: HLEvent[];
  totals: { highs: number; lows: number };
  instruments: number;
  lastPollAt: number;
  /** Current full-sweep interval (ms), paced by the API budget; null when not sweeping. */
  sweepMs: number | null;
}

let feed: Feed = { status: "starting", day: 0, seq: 0, events: [], totals: { highs: 0, lows: 0 }, instruments: 0, lastPollAt: 0, sweepMs: null };
const listeners = new Set<() => void>();
const set = (next: Feed) => {
  feed = next;
  listeners.forEach((listener) => listener());
};

export function useHighLowFeed<T>(select: (current: Feed) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => select(feed),
    () => select(feed),
  );
}

/**
 * Mount once in the workspace. While `enabled` (the Day High/Low panel is open) it keeps
 * the server's scan alive and pulls new events; otherwise it stops asking, and the
 * server's scan goes idle after 90 s — the scan is the biggest API consumer, so it
 * only runs when someone is looking at it.
 */
export function useHighLowPolling(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      try {
        const json = await api.highLow(feed.seq);
        if (cancelled) return;
        {
          // A new trading day (or a restarted server) resets the sequence: start over.
          const reset = json.day !== feed.day || json.seq < feed.seq;
          const events = reset ? json.events : [...feed.events, ...json.events].slice(-KEEP);
          set({ status: json.status, day: json.day, seq: json.seq, events, totals: json.totals, instruments: json.instruments, lastPollAt: json.lastPollAt, sweepMs: json.sweepMs });
        }
      } catch {
        if (!cancelled) set({ ...feed, status: "error" });
      }
      if (!cancelled) timer = setTimeout(run, POLL_MS);
    };
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
}
