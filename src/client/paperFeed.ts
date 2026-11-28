import { useEffect, useSyncExternalStore } from "react";
import type { PaperResponse, PaperTakeRequest } from "@/contracts/api";
import { api } from "@/client/api";
import { replayBusy } from "@/client/replay";
import { inTimeMachine, useAsOfKey } from "@/client/timeMachine";

// Paper trading in a Time Machine replay (issue #32): the current paper
// session, graded by the server as of the day shown — reloaded every time the
// replay moves, so trades fill, stop out and time out as it advances. Kept
// apart from the real journal (planFeed.ts); live, it is empty.

export interface PaperFeed {
  data: PaperResponse | null;
  error: string | null;
  loading: boolean;
}

let feed: PaperFeed = { data: null, error: null, loading: false };
const listeners = new Set<() => void>();
let generation = 0;

function setFeed(patch: Partial<PaperFeed>) {
  feed = { ...feed, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePaperFeed<T>(selector: (current: PaperFeed) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(feed),
    () => selector({ data: null, error: null, loading: false }),
  );
}

/** Grade the session again as of the day shown. */
export async function reloadPaper() {
  const mine = ++generation;
  if (!inTimeMachine()) {
    setFeed({ data: null, error: null, loading: false });
    replayBusy("paper", false);
    return;
  }
  setFeed({ loading: true });
  replayBusy("paper", true);
  try {
    const data = await api.paper();
    if (mine === generation) setFeed({ data, error: null, loading: false });
  } catch (error) {
    if (mine === generation) setFeed({ error: (error as Error).message, loading: false });
  } finally {
    if (mine === generation) replayBusy("paper", false);
  }
}

/** Mount once: reloads the paper session whenever the day shown changes. */
export function usePaperPolling() {
  const asOf = useAsOfKey();
  useEffect(() => {
    void reloadPaper();
  }, [asOf]);
}

export async function paperTake(body: PaperTakeRequest) {
  await api.paperTake(body);
  await reloadPaper();
}

export async function paperRemove(id: string) {
  await api.paperRemove(id);
  await reloadPaper();
}

export async function newPaperSession() {
  await api.paperSession();
  await reloadPaper();
}
