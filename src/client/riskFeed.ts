import { useEffect, useSyncExternalStore } from "react";
import type { RiskReturnsResponse } from "@/contracts/api";
import { api } from "@/client/api";
import { useAsOfKey } from "@/client/timeMachine";

// Daily returns for the plan's risk model (issue #40): the open trades' and
// the plan's ideas', from /api/plan/returns (the Time Machine's day is added
// by api.ts). They change once a day, so an answer is kept per set of stocks
// and re-read only after a while; a past day being read from the hub is
// polled until it is ready. While a new set loads, the last answer for the
// same day stands in (stocks it lacks fall back to their industry).

const REFRESH_MS = 30 * 60 * 1000;
const SYNCING_POLL_MS = 2_000;
const ERROR_RETRY_MS = 60_000;
const MAX_KEPT = 8;

interface Entry {
  data: RiskReturnsResponse | null;
  at: number;
  loading: boolean;
}

const entries = new Map<string, Entry>();
/** Per day ("" live): the newest ready answer, shown while another set loads. */
const lastReady = new Map<string, RiskReturnsResponse>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const keyFor = (day: string, symbols: readonly string[]) => `${day}|${[...new Set(symbols)].sort().join(",")}`;

async function load(key: string, day: string, symbols: string[]) {
  const entry = entries.get(key) ?? { data: null, at: 0, loading: false };
  if (entry.loading) return;
  entries.set(key, { ...entry, loading: true });
  let data: RiskReturnsResponse;
  try {
    data = await api.riskReturns(symbols);
  } catch (error) {
    data = { status: "error", error: (error as Error).message };
  }
  // A failed refresh keeps the answer already shown.
  const keep = data.status !== "ready" && entry.data?.status === "ready";
  entries.set(key, { data: keep ? entry.data : data, at: Date.now(), loading: false });
  if (data.status === "ready") lastReady.set(day, data);
  while (entries.size > MAX_KEPT) entries.delete(entries.keys().next().value!);
  notify();
}

/** The returns of `symbols` (null before the first answer). */
export function useRiskReturns(symbols: readonly string[]): RiskReturnsResponse | null {
  const day = useAsOfKey();
  const sorted = [...new Set(symbols)].sort();
  const key = keyFor(day, sorted);
  const list = sorted.join(",");
  useEffect(() => {
    if (!list) return;
    const wanted = list.split(",");
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const tick = async () => {
      const entry = entries.get(key);
      const age = entry ? Date.now() - entry.at : Infinity;
      const status = entry?.data?.status;
      const due = !entry?.data || (status === "syncing" ? age >= SYNCING_POLL_MS : status === "error" ? age >= ERROR_RETRY_MS : age >= REFRESH_MS);
      if (due) await load(key, day, wanted);
      if (cancelled) return;
      const next = entries.get(key)?.data?.status;
      timer = setTimeout(tick, next === "syncing" ? SYNCING_POLL_MS : next === "error" ? ERROR_RETRY_MS : REFRESH_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key, day, list]);
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!list) return null;
      const data = entries.get(key)?.data;
      return data?.status === "ready" ? data : (lastReady.get(day) ?? data ?? null);
    },
    () => null,
  );
}
