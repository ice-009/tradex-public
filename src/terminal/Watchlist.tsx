"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatCompact, formatPrice } from "@/core/format";
import { fetchQuotes, getSymbolInfo, liveHub, type Quote, type SymbolInfo } from "@/client/marketData";
import {
  DEFAULT_SIZES,
  addPresetList,
  createList,
  deleteList,
  moveInWatchlist,
  removeFromWatchlist,
  renameList,
  setSizes,
  setWatchlistSort,
  switchList,
  toggleWatchlist,
  updateActiveCell,
  useTerminal,
  type WatchlistSortKey,
} from "./store";
import { Splitter } from "./Splitter";
import { MarketPanel } from "./MarketPanel";
import { AlertsPanel } from "./Alerts";
import type { PresetList } from "@/contracts/api";
import { api } from "@/client/api";
import { Icons } from "./icons";
import { useTerminalUI } from "./ui";
import { SetupCard } from "./SetupCard";
import { useScreenerFeed } from "@/client/screenerFeed";

interface QuoteState extends Quote {
  dir: "up" | "down" | null;
  seq: number;
}

const QUOTE_REFRESH_MS = 60_000;
/**
 * Big lists (the F&O list is ~220) refresh snapshots more often, since only visible rows stream.
 * This costs no extra broker calls: the server answers from its quote cache (the high/low sweep
 * refreshes every F&O stock) and only re-fetches quotes older than its refresh tolerance.
 */
const BIG_LIST = 40;
const BIG_LIST_REFRESH_MS = 20_000;

/**
 * Snapshot quotes for every symbol, refreshed on a timer. Live ticks are added separately with
 * useLiveTicks for the rows on screen: Fyers' data socket carries 100 symbols on the Standard plan
 * (open charts get first claim), and the F&O list alone is ~220.
 */
function useQuotes(symbols: string[]) {
  const [quotes, setQuotes] = useState<Record<string, QuoteState>>({});
  const pending = useRef(new Map<string, Quote>());
  const frame = useRef(0);
  const key = symbols.join(",");

  const flush = useCallback(() => {
    frame.current = 0;
    const batch = pending.current;
    pending.current = new Map();
    setQuotes((current) => {
      const next = { ...current };
      for (const [symbol, quote] of batch) {
        const previous = current[symbol];
        const dir = previous && quote.ltp !== previous.ltp ? (quote.ltp > previous.ltp ? "up" : "down") : previous?.dir ?? null;
        next[symbol] = { ...quote, dir, seq: (previous?.seq ?? 0) + (previous && quote.ltp !== previous.ltp ? 1 : 0) };
      }
      return next;
    });
  }, []);
  /** Batch quotes into one state update per animation frame. */
  const queue = useCallback(
    (quote: Quote) => {
      pending.current.set(quote.symbol, quote);
      if (!frame.current) frame.current = requestAnimationFrame(flush);
    },
    [flush],
  );

  useEffect(() => {
    const list = key ? key.split(",") : [];
    let cancelled = false;
    const refresh = () =>
      fetchQuotes(list).then((items) => {
        if (!cancelled) items.forEach(queue);
      });
    void refresh();
    const timer = setInterval(refresh, list.length > BIG_LIST ? BIG_LIST_REFRESH_MS : QUOTE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key, queue]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return { quotes, queue };
}

/** Tick-by-tick updates for a subset of symbols (the rows on screen + the charted symbol). */
function useLiveTicks(symbols: string[], queue: (quote: Quote) => void) {
  const key = symbols.join(",");
  useEffect(() => {
    const list = key ? key.split(",") : [];
    // List order is streaming priority: the top rows stream, the rest refresh by polling.
    const unsubscribers = list.map((symbol, index) => liveHub.subscribe(symbol, queue, 2 + index / 10_000));
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [key, queue]);
}

const SORT_COLUMNS: Array<{ key: WatchlistSortKey; label: string }> = [
  { key: "symbol", label: "Symbol" },
  { key: "ltp", label: "Last" },
  { key: "ch", label: "Chg" },
  { key: "chp", label: "Chg%" },
];
const PANEL_TITLE = { movers: "Market movers", sectors: "Sectors", results: "Results calendar", alerts: "Price alerts" } as const;
const MIN_SIDEBAR = 260;
const MAX_SIDEBAR = 620;
const ROW_HEIGHT_FALLBACK = 32;

export function Watchlist() {
  const watchlist = useTerminal((state) => state.watchlist);
  const sort = useTerminal((state) => state.watchlistSort);
  const sizes = useTerminal((state) => state.sizes);
  const panel = useTerminal((state) => state.sidePanel);
  const activeSymbol = useTerminal((state) => state.cells[state.activeCell].symbol);
  const ui = useTerminalUI();
  const symbols = useMemo(
    () => (watchlist.includes(activeSymbol) ? watchlist : [...watchlist, activeSymbol]),
    [watchlist, activeSymbol],
  );
  const asideRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Which rows are on screen (± a few), so only those stream live ticks.
  const [visibleRange, setVisibleRange] = useState<[number, number]>([0, 30]);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let frameId = 0;
    const measure = () => {
      frameId = 0;
      const rowHeight = (list.querySelector(".tx-wl-row") as HTMLElement | null)?.offsetHeight ?? ROW_HEIGHT_FALLBACK;
      const first = Math.max(0, Math.floor(list.scrollTop / rowHeight) - 5);
      const last = Math.ceil((list.scrollTop + list.clientHeight) / rowHeight) + 5;
      setVisibleRange((current) => (current[0] === first && current[1] === last ? current : [first, last]));
    };
    const onScroll = () => {
      if (!frameId) frameId = requestAnimationFrame(measure);
    };
    measure();
    list.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(onScroll);
    observer.observe(list);
    return () => {
      list.removeEventListener("scroll", onScroll);
      observer.disconnect();
      cancelAnimationFrame(frameId);
    };
  }, [panel]);
  const { quotes, queue } = useQuotes(symbols);
  const ideas = useScreenerFeed((feed) => feed.ideas);
  const resizeStart = useRef({ width: sizes.sidebarWidth, split: sizes.sidebarSplit, height: 1 });
  const [drag, setDrag] = useState<{ symbol: string; index: number } | null>(null);

  const rows = useMemo(() => {
    const key = sort.key;
    if (key === "manual") return watchlist;
    const value = (symbol: string): number | string => {
      if (key === "symbol") return symbol;
      const quote = quotes[symbol];
      return quote ? quote[key] : -Infinity;
    };
    return [...watchlist].sort((a, b) => {
      const left = value(a);
      const right = value(b);
      return (left < right ? -1 : left > right ? 1 : 0) * sort.dir;
    });
  }, [watchlist, sort, quotes]);

  // Stream only what's on screen, in display (sorted) order, plus the charted symbol.
  const liveSymbols = useMemo(() => [...new Set([activeSymbol, ...rows.slice(visibleRange[0], visibleRange[1])])], [activeSymbol, rows, visibleRange]);
  useLiveTicks(liveSymbols, queue);

  // Header click: sort descending (A→Z for Symbol), then ascending, then back to your own order.
  const onSort = (key: WatchlistSortKey) => {
    const flipped = key === "symbol" ? -1 : 1;
    if (sort.key === key && sort.dir === flipped) setWatchlistSort("manual");
    else setWatchlistSort(key);
  };

  // Drag a row's grip to reorder (pointer events: mouse, trackpad and touch).
  const indexAt = (clientY: number) => {
    const list = listRef.current;
    if (!list) return 0;
    const rowHeight = (list.querySelector(".tx-wl-row") as HTMLElement | null)?.offsetHeight ?? ROW_HEIGHT_FALLBACK;
    const y = clientY - list.getBoundingClientRect().top + list.scrollTop;
    return Math.max(0, Math.min(watchlist.length - 1, Math.floor(y / rowHeight)));
  };

  return (
    <aside ref={asideRef} className="tx-side" style={{ width: sizes.sidebarWidth }}>
      <Splitter
        axis="x"
        label="Resize watchlist"
        className="tx-side-split"
        onStart={() => (resizeStart.current = { ...resizeStart.current, width: sizes.sidebarWidth })}
        onDrag={(dx) =>
          setSizes({ sidebarWidth: Math.round(Math.min(MAX_SIDEBAR, window.innerWidth * 0.5, Math.max(MIN_SIDEBAR, resizeStart.current.width - dx))) })
        }
        onReset={() => setSizes({ sidebarWidth: DEFAULT_SIZES.sidebarWidth })}
      />
      <div className="tx-side-head">
        {panel === "watchlist" ? <ListMenu /> : <span className="tx-side-title tx-panel-title">{PANEL_TITLE[panel]}</span>}
        {panel === "watchlist" && Object.values(quotes).some((quote) => quote.delayed) && (
          <span className="tx-tag tx-eod-tag" title="Live feed offline: prices are the last end-of-day close">
            EOD
          </span>
        )}
        {panel === "watchlist" && (
          <button type="button" className="tx-icon-btn" title="Add symbol" onClick={() => ui.openSearch({ mode: "watchlist" })}>
            <Icons.plus size={16} />
          </button>
        )}
        <button type="button" className="tx-icon-btn tx-side-close" title="Close panel" onClick={toggleWatchlist}>
          <Icons.x size={16} />
        </button>
      </div>
      {panel === "watchlist" ? (
        <>
      <div className="tx-wl-cols" role="row">
        {SORT_COLUMNS.map((column) => (
          <button
            type="button"
            key={column.key}
            className={`tx-wl-sort ${sort.key === column.key ? "is-active" : ""}`}
            onClick={() => onSort(column.key)}
            title={`Sort by ${column.label}`}
          >
            {column.label}
            {sort.key === column.key && <span className="tx-wl-sort-dir">{sort.dir === 1 ? "▲" : "▼"}</span>}
          </button>
        ))}
      </div>
      <div className={`tx-wl-list ${drag ? "is-dragging" : ""}`} ref={listRef}>
        {rows.map((symbol, rowIndex) => {
          const quote = quotes[symbol];
          const tone = quote ? (quote.ch >= 0 ? "is-up" : "is-down") : "";
          const idea = ideas.get(symbol);
          const eod = Boolean(quote?.delayed);
          return (
            <div
              key={symbol}
              role="button"
              tabIndex={0}
              className={`tx-wl-row ${symbol === activeSymbol ? "is-active" : ""} ${drag?.symbol === symbol ? "is-lifted" : ""} ${
                drag && drag.symbol !== symbol && drag.index === rowIndex ? "is-drop" : ""
              }`}
              onClick={() => updateActiveCell({ symbol })}
              onKeyDown={(event) => event.key === "Enter" && updateActiveCell({ symbol })}
            >
              <span className="tx-wl-symbol">
                {sort.key === "manual" && watchlist.length > 1 && (
                  <span
                    className="tx-wl-grip"
                    aria-label={`Reorder ${symbol}`}
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
                      setDrag({ symbol, index: rowIndex });
                    }}
                    onPointerMove={(event) => drag && setDrag({ symbol, index: indexAt(event.clientY) })}
                    onPointerUp={() => {
                      if (drag) moveInWatchlist(symbol, drag.index);
                      setDrag(null);
                    }}
                    onPointerCancel={() => setDrag(null)}
                  >
                    <Icons.grip size={14} />
                  </span>
                )}
                <SymbolLogo symbol={symbol} />
                <span className="tx-wl-symbol-text">{symbol}</span>
                {idea && (
                  <span
                    className={`tx-wl-setup tx-hz-${idea.best.screen.group}`}
                    title={`Screener setups: ${idea.hits.map((hit) => hit.screen.name).join(", ")}`}
                  >
                    {idea.hits.length}
                  </span>
                )}
              </span>
              <span
                key={quote?.seq ?? 0}
                className={`tx-wl-num ${eod ? "is-eod" : ""} ${quote?.seq && quote.dir ? (quote.dir === "up" ? "flash-up" : "flash-down") : ""}`}
                title={eod ? "Last end-of-day close (live feed offline)" : undefined}
              >
                {quote ? formatPrice(quote.ltp) : "—"}
              </span>
              <span className={`tx-wl-num ${tone}`}>{quote ? `${quote.ch >= 0 ? "+" : ""}${formatPrice(quote.ch)}` : ""}</span>
              <span className={`tx-wl-num ${tone}`}>{quote ? `${quote.chp >= 0 ? "+" : ""}${quote.chp.toFixed(2)}%` : ""}</span>
              <button
                type="button"
                className="tx-wl-remove"
                title="Remove from this list"
                onClick={(event) => {
                  event.stopPropagation();
                  removeFromWatchlist(symbol);
                }}
              >
                <Icons.x size={13} />
              </button>
            </div>
          );
        })}
        {!watchlist.length && (
          <div className="tx-empty">
            This list is empty.
            <br />
            Tap ★ in the screener or + above to add stocks.
          </div>
        )}
      </div>
        </>
      ) : (
        panel === "alerts" ? <AlertsPanel /> : <MarketPanel panel={panel} />
      )}
      <Splitter
        axis="y"
        label="Resize list and setup panel"
        className="tx-side-hsplit"
        onStart={() => (resizeStart.current = { ...resizeStart.current, split: sizes.sidebarSplit, height: asideRef.current?.offsetHeight ?? 1 })}
        onDrag={(dy) => setSizes({ sidebarSplit: Math.min(0.85, Math.max(0.15, resizeStart.current.split + dy / resizeStart.current.height)) })}
        onReset={() => setSizes({ sidebarSplit: DEFAULT_SIZES.sidebarSplit })}
      />
      <div className="tx-side-bottom" style={{ flexBasis: `${(1 - sizes.sidebarSplit) * 100}%` }}>
        <SetupCard key={activeSymbol} symbol={activeSymbol} />
        <SymbolDetails symbol={activeSymbol} quote={quotes[activeSymbol]} />
      </div>
    </aside>
  );
}

/** List switcher in the sidebar header: switch, create, rename, delete. */
function ListMenu() {
  const lists = useTerminal((state) => state.lists);
  const activeId = useTerminal((state) => state.activeListId);
  const active = lists.find((list) => list.id === activeId) ?? lists[0];
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<"new" | "rename" | null>(null);
  const [name, setName] = useState("");
  const [presets, setPresets] = useState<PresetList[] | null>(null);
  const [showPresets, setShowPresets] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const openPresets = () => {
    setShowPresets((value) => !value);
    if (presets) return;
    api
      .presets()
      .then(setPresets)
      .catch(() => setPresets([]));
  };

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const submit = () => {
    if (editing === "new") createList(name);
    else if (editing === "rename") renameList(active.id, name);
    setEditing(null);
    setName("");
    setOpen(false);
  };

  return (
    <div className="tx-side-title tx-dropdown" ref={ref}>
      <button type="button" className="tx-list-btn" onClick={() => setOpen((value) => !value)} title="Switch list">
        <span>{active.name}</span>
        <Icons.chevronDown size={14} />
      </button>
      {open && (
        <div className="tx-menu tx-menu-left tx-list-menu">
          {lists.map((list) => (
            <button
              type="button"
              key={list.id}
              className={`tx-menu-item ${list.id === active.id ? "is-active" : ""}`}
              onClick={() => {
                switchList(list.id);
                setOpen(false);
              }}
            >
              <span className="tx-check">{list.id === active.id && <Icons.check size={14} />}</span>
              <span className="tx-list-name">{list.name}</span>
              <span className="tx-list-count">{list.symbols.length}</span>
            </button>
          ))}
          <div className="tx-menu-sep" />
          <button type="button" className="tx-menu-item" onClick={openPresets} aria-expanded={showPresets}>
            <Icons.list size={15} /> Ready-made lists
            <span className="tx-list-count"><Icons.chevronDown size={12} style={showPresets ? undefined : { transform: "rotate(-90deg)" }} /></span>
          </button>
          {showPresets && (
            <div className="tx-preset-lists">
              {!presets && <div className="tx-menu-note">Loading…</div>}
              {presets?.map((preset) => {
                const added = lists.some((list) => list.name.toLowerCase() === preset.name.toLowerCase());
                return (
                  <button
                    type="button"
                    key={preset.id}
                    className="tx-menu-item tx-preset-item"
                    title={preset.symbols.join(", ")}
                    onClick={() => {
                      addPresetList(preset.name, preset.symbols);
                      setOpen(false);
                    }}
                  >
                    <span className={`tx-preset-kind is-${preset.group}`}>{preset.group === "fno-sector" ? "F&O" : preset.group === "index" ? "IDX" : <Icons.star size={10} filled />}</span>
                    <span className="tx-list-name">{preset.name.replace(/^F&O · /, "")}</span>
                    <span className="tx-list-count">{added && <Icons.check size={12} />}{preset.symbols.length}</span>
                  </button>
                );
              })}
              {presets && presets.some((preset) => preset.group === "fno-sector") && (
                <button
                  type="button"
                  className="tx-menu-item tx-preset-all"
                  onClick={() => {
                    presets.filter((preset) => preset.group === "fno-sector").forEach((preset) => addPresetList(preset.name, preset.symbols));
                    setOpen(false);
                  }}
                >
                  <Icons.plus size={15} /> Add every F&O sector list
                </button>
              )}
            </div>
          )}
          <div className="tx-menu-sep" />
          {editing ? (
            <form
              className="tx-list-form"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <input
                className="tx-input"
                autoFocus
                value={name}
                maxLength={40}
                placeholder={editing === "new" ? "New list name" : "List name"}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => event.key === "Escape" && setEditing(null)}
              />
              <button type="submit" className="tx-btn-small" disabled={!name.trim()}>
                {editing === "new" ? "Create" : "Save"}
              </button>
            </form>
          ) : (
            <>
              <button type="button" className="tx-menu-item" onClick={() => setEditing("new")}>
                <Icons.plus size={15} /> New list
              </button>
              <button
                type="button"
                className="tx-menu-item"
                onClick={() => {
                  setName(active.name);
                  setEditing("rename");
                }}
              >
                <Icons.text size={15} /> Rename “{active.name}”
              </button>
              {lists.length > 1 && (
                <button
                  type="button"
                  className="tx-menu-item tx-menu-danger"
                  onClick={() => {
                    if (window.confirm(`Delete the list “${active.name}”? Its ${active.symbols.length} symbols will be removed from it.`)) deleteList(active.id);
                    setOpen(false);
                  }}
                >
                  <Icons.trash size={15} /> Delete list
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SymbolDetails({ symbol, quote }: { symbol: string; quote?: Quote }) {
  const [info, setInfo] = useState<SymbolInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSymbolInfo(symbol)
      .then((result) => !cancelled && setInfo(result))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const tone = quote ? (quote.ch >= 0 ? "is-up" : "is-down") : "";
  const rangePct =
    quote && quote.high > quote.low ? Math.min(100, Math.max(0, ((quote.ltp - quote.low) / (quote.high - quote.low)) * 100)) : null;

  return (
    <div className="tx-details">
      <div className="tx-details-symbol">
        {symbol}
        <span className="tx-tag">{info?.type ?? "stock"}</span>
      </div>
      <div className="tx-details-name">{info?.name && info.symbol === symbol ? info.name : " "}</div>
      <div className="tx-details-price">
        <span className="tx-details-ltp">{quote ? formatPrice(quote.ltp) : "—"}</span>
        {quote && (
          <span className={`tx-details-chg ${tone}`}>
            {quote.ch >= 0 ? "+" : ""}
            {formatPrice(quote.ch)} ({quote.chp >= 0 ? "+" : ""}
            {quote.chp.toFixed(2)}%)
          </span>
        )}
      </div>
      {quote && (
        <>
          <div className="tx-range">
            <div className="tx-range-labels">
              <span>{formatPrice(quote.low)}</span>
              <span>Day range</span>
              <span>{formatPrice(quote.high)}</span>
            </div>
            <div className="tx-range-track">
              {rangePct !== null && <div className="tx-range-marker" style={{ left: `${rangePct}%` }} />}
            </div>
          </div>
          <dl className="tx-stats">
            <div><dt>Open</dt><dd>{formatPrice(quote.open)}</dd></div>
            <div><dt>Prev</dt><dd>{formatPrice(quote.prevClose)}</dd></div>
            <div><dt>High</dt><dd>{formatPrice(quote.high)}</dd></div>
            <div><dt>Low</dt><dd>{formatPrice(quote.low)}</dd></div>
            <div><dt>Volume</dt><dd>{quote.volume > 0 ? formatCompact(quote.volume) : "—"}</dd></div>
          </dl>
        </>
      )}
    </div>
  );
}

// Muted, low-chroma tints: they tell symbols apart without competing with the red / green P&L colours.
const LOGO_COLORS = ["#2d3b57", "#2b4747", "#4a3d2c", "#3e3352", "#2c4252", "#4a3240", "#38452f", "#45392f", "#33394a", "#3d4048"];

/** A letter "logo" in a stable color per symbol (no third-party logos). */
export function SymbolLogo({ symbol }: { symbol: string }) {
  let hash = 0;
  for (const char of symbol) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (
    <span className="tx-logo" style={{ background: LOGO_COLORS[hash % LOGO_COLORS.length] }} aria-hidden>
      {symbol.slice(0, 1)}
    </span>
  );
}
