import type { Drawing } from "@/chart/types";
import { EMPTY_DRAWINGS, getState, setDrawings } from "./store";

// Undo/redo for drawing edits, one stack pair per symbol (drawings are stored
// per symbol, so every chart of that symbol shares the history). All drawing
// edits go through `commitDrawings` so they can be undone.

const LIMIT = 100;
const COALESCE_MS = 1200;

interface History {
  undo: Drawing[][];
  redo: Drawing[][];
  lastKey: string | null;
  lastAt: number;
}

const histories = new Map<string, History>();
const listeners = new Set<() => void>();

function historyFor(symbol: string) {
  let history = histories.get(symbol);
  if (!history) {
    history = { undo: [], redo: [], lastKey: null, lastAt: 0 };
    histories.set(symbol, history);
  }
  return history;
}

function current(symbol: string) {
  return getState().drawings[symbol] ?? EMPTY_DRAWINGS;
}

function notify() {
  for (const listener of listeners) listener();
}

/**
 * Replace a symbol's drawings, recording the previous list for undo. Edits that
 * share a `coalesceKey` within ~1s (e.g. typing into a text drawing) collapse
 * into one undo step.
 */
export function commitDrawings(symbol: string, next: Drawing[], coalesceKey?: string) {
  const previous = current(symbol);
  if (previous === next) return;
  const history = historyFor(symbol);
  const now = Date.now();
  const coalesce = coalesceKey !== undefined && coalesceKey === history.lastKey && now - history.lastAt < COALESCE_MS;
  if (!coalesce) {
    history.undo.push(previous);
    if (history.undo.length > LIMIT) history.undo.shift();
  }
  history.redo = [];
  history.lastKey = coalesceKey ?? null;
  history.lastAt = now;
  setDrawings(symbol, next);
  notify();
}

/** Patch one drawing (properties toolbar). */
export function updateDrawing(symbol: string, id: string, patch: Partial<Drawing>, coalesceKey?: string) {
  const list = current(symbol);
  if (!list.some((drawing) => drawing.id === id)) return;
  commitDrawings(
    symbol,
    list.map((drawing) => (drawing.id === id ? { ...drawing, ...patch } : drawing)),
    coalesceKey,
  );
}

export function undoDrawings(symbol: string): boolean {
  const history = historyFor(symbol);
  const previous = history.undo.pop();
  if (!previous) return false;
  history.redo.push(current(symbol));
  history.lastKey = null;
  setDrawings(symbol, previous);
  notify();
  return true;
}

export function redoDrawings(symbol: string): boolean {
  const history = historyFor(symbol);
  const next = history.redo.pop();
  if (!next) return false;
  history.undo.push(current(symbol));
  history.lastKey = null;
  setDrawings(symbol, next);
  notify();
  return true;
}

export function canUndo(symbol: string) {
  return (histories.get(symbol)?.undo.length ?? 0) > 0;
}

export function canRedo(symbol: string) {
  return (histories.get(symbol)?.redo.length ?? 0) > 0;
}

export function subscribeHistory(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
