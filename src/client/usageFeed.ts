import { useSyncExternalStore } from "react";
import type { ApiUsageResponse, HubHealth } from "@/contracts/api";
import { api } from "@/client/api";

// The Market Data Hub's health and broker budget (/api/broker/usage), polled
// once a minute while anything shows it (the top bar's meter, the "Connect a
// Market Data Hub" banner) and shared between them.

const EVERY_MS = 60_000;

let usage: ApiUsageResponse | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function load() {
  api
    .usage()
    .then((value) => {
      usage = value;
      listeners.forEach((listener) => listener());
    })
    .catch(() => {});
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    load();
    timer = setInterval(load, EVERY_MS);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The hub's broker budget and health (null until the first answer). */
export function useApiUsage(): ApiUsageResponse | null {
  return useSyncExternalStore(subscribe, () => usage, () => null);
}

/** The hub's health (null until the first answer). */
export function useHubHealth(): HubHealth | null {
  return useApiUsage()?.hub ?? null;
}

/** Ask again now (e.g. after the person fixed the hub settings). */
export const refreshUsage = load;
