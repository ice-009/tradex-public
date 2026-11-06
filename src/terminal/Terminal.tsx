"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import type { Tool } from "@/chart/types";
import { ChartCell } from "./ChartCell";
import { DrawingToolbar } from "./DrawingToolbar";
import { IndicatorsDialog } from "./IndicatorsDialog";
import { LayoutNameDialog, LayoutToast, type LayoutDialogState } from "./LayoutsMenu";
import { SymbolSearch } from "./SymbolSearch";
import { TopBar } from "./TopBar";
import { ScreenerPanel } from "./ScreenerPanel";
import { ComparePanel } from "./ComparePanel";
import { AlertWatcher } from "./Alerts";
import { BtstAlertWatcher } from "./ScreenerAlerts";
import { HighLowPanel } from "./HighLowPanel";
import { BacktestPanel } from "./BacktestPanel";
import { PlanPanel } from "./PlanPanel";
import { usePlanPolling } from "@/client/planFeed";
import { useHighLowPolling } from "@/client/highLowFeed";
import { SmcGuide } from "./SmcGuide";
import { LayoutGuide } from "./LayoutGuide";
import { Watchlist } from "./Watchlist";
import { LAYOUTS, addToWatchlist, engines, getState, setTool, toggleWatchlist, updateActiveCell, useTerminal } from "./store";
import { TerminalUIContext, type TerminalUI } from "./ui";
import { useScreenerPolling } from "@/client/screenerFeed";
import { stepIdea } from "./ideaActions";
import { BottomDock, WidgetBar } from "./Dock";
import { Splitter } from "./Splitter";
import { api } from "@/client/api";
import { DEFAULT_SIZES, addPresetList, setSizes, setState, type LayoutId } from "./store";

/** Matches the CSS breakpoint where the sidebar turns into a drawer. */
const NARROW_MAX_WIDTH = 1100;

const TOOL_SHORTCUTS: Record<string, Tool> = { KeyT: "trendline", KeyH: "hline", KeyF: "fib", KeyR: "rect" };

interface SearchState {
  query: string;
  mode: "chart" | "watchlist";
}

export function Terminal() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") router.push("/auth/signin");
  }, [router, status]);

  if (status !== "authenticated" || !session) {
    return (
      <div className="tx-boot">
        <span className="tx-spinner" />
      </div>
    );
  }
  return <Workspace />;
}

function Workspace() {
  const layout = useTerminal((state) => state.layout);
  const activeCell = useTerminal((state) => state.activeCell);
  const watchlistOpen = useTerminal((state) => state.watchlistOpen);
  const screenerOpen = useTerminal((state) => state.screener.open);
  const screenerMax = useTerminal((state) => state.screener.maximized);
  const screenerView = useTerminal((state) => state.screener.view);
  const [search, setSearch] = useState<SearchState | null>(null);
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  const [guide, setGuide] = useState<"smc" | null>(null);
  const [layoutDialog, setLayoutDialog] = useState<LayoutDialogState | null>(null);
  useScreenerPolling(useTerminal((state) => state.screener.universe));
  useHighLowPolling(screenerOpen && screenerView === "highlow");
  usePlanPolling();

  // First run after this update: make the full F&O list the default watchlist (once — later changes stick).
  useEffect(() => {
    if (getState().fnoSeeded) return;
    let cancelled = false;
    api
      .presets()
      .then((presets) => {
        const all = presets.find((preset) => preset.id === "preset-fno-all");
        if (cancelled || !all?.symbols.length) return;
        const { watchlistOpen, sidePanel } = getState();
        addPresetList(all.name, all.symbols);
        // Seeding shouldn't pop the sidebar open (e.g. over the chart on iPad portrait).
        setState((current) => ({ ...current, fnoSeeded: true, watchlistOpen, sidePanel }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Where the sidebar is a drawer over the chart (iPad portrait), start with the chart visible.
  useEffect(() => {
    if (window.innerWidth <= NARROW_MAX_WIDTH && getState().watchlistOpen) toggleWatchlist();
  }, []);

  const cellCount = LAYOUTS.find((entry) => entry.id === layout)?.cells ?? 1;
  const modalOpen = Boolean(search) || indicatorsOpen || Boolean(layoutDialog) || Boolean(guide);

  const ui = useMemo<TerminalUI>(
    () => ({
      openSearch: (options) => setSearch({ query: options?.query ?? "", mode: options?.mode ?? "chart" }),
      openIndicators: () => setIndicatorsOpen(true),
      openGuide: (name) => setGuide(name),
    }),
    [],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (modalOpen) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const engine = engines.get(getState().activeCell);

      if (event.key === "Escape") {
        engine?.cancel();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (engine?.deleteSelected()) event.preventDefault();
        return;
      }
      if (event.altKey && !event.metaKey && !event.ctrlKey && TOOL_SHORTCUTS[event.code]) {
        event.preventDefault();
        setTool(TOOL_SHORTCUTS[event.code]);
        return;
      }
      // Step through the screener's trade ideas from anywhere.
      if ((event.key === "]" || event.key === "[") && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        stepIdea(event.key === "]" ? 1 : -1);
        return;
      }
      if (event.key === "/" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setIndicatorsOpen(true);
        return;
      }
      // Typing a ticker anywhere opens symbol search pre-filled, like TradingView.
      if (!event.metaKey && !event.ctrlKey && !event.altKey && /^[a-z0-9]$/i.test(event.key)) {
        event.preventDefault();
        setSearch({ query: event.key.toUpperCase(), mode: "chart" });
      }
    },
    [modalOpen],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  return (
    <TerminalUIContext.Provider value={ui}>
      <div className="tx-root">
        <TopBar onLayoutDialog={setLayoutDialog} />
        <div className="tx-body">
          <DrawingToolbar />
          <div className={`tx-center ${screenerOpen && screenerMax ? "is-max" : ""}`}>
            <ChartGrid layout={layout} cellCount={cellCount} activeCell={activeCell} />
            <LayoutGuide />
            {screenerOpen && (screenerView === "compare" ? <ComparePanel /> : screenerView === "highlow" ? <HighLowPanel /> : screenerView === "backtest" ? <BacktestPanel /> : screenerView === "plan" ? <PlanPanel /> : <ScreenerPanel />)}
            <BottomDock />
          </div>
          {watchlistOpen && <Watchlist />}
          <WidgetBar />
        </div>
      </div>

      {search && (
        <SymbolSearch
          initialQuery={search.query}
          title={search.mode === "watchlist" ? "Add to watchlist" : "Symbol search"}
          onSelect={(symbol) => (search.mode === "watchlist" ? addToWatchlist(symbol) : updateActiveCell({ symbol }))}
          onClose={() => setSearch(null)}
        />
      )}
      {indicatorsOpen && <IndicatorsDialog onClose={() => setIndicatorsOpen(false)} />}
      {guide === "smc" && <SmcGuide onClose={() => setGuide(null)} />}
      {layoutDialog && <LayoutNameDialog dialog={layoutDialog} onClose={() => setLayoutDialog(null)} />}
      <LayoutToast />
      <AlertWatcher />
      <BtstAlertWatcher />
    </TerminalUIContext.Provider>
  );
}

const MIN_SHARE = 0.2;
const clampShare = (value: number) => Math.min(1 - MIN_SHARE, Math.max(MIN_SHARE, value));

/** The chart cells, with draggable dividers between them in multi-chart layouts. */
function ChartGrid({ layout, cellCount, activeCell }: { layout: LayoutId; cellCount: number; activeCell: number }) {
  const sizes = useTerminal((state) => state.sizes);
  const ref = useRef<HTMLElement>(null);
  const startRef = useRef({ col: sizes.gridCol, row: sizes.gridRow, width: 1, height: 1 });

  const hasCol = layout === "2v" || layout === "3" || layout === "4";
  const hasRow = layout === "2h" || layout === "3" || layout === "4";
  const col = `${sizes.gridCol}fr ${1 - sizes.gridCol}fr`;
  const row = `${sizes.gridRow}fr ${1 - sizes.gridRow}fr`;
  const template =
    layout === "2v" ? `1fr / ${col}` : layout === "2h" ? `${row} / 1fr` : layout === "3" || layout === "4" ? `${row} / ${col}` : undefined;

  const begin = () => {
    const box = ref.current?.getBoundingClientRect();
    startRef.current = { col: sizes.gridCol, row: sizes.gridRow, width: box?.width ?? 1, height: box?.height ?? 1 };
  };

  return (
    <main ref={ref} className={`tx-grid tx-grid-${layout}`} style={template ? { gridTemplate: template } : undefined}>
      {Array.from({ length: cellCount }, (_, index) => (
        <ChartCell key={index} index={index} active={index === activeCell} multi={cellCount > 1} />
      ))}
      {hasCol && (
        <Splitter
          axis="x"
          label="Resize charts"
          className="tx-grid-split"
          style={{ left: `calc(${sizes.gridCol * 100}% - 3px)` }}
          onStart={begin}
          onDrag={(dx) => setSizes({ gridCol: clampShare(startRef.current.col + dx / startRef.current.width) })}
          onReset={() => setSizes({ gridCol: DEFAULT_SIZES.gridCol })}
        />
      )}
      {hasRow && (
        <Splitter
          axis="y"
          label="Resize charts"
          className="tx-grid-split"
          // In "1 large + 2 small" the row divider only splits the right column.
          style={{ top: `calc(${sizes.gridRow * 100}% - 3px)`, left: layout === "3" ? `${sizes.gridCol * 100}%` : 0 }}
          onStart={begin}
          onDrag={(dy) => setSizes({ gridRow: clampShare(startRef.current.row + dy / startRef.current.height) })}
          onReset={() => setSizes({ gridRow: DEFAULT_SIZES.gridRow })}
        />
      )}
    </main>
  );
}
