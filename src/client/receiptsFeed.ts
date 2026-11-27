import { useEffect, useSyncExternalStore } from "react";
import type { ReceiptsResponse } from "@/contracts/api";
import { api } from "@/client/api";
import { useTimeMachine } from "@/client/timeMachine";

// The report-card half of the receipts (#29): every score factor's and
// screen's card in brief, and the factors whose card passes (the setup score's
// gate). Loaded on first use and refreshed while something shows it — a card
// changes only when the Lab is run again.
//
// Not in the Time Machine: a card is the Lab's run over periods up to today, so
// on a past day the score is shown ungated and no receipt is shown.

const REFRESH_MS = 10 * 60 * 1000;
const ERROR_RETRY_MS = 60_000;

let data: ReceiptsResponse | null = null;
const listeners = new Set<() => void>();
let users = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

function set(next: ReceiptsResponse) {
  data = next;
  for (const listener of listeners) listener();
}

async function load() {
  if (inFlight) return;
  inFlight = true;
  let next = REFRESH_MS;
  try {
    set(await api.receipts());
  } catch {
    // Without receipts the score is shown ungated, as before; try again soon.
    next = ERROR_RETRY_MS;
  } finally {
    inFlight = false;
  }
  if (users > 0) timer = setTimeout(load, next);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The receipts' card summaries (null until loaded, and in the Time Machine). Loads them on first use. */
export function useReceiptCards(): ReceiptsResponse | null {
  const pastDay = useTimeMachine((state) => state.asOf !== null);
  const cards = useLiveReceiptCards();
  return pastDay ? null : cards;
}

function useLiveReceiptCards(): ReceiptsResponse | null {
  useEffect(() => {
    users += 1;
    if (users === 1 && !timer) void load();
    return () => {
      users -= 1;
      if (users === 0 && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => data,
    () => null,
  );
}
