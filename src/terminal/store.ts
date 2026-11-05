import { useSyncExternalStore } from "react";
import type { ChartInterval } from "@/core/market/intervals";
import type { ChartType, Drawing, ScaleMode, Tool } from "@/chart/types";
import type { IndicatorConfig } from "@/core/types";
import type { ChartEngine } from "@/chart/engine";
import { INDICATORS, createIndicatorConfig } from "@/core/indicators/indicators";
import { PRESET_MAP, buildIndicators } from "./presets";

// Terminal UI state: a tiny external store (useSyncExternalStore) persisted to
// localStorage. Drawings are keyed by symbol so every chart of that symbol —
// in any layout cell, at any timeframe — shows the same lines.

export type LayoutId = "1" | "2v" | "2h" | "3" | "4";

export const LAYOUTS: Array<{ id: LayoutId; label: string; cells: number }> = [
  { id: "1", label: "Single chart", cells: 1 },
  { id: "2v", label: "2 charts side by side", cells: 2 },
  { id: "2h", label: "2 charts stacked", cells: 2 },
  { id: "3", label: "1 large + 2 small", cells: 3 },
  { id: "4", label: "2 × 2 grid", cells: 4 },
];

export interface CellState {
  symbol: string;
  interval: ChartInterval;
  chartType: ChartType;
  scaleMode: ScaleMode;
  showVolume: boolean;
  indicators: IndicatorConfig[];
}

/** A user-saved snapshot of the chart grid (layout + all 4 cells). Drawings are per symbol and not part of it. */
export interface SavedLayout {
  id: string;
  name: string;
  createdAt: number;
  layout: LayoutId;
  cells: CellState[];
}

export interface ScreenerPrefs {
  open: boolean;
  universe: string;
  /** "all" = every setup merged per stock, else a screen group (btst / swing / positional). */
  group: string;
  screenId: string;
  height: number;
  /** Panel fills the center column (charts hidden), like a maximized bottom panel. */
  maximized: boolean;
  /** Bottom panel tab: the stock screener, the Compare ranking, the day high/low feed, or the strategy backtester. */
  view: "screener" | "compare" | "highlow" | "backtest";
  /** Day high/low feed filters. */
  hl: { kind: "all" | "high" | "low"; segment: "both" | "cash" | "fut"; listOnly: boolean; from930: boolean; latestOnly: boolean };
  showInfo: boolean;
  sector: string;
  minRR: number;
  watchlistOnly: boolean;
  /** Flash live BTST setups (toast, tone, notification) from 3:10 to 3:25 PM. */
  btstAlerts: boolean;
}

export interface WatchList {
  id: string;
  name: string;
  symbols: string[];
}

export type SidePanel = "watchlist" | "movers" | "sectors" | "results" | "alerts";

/** A price alert: fires once when the price crosses `price` in `direction`. */
export interface PriceAlert {
  id: string;
  symbol: string;
  price: number;
  direction: "above" | "below";
  label: string;
  createdAt: number;
  triggeredAt: number | null;
  /** Price that triggered it. */
  triggeredPrice?: number;
}

export type WatchlistSortKey = "manual" | "symbol" | "ltp" | "ch" | "chp";

/** Panel sizes the user dragged (TradingView-style splitters). */
export interface PanelSizes {
  /** Watchlist sidebar width, px. */
  sidebarWidth: number;
  /** Share of the sidebar height given to the symbol list (rest: setup card + details). */
  sidebarSplit: number;
  /** Multi-chart layouts: share of width for the left column, of height for the top row. */
  gridCol: number;
  gridRow: number;
}

export const DEFAULT_SIZES: PanelSizes = { sidebarWidth: 330, sidebarSplit: 0.42, gridCol: 0.5, gridRow: 0.5 };

export interface TerminalState {
  layout: LayoutId;
  activeCell: number;
  cells: CellState[];
  /** Symbols of the open watchlist (kept in sync with `lists`). */
  watchlist: string[];
  lists: WatchList[];
  activeListId: string;
  watchlistSort: { key: WatchlistSortKey; dir: 1 | -1 };
  sizes: PanelSizes;
  tool: Tool;
  magnet: boolean;
  watchlistOpen: boolean;
  /** What the right sidebar shows (the setup card + details stay below it). */
  sidePanel: SidePanel;
  /** Multi-chart layouts: changing the symbol in one chart changes it in all (each keeps its interval). */
  linkSymbols: boolean;
  alerts: PriceAlert[];
  /** The full F&O list has been created and made the default once (never forced again). */
  fnoSeeded: boolean;
  /** Futures-only defaults applied once: screener on the F&O universe, high/low feed on futures. */
  futuresDefaults: boolean;
  drawings: Record<string, Drawing[]>;
  savedLayouts: SavedLayout[];
  screener: ScreenerPrefs;
  /** Preset whose "how to read this layout" card is showing (null = hidden). */
  layoutGuide: string | null;
}

const STORAGE_KEY = "tradex.terminal.v1";
const DEFAULT_SYMBOLS = ["NIFTY", "BANKNIFTY", "RELIANCE", "HDFCBANK"];

function defaultCell(symbol: string, interval: ChartInterval = "15m"): CellState {
  return {
    symbol,
    interval,
    chartType: "candles",
    scaleMode: "linear",
    showVolume: true,
    indicators: [],
  };
}

function defaultState(): TerminalState {
  const first = defaultCell("NIFTY");
  first.indicators = [createIndicatorConfig("ema")];
  const symbols = [...DEFAULT_SYMBOLS, "TCS", "INFY", "ICICIBANK", "SBIN", "BHARTIARTL", "ITC", "LT", "AXISBANK"];
  return {
    layout: "1",
    activeCell: 0,
    cells: [first, defaultCell("BANKNIFTY"), defaultCell("RELIANCE", "1d"), defaultCell("HDFCBANK", "1h")],
    watchlist: symbols,
    lists: [
      { id: "default", name: "Watchlist", symbols },
      { id: "shortlist", name: "Shortlist", symbols: [] },
    ],
    activeListId: "default",
    watchlistSort: { key: "manual", dir: 1 },
    sizes: { ...DEFAULT_SIZES },
    tool: "cursor",
    magnet: false,
    watchlistOpen: true,
    sidePanel: "watchlist",
    linkSymbols: false,
    alerts: [],
    fnoSeeded: false,
    futuresDefaults: true,
    drawings: {},
    savedLayouts: [],
    screener: {
      open: true,
      universe: "fno",
      group: "all",
      screenId: "btst-closing-strength",
      height: 340,
      maximized: false,
      view: "screener",
      hl: { kind: "all", segment: "fut", listOnly: false, from930: true, latestOnly: false },
      showInfo: false,
      sector: "",
      minRR: 0,
      watchlistOnly: false,
      btstAlerts: false,
    },
    layoutGuide: null,
  };
}

const LAYOUT_IDS = new Set<string>(LAYOUTS.map((entry) => entry.id));

function isSavedLayout(value: unknown): value is SavedLayout {
  const entry = value as SavedLayout | null;
  return Boolean(
    entry &&
      typeof entry.id === "string" &&
      typeof entry.name === "string" &&
      LAYOUT_IDS.has(entry.layout) &&
      Array.isArray(entry.cells) &&
      entry.cells.length === 4,
  );
}

/**
 * SMC indicators saved before the clean "present" view existed carry the old,
 * busier settings explicitly; reset those to the current defaults.
 */
function migrateCells(cells: CellState[]): CellState[] {
  return cells.map((cell) => ({
    ...cell,
    indicators: (cell.indicators ?? []).map((indicator) =>
      indicator.type === "smc" && indicator.params?.showHistory === undefined
        ? { ...indicator, params: createIndicatorConfig("smc").params }
        : indicator,
    ),
  }));
}

/** Lists arrived after the single watchlist: wrap an old saved watchlist into the first list. */
function migrateLists(saved: Partial<TerminalState>, fallback: TerminalState): Pick<TerminalState, "lists" | "activeListId" | "watchlist"> {
  const valid = Array.isArray(saved.lists)
    ? saved.lists.filter((list) => list && typeof list.id === "string" && typeof list.name === "string" && Array.isArray(list.symbols))
    : [];
  const lists = valid.length
    ? valid
    : [
        { id: "default", name: "Watchlist", symbols: Array.isArray(saved.watchlist) ? saved.watchlist : fallback.watchlist },
        { id: "shortlist", name: "Shortlist", symbols: [] },
      ];
  const active = lists.find((list) => list.id === saved.activeListId) ?? lists[0];
  return { lists, activeListId: active.id, watchlist: active.symbols };
}

function load(): TerminalState {
  const fallback = defaultState();
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<TerminalState>;
    const cells = migrateCells(
      Array.isArray(saved.cells) && saved.cells.length === 4 ? saved.cells.map((cell, i) => ({ ...fallback.cells[i], ...cell })) : fallback.cells,
    );
    return {
      ...fallback,
      ...saved,
      cells,
      tool: "cursor",
      activeCell: Math.min(Math.max(0, saved.activeCell ?? 0), 3),
      drawings: saved.drawings && typeof saved.drawings === "object" ? saved.drawings : {},
      savedLayouts: Array.isArray(saved.savedLayouts)
        ? saved.savedLayouts.filter(isSavedLayout).map((entry) => ({ ...entry, cells: migrateCells(entry.cells) }))
        : [],
      screener: { ...fallback.screener, ...(saved.screener ?? {}) },
      ...migrateLists(saved, fallback),
      sizes: { ...DEFAULT_SIZES, ...(saved.sizes ?? {}) },
      // Futures-only: move an existing setup to the F&O universe and the futures feed, once.
      ...(saved.futuresDefaults
        ? {}
        : {
            futuresDefaults: true,
            screener: { ...fallback.screener, ...(saved.screener ?? {}), universe: "fno", hl: fallback.screener.hl },
          }),
      alerts: Array.isArray(saved.alerts) ? saved.alerts.filter((alert) => alert && typeof alert.symbol === "string" && alert.price > 0) : [],
    };
  } catch {
    return fallback;
  }
}

let state: TerminalState | null = null;
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function getState(): TerminalState {
  if (!state) state = load();
  return state;
}

function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(getState()));
    } catch {
      // storage full or blocked: the session keeps working, it just won't persist
    }
  }, 300);
}

export function setState(updater: (current: TerminalState) => TerminalState) {
  const next = updater(getState());
  if (next === state) return;
  state = next;
  persist();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Select a slice of terminal state. Selectors must return existing references (no new objects). */
export function useTerminal<T>(selector: (current: TerminalState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(getState()),
    () => selector(getState()),
  );
}

// ------------------------------------------------------------------ actions

export function updateCell(index: number, patch: Partial<CellState>) {
  setState((current) => ({
    ...current,
    cells: current.cells.map((cell, i) => (i === index ? { ...cell, ...patch } : cell)),
  }));
}

export function updateActiveCell(patch: Partial<CellState>) {
  const state = getState();
  updateCell(state.activeCell, patch);
  if (patch.symbol && state.linkSymbols) {
    const symbol = patch.symbol;
    setState((current) => ({ ...current, cells: current.cells.map((cell) => (cell.symbol === symbol ? cell : { ...cell, symbol })) }));
  }
}

// ------------------------------------------------------------------ price alerts

const MAX_ALERTS = 200;

/** Add an alert; the direction comes from where the price is now. Duplicates (same symbol, price, label) are ignored. */
export function addAlert(symbol: string, price: number, currentPrice: number, label: string): PriceAlert | null {
  if (!(price > 0) || !(currentPrice > 0)) return null;
  const alert: PriceAlert = {
    id: `alert-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    symbol,
    price,
    direction: price >= currentPrice ? "above" : "below",
    label: label.trim().slice(0, 60) || `${symbol} ${price >= currentPrice ? "above" : "below"} ${price}`,
    createdAt: Date.now(),
    triggeredAt: null,
  };
  let added: PriceAlert | null = alert;
  setState((current) => {
    if (current.alerts.some((existing) => existing.symbol === symbol && existing.price === price && existing.label === alert.label && !existing.triggeredAt)) {
      added = null;
      return current;
    }
    return { ...current, alerts: [alert, ...current.alerts].slice(0, MAX_ALERTS) };
  });
  return added;
}

export function removeAlert(id: string) {
  setState((current) => ({ ...current, alerts: current.alerts.filter((alert) => alert.id !== id) }));
}

export function triggerAlert(id: string, price: number) {
  setState((current) => ({
    ...current,
    alerts: current.alerts.map((alert) => (alert.id === id && !alert.triggeredAt ? { ...alert, triggeredAt: Date.now(), triggeredPrice: price } : alert)),
  }));
}

/** Re-arm a fired alert; the direction is re-read from the current price. */
export function rearmAlert(id: string, currentPrice: number) {
  setState((current) => ({
    ...current,
    alerts: current.alerts.map((alert) =>
      alert.id === id ? { ...alert, triggeredAt: null, triggeredPrice: undefined, direction: alert.price >= currentPrice ? "above" : "below" } : alert,
    ),
  }));
}

export function clearTriggeredAlerts() {
  setState((current) => ({ ...current, alerts: current.alerts.filter((alert) => !alert.triggeredAt) }));
}

export function toggleLinkSymbols() {
  setState((current) => {
    const linkSymbols = !current.linkSymbols;
    // Linking adopts the active chart's symbol everywhere.
    const symbol = current.cells[current.activeCell].symbol;
    return { ...current, linkSymbols, cells: linkSymbols ? current.cells.map((cell) => ({ ...cell, symbol })) : current.cells };
  });
}

export function setActiveCell(index: number) {
  setState((current) => (current.activeCell === index ? current : { ...current, activeCell: index }));
}

export function setLayout(layout: LayoutId) {
  setState((current) => {
    const cells = LAYOUTS.find((entry) => entry.id === layout)?.cells ?? 1;
    return { ...current, layout, activeCell: Math.min(current.activeCell, cells - 1) };
  });
}

export function setTool(tool: Tool) {
  setState((current) => (current.tool === tool ? current : { ...current, tool }));
}

export function toggleMagnet() {
  setState((current) => ({ ...current, magnet: !current.magnet }));
}

export function toggleWatchlist() {
  setState((current) => ({ ...current, watchlistOpen: !current.watchlistOpen }));
}

export function updateScreener(patch: Partial<ScreenerPrefs>) {
  setState((current) => ({ ...current, screener: { ...current.screener, ...patch } }));
}

/** Change the open list's symbols; `watchlist` and `lists` always move together. */
function updateActiveSymbols(fn: (symbols: string[]) => string[]) {
  setState((current) => {
    const next = fn(current.watchlist);
    if (next === current.watchlist) return current;
    return {
      ...current,
      watchlist: next,
      lists: current.lists.map((list) => (list.id === current.activeListId ? { ...list, symbols: next } : list)),
    };
  });
}

export function addToWatchlist(symbol: string) {
  updateActiveSymbols((symbols) => (symbols.includes(symbol) ? symbols : [...symbols, symbol]));
}

/** Shortlisting = the open watchlist: star a stock to add it, star again to remove it. */
export function toggleShortlist(symbol: string) {
  updateActiveSymbols((symbols) => (symbols.includes(symbol) ? symbols.filter((item) => item !== symbol) : [...symbols, symbol]));
}

export function removeFromWatchlist(symbol: string) {
  updateActiveSymbols((symbols) => symbols.filter((item) => item !== symbol));
}

/** Drag-to-reorder: move `symbol` to `index` in the open list (also switches the list to manual order). */
export function moveInWatchlist(symbol: string, index: number) {
  updateActiveSymbols((symbols) => {
    const from = symbols.indexOf(symbol);
    if (from === -1) return symbols;
    const to = Math.max(0, Math.min(symbols.length - 1, index));
    if (from === to) return symbols;
    const next = symbols.slice();
    next.splice(from, 1);
    next.splice(to, 0, symbol);
    return next;
  });
  setWatchlistSort("manual");
}

export function setWatchlistSort(key: WatchlistSortKey) {
  setState((current) => {
    const { key: currentKey, dir } = current.watchlistSort;
    const next = key === "manual" ? { key, dir: 1 as const } : { key, dir: currentKey === key ? ((dir * -1) as 1 | -1) : key === "symbol" ? 1 : -1 };
    if (next.key === currentKey && next.dir === dir) return current;
    return { ...current, watchlistSort: next };
  });
}

export function switchList(id: string) {
  setState((current) => {
    const list = current.lists.find((entry) => entry.id === id);
    return !list || list.id === current.activeListId ? current : { ...current, activeListId: id, watchlist: list.symbols };
  });
}

export function createList(name: string): string | null {
  const clean = name.trim().slice(0, 40);
  if (!clean) return null;
  const id = `list-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  setState((current) => ({ ...current, lists: [...current.lists, { id, name: clean, symbols: [] }], activeListId: id, watchlist: [] }));
  return id;
}

export function renameList(id: string, name: string) {
  const clean = name.trim().slice(0, 40);
  if (!clean) return;
  setState((current) => ({ ...current, lists: current.lists.map((list) => (list.id === id ? { ...list, name: clean } : list)) }));
}

/** Delete a list (the last one can't be deleted). */
export function deleteList(id: string) {
  setState((current) => {
    if (current.lists.length <= 1) return current;
    const lists = current.lists.filter((list) => list.id !== id);
    if (current.activeListId !== id) return { ...current, lists };
    return { ...current, lists, activeListId: lists[0].id, watchlist: lists[0].symbols };
  });
}

/** Widget bar: open a panel, or close the sidebar when that panel is already showing. */
export function openSidePanel(panel: SidePanel) {
  setState((current) =>
    current.watchlistOpen && current.sidePanel === panel
      ? { ...current, watchlistOpen: false }
      : { ...current, watchlistOpen: true, sidePanel: panel },
  );
}

/** Add a ready-made list (or refresh it if a list with that name exists) and open it. */
export function addPresetList(name: string, symbols: string[]) {
  setState((current) => {
    const existing = current.lists.find((list) => list.name.toLowerCase() === name.toLowerCase());
    const id = existing?.id ?? `list-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const lists = existing
      ? current.lists.map((list) => (list.id === id ? { ...list, symbols } : list))
      : [...current.lists, { id, name, symbols }];
    return { ...current, lists, activeListId: id, watchlist: symbols, watchlistOpen: true, sidePanel: "watchlist" };
  });
}

export function setSizes(patch: Partial<PanelSizes>) {
  setState((current) => ({ ...current, sizes: { ...current.sizes, ...patch } }));
}

export function setDrawings(symbol: string, drawings: Drawing[]) {
  setState((current) => ({ ...current, drawings: { ...current.drawings, [symbol]: drawings } }));
}

export function addIndicator(index: number, type: string) {
  const cell = getState().cells[index];
  updateCell(index, { indicators: [...cell.indicators, createIndicatorConfig(type)] });
}

export function updateIndicator(index: number, id: string, patch: Partial<IndicatorConfig>) {
  const cell = getState().cells[index];
  updateCell(index, {
    indicators: cell.indicators.map((indicator) => (indicator.id === id ? { ...indicator, ...patch } : indicator)),
  });
}

export function removeIndicator(index: number, id: string) {
  const cell = getState().cells[index];
  updateCell(index, { indicators: cell.indicators.filter((indicator) => indicator.id !== id) });
}

// ------------------------------------------------------------------ layouts (presets + saved)

function newIndicatorId(type: string) {
  return `${type}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Deep-copy cells, giving every indicator a fresh id so engines never confuse old and new instances. */
function cloneCells(cells: CellState[]): CellState[] {
  return cells.map((cell) => ({
    ...cell,
    indicators: (Array.isArray(cell.indicators) ? cell.indicators : [])
      .filter((indicator) => Boolean(INDICATORS[indicator.type]))
      .map((indicator) => ({
      ...indicator,
      id: newIndicatorId(indicator.type),
      params: { ...indicator.params },
      colors: { ...indicator.colors },
    })),
  }));
}

/** Apply a built-in preset. Cells without a fixed symbol keep the active chart's symbol. */
export function applyPreset(id: string): boolean {
  const preset = PRESET_MAP[id];
  if (!preset) return false;
  setState((current) => {
    const symbol = current.cells[current.activeCell]?.symbol ?? current.cells[0].symbol;
    const cells = current.cells.map((cell, i) => {
      const spec = preset.cells[i];
      if (!spec) return cell;
      return {
        ...cell,
        symbol: spec.symbol ?? symbol,
        interval: spec.interval,
        chartType: spec.chartType ?? "candles",
        scaleMode: spec.scaleMode ?? "linear",
        showVolume: spec.showVolume ?? true,
        indicators: buildIndicators(spec.indicators),
      };
    });
    return { ...current, layout: preset.layout, activeCell: 0, cells, layoutGuide: preset.steps?.length ? preset.id : null };
  });
  return true;
}

export function setLayoutGuide(presetId: string | null) {
  setState((current) => (current.layoutGuide === presetId ? current : { ...current, layoutGuide: presetId }));
}

/** Save the current grid under a name. Saving with an existing name (case-insensitive) overwrites it. */
export function saveCurrentLayout(name: string): SavedLayout | null {
  const clean = name.trim().slice(0, 60);
  if (!clean) return null;
  const current = getState();
  const existing = current.savedLayouts.find((entry) => entry.name.toLowerCase() === clean.toLowerCase());
  const entry: SavedLayout = {
    id: existing?.id ?? `layout-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: clean,
    createdAt: Date.now(),
    layout: current.layout,
    cells: cloneCells(current.cells),
  };
  setState((state) => ({
    ...state,
    savedLayouts: existing
      ? state.savedLayouts.map((item) => (item.id === existing.id ? entry : item))
      : [...state.savedLayouts, entry],
  }));
  return entry;
}

export function applySavedLayout(id: string): boolean {
  const saved = getState().savedLayouts.find((entry) => entry.id === id);
  if (!saved) return false;
  setState((current) => ({
    ...current,
    layout: saved.layout,
    activeCell: 0,
    cells: cloneCells(saved.cells.map((cell, i) => ({ ...current.cells[i], ...cell }))),
    layoutGuide: null,
  }));
  return true;
}

export function renameSavedLayout(id: string, name: string): boolean {
  const clean = name.trim().slice(0, 60);
  if (!clean) return false;
  setState((current) => ({
    ...current,
    savedLayouts: current.savedLayouts.map((entry) => (entry.id === id ? { ...entry, name: clean } : entry)),
  }));
  return true;
}

export function deleteSavedLayout(id: string) {
  setState((current) => ({ ...current, savedLayouts: current.savedLayouts.filter((entry) => entry.id !== id) }));
}

/** Reset the chart grid (layout, symbols, intervals, indicators). Watchlist, drawings and saved layouts stay. */
export function resetWorkspace() {
  const fresh = defaultState();
  setState((current) => ({ ...current, layout: fresh.layout, activeCell: 0, cells: fresh.cells, layoutGuide: null }));
}

// ------------------------------------------------------------------ engine registry

// Keyboard shortcuts (Delete, Escape) target the active cell's engine.
export const engines = new Map<number, ChartEngine>();

export const EMPTY_DRAWINGS: Drawing[] = [];
