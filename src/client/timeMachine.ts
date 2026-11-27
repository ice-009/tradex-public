import { useSyncExternalStore } from "react";
import type { TimeMachineResponse } from "@/contracts/api";

// The Time Machine's state in the browser (issue #31): which past day the
// terminal is shown as of, or null for the live terminal. It lives in the URL
// (`/?asOf=2020-03-23`), so a link opens the same day.
//
// The browser never decides what was known on that day: every data request
// carries `asOf` (src/client/api.ts adds it) and the server answers as of that
// day's close. While it is set, the live price stream is off (marketData.ts)
// and everything live-only — the order ticket, alerts, the journal, the Day
// High/Low scan — is switched off or labelled.
//
// Replay controls (#32) will move the day with `setAsOf`; every feed already
// refetches when it changes.

export type PastInfo = Extract<TimeMachineResponse, { status: "past" }>;

export interface TimeMachineState {
  /** The day asked for (YYYY-MM-DD, as in the URL); null = live. */
  asOf: string | null;
  /** The server's answer for it: the session shown and what was known (null while it loads, or live). */
  info: PastInfo | null;
  /** Why the day couldn't be used (a bad date). */
  error: string | null;
}

const PARAM = "asOf";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function fromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get(PARAM)?.trim() ?? "";
  return DATE.test(value) ? value : null;
}

let state: TimeMachineState = { asOf: fromUrl(), info: null, error: null };
const listeners = new Set<() => void>();

function set(next: TimeMachineState) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (typeof window !== "undefined") {
  // Back / forward between days.
  window.addEventListener("popstate", () => {
    const asOf = fromUrl();
    if (asOf !== state.asOf) set({ asOf, info: null, error: null });
  });
}

export function timeMachine(): TimeMachineState {
  return state;
}

/** The `asOf` request parameter: the day asked for, or undefined live. */
export function asOfParam(): string | undefined {
  return state.asOf ?? undefined;
}

/** True while the terminal shows a past day. */
export const inTimeMachine = () => state.asOf !== null;

/** The day the terminal shows (day key), or null live: the server's session once known, else the day asked for. */
export function timeMachineDay(): number | null {
  if (!state.asOf) return null;
  return state.info?.day ?? Date.parse(`${state.asOf}T00:00:00Z`);
}

/** Select from the state (selectors must return existing values). */
export function useTimeMachine<T>(selector: (current: TimeMachineState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector({ asOf: null, info: null, error: null }),
  );
}

/** The day asked for ("" live): a dependency for effects that load data, so they reload when the day changes. */
export const useAsOfKey = () => useTimeMachine((current) => current.asOf ?? "");

/** Subscribe outside React (the live stream pauses while a past day is shown). */
export const onTimeMachineChange = subscribe;

/** Show the terminal as of `date` (YYYY-MM-DD), or live (null). Updates the URL; every feed reloads. */
export function setAsOf(date: string | null) {
  const asOf = date && DATE.test(date) ? date : null;
  if (asOf === state.asOf) return;
  if (typeof window !== "undefined") {
    const url = new URL(window.location.href);
    if (asOf) url.searchParams.set(PARAM, asOf);
    else url.searchParams.delete(PARAM);
    window.history.pushState(null, "", url);
  }
  set({ asOf, info: null, error: null });
}

/** The server's answer for the day asked for (called by the banner once it has it). */
export function resolvedTimeMachine(asOf: string, answer: TimeMachineResponse | { status: "error"; error: string }) {
  if (asOf !== state.asOf) return; // the day changed meanwhile
  if (answer.status === "live") setAsOf(null);
  else if (answer.status === "error") set({ ...state, info: null, error: answer.error });
  else set({ ...state, info: answer, error: null });
}
