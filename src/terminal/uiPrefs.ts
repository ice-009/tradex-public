import { useSyncExternalStore } from "react";
import type { Tool } from "@/chart/types";

// Small UI-preference store for the drawing/chart chrome (kept apart from the
// terminal store): hide-all-drawings, crosshair sync, and the tool last used in
// each left-toolbar flyout group. Persisted to localStorage.

export interface UIPrefs {
  hideDrawings: boolean;
  syncCrosshair: boolean;
  groupTools: Record<string, Tool>;
  /** Draw the screener's entry/stop/target zones on charts of stocks with a setup. */
  showPlans: boolean;
  /** Draw automatic chart patterns + S/R zones on every chart. */
  autoPatterns: boolean;
  /** Position sizing (setup card): trading capital in ₹ and the most one trade may lose, % of capital. */
  capital: number;
  riskPct: number;
}

const STORAGE_KEY = "tradex.uiprefs.v1";
const DEFAULTS: UIPrefs = { hideDrawings: false, syncCrosshair: true, groupTools: {}, showPlans: true, autoPatterns: true, capital: 500_000, riskPct: 1 };

let prefs: UIPrefs | null = null;
const listeners = new Set<() => void>();

function load(): UIPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const saved = JSON.parse(raw) as Partial<UIPrefs>;
    return { ...DEFAULTS, ...saved, groupTools: { ...(saved.groupTools ?? {}) } };
  } catch {
    return DEFAULTS;
  }
}

export function getPrefs(): UIPrefs {
  if (!prefs) prefs = load();
  return prefs;
}

function setPrefs(updater: (current: UIPrefs) => UIPrefs) {
  const next = updater(getPrefs());
  if (next === prefs) return;
  prefs = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: prefs still apply for this session
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePrefs<T>(selector: (current: UIPrefs) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(getPrefs()),
    () => selector(DEFAULTS),
  );
}

export function setHideDrawings(hide: boolean) {
  setPrefs((current) => (current.hideDrawings === hide ? current : { ...current, hideDrawings: hide }));
}

export function toggleSyncCrosshair() {
  setPrefs((current) => ({ ...current, syncCrosshair: !current.syncCrosshair }));
}

export function setGroupTool(group: string, tool: Tool) {
  setPrefs((current) =>
    current.groupTools[group] === tool ? current : { ...current, groupTools: { ...current.groupTools, [group]: tool } },
  );
}

export function toggleShowPlans() {
  setPrefs((current) => ({ ...current, showPlans: !current.showPlans }));
}

export function setSizing(patch: Partial<Pick<UIPrefs, "capital" | "riskPct">>) {
  setPrefs((current) => ({ ...current, ...patch }));
}

export function toggleAutoPatterns() {
  setPrefs((current) => ({ ...current, autoPatterns: !current.autoPatterns }));
}
