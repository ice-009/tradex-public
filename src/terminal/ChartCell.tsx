"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartEngine } from "@/chart/engine";
import { INDICATORS, createIndicatorConfig, indicatorTitle } from "@/core/indicators/indicators";
import { formatCompact, formatCrosshairTime, formatPrice, formatValue } from "@/core/format";
import type { LegendState } from "@/chart/types";
import type { IndicatorConfig } from "@/core/types";
import {
  EMPTY_DRAWINGS,
  engines,
  removeIndicator,
  setActiveCell,
  setTool,
  toggleLinkSymbols,
  updateIndicator,
  useTerminal,
} from "./store";
import { commitDrawings, redoDrawings, undoDrawings } from "./drawingHistory";
import { publishCrosshair, subscribeCrosshair } from "./crosshairSync";
import { toggleAutoPatterns, toggleShowPlans, toggleSyncCrosshair, usePrefs } from "./uiPrefs";
import { GROUP_LABEL, focusedHit, useIdea, useScreenerFeed } from "@/client/screenerFeed";
import { DrawingProperties } from "./DrawingProperties";
import { INTERVAL_META } from "@/core/market/intervals";
import { applyTick, fetchHistory, liveHub } from "@/client/marketData";
import { Icons } from "./icons";
import { useTerminalUI } from "./ui";
import { IndicatorSettings } from "./IndicatorSettings";

interface Selection {
  id: string;
  left: number;
  top: number;
}

const PROPS_WIDTH = 380;
/** The virtual "Auto chart patterns" layer (fixed id so the engine keeps its cache across renders). */
const AUTO_PATTERNS = { ...createIndicatorConfig("patterns"), id: "auto-patterns" }; // approximate floating toolbar width, for initial placement

function isTypingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)));
}

interface LoadStatus {
  loading: boolean;
  error: string | null;
  source: "broker" | "eod" | "sample" | null;
  reason: string | null;
}

export function ChartCell({ index, active, multi }: { index: number; active: boolean; multi: boolean }) {
  const cell = useTerminal((state) => state.cells[index]);
  const tool = useTerminal((state) => state.tool);
  const magnet = useTerminal((state) => state.magnet);
  const drawings = useTerminal((state) => state.drawings[state.cells[index].symbol] ?? EMPTY_DRAWINGS);
  const hideDrawings = usePrefs((prefs) => prefs.hideDrawings);
  const syncCrosshair = usePrefs((prefs) => prefs.syncCrosshair);
  const showPlans = usePrefs((prefs) => prefs.showPlans);
  const linkSymbols = useTerminal((state) => state.linkSymbols);
  const idea = useIdea(cell.symbol);
  const focus = useScreenerFeed((feed) => feed.focus);
  const ui = useTerminalUI();

  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ChartEngine | null>(null);
  const symbolRef = useRef(cell.symbol);
  const [legend, setLegend] = useState<LegendState | null>(null);
  const [status, setStatus] = useState<LoadStatus>({ loading: true, error: null, source: null, reason: null });
  const [editing, setEditing] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ id: string; n: number } | null>(null);
  const hoveredRef = useRef(false);
  const syncRef = useRef(syncCrosshair);

  useEffect(() => {
    symbolRef.current = cell.symbol;
  }, [cell.symbol]);
  useEffect(() => {
    syncRef.current = syncCrosshair;
    if (!syncCrosshair) engineRef.current?.setExternalCrosshair(null);
  }, [syncCrosshair]);

  // Engine lifecycle. Must stay the first effect so the config effects below see it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const placeToolbar = (id: string): Selection | null => {
      const bounds = engineRef.current?.getDrawingBounds(id);
      if (!bounds) return null;
      const center = (bounds.left + bounds.right) / 2;
      const left = Math.max(8, Math.min(center - PROPS_WIDTH / 2, bounds.plotWidth - PROPS_WIDTH - 8));
      const above = bounds.top - 50;
      const top = above >= 34 ? above : Math.min(bounds.bottom + 14, bounds.plotHeight - 44);
      return { id, left, top: Math.max(34, top) };
    };
    const engine = new ChartEngine(host, {
      onLegend: setLegend,
      onDrawingsChange: (next) => commitDrawings(symbolRef.current, next),
      onToolChange: (next) => setTool(next),
      onPointerDown: () => setActiveCell(index),
      onSelectionChange: (id, reason) => {
        setSelection(id ? placeToolbar(id) : null);
        // A freshly placed text drawing opens straight into editing.
        setFocusRequest(id && reason === "create" ? { id, n: Date.now() } : null);
      },
      onDrawingDoubleClick: (id) => setFocusRequest({ id, n: Date.now() }),
      onCrosshairMove: (time) => {
        if (syncRef.current) publishCrosshair(index, time);
      },
    });
    engineRef.current = engine;
    engines.set(index, engine);
    const unsubscribeSync = subscribeCrosshair((source, time) => {
      if (source !== index) engine.setExternalCrosshair(syncRef.current ? time : null);
    });
    return () => {
      unsubscribeSync();
      publishCrosshair(index, null);
      engine.destroy();
      engines.delete(index);
      engineRef.current = null;
    };
  }, [index]);

  useEffect(() => engineRef.current?.setChartType(cell.chartType), [cell.chartType]);
  useEffect(() => engineRef.current?.setScaleMode(cell.scaleMode), [cell.scaleMode]);
  useEffect(() => engineRef.current?.setShowVolume(cell.showVolume), [cell.showVolume]);
  // Auto patterns ride along as a virtual indicator unless the user added the indicator themselves.
  const autoPatterns = usePrefs((prefs) => prefs.autoPatterns);
  const engineIndicators = useMemo(
    () => (autoPatterns && !cell.indicators.some((indicator) => indicator.type === "patterns") ? [...cell.indicators, AUTO_PATTERNS] : cell.indicators),
    [cell.indicators, autoPatterns],
  );
  useEffect(() => engineRef.current?.setIndicators(engineIndicators), [engineIndicators]);
  useEffect(() => engineRef.current?.setDrawings(drawings), [drawings]);
  useEffect(() => engineRef.current?.setMagnet(magnet), [magnet]);
  useEffect(() => engineRef.current?.setDrawingsVisible(!hideDrawings), [hideDrawings]);

  // Armed price alerts for this symbol, drawn as dashed lines.
  const alerts = useTerminal((state) => state.alerts);
  const alertLines = useMemo(
    () => alerts.filter((alert) => alert.symbol === cell.symbol && !alert.triggeredAt).map((alert) => ({ price: alert.price, label: alert.label })),
    [alerts, cell.symbol],
  );
  useEffect(() => engineRef.current?.setAlertLines(alertLines), [alertLines]);

  // Tell the engine where the legend sits so canvas labels stay out from under it.
  const legendRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = legendRef.current;
    const engine = engineRef.current;
    if (!element || !engine) return;
    const report = () => engine.setLegendBox(element.offsetWidth, element.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Same for the top-right toolbar (it mounts once the first legend arrives).
  const toolbarRef = useRef<HTMLDivElement>(null);
  const hasToolbar = Boolean(legend);
  useEffect(() => {
    const element = toolbarRef.current;
    const engine = engineRef.current;
    if (!element || !engine) return;
    const report = () => engine.setToolbarBox(element.offsetWidth, element.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasToolbar]);

  // The screener's plan for this stock, as entry/stop/target zones (never saved as a drawing).
  const hit = idea ? focusedHit(idea, focus) : null;
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!hit || !showPlans) {
      engine.setTradePlan(null);
      return;
    }
    const { plan, date, close } = hit.row;
    engine.setTradePlan({
      entry: plan.entry,
      stop: plan.stop,
      target: plan.target,
      time: date,
      label: `${GROUP_LABEL[hit.screen.group]} · ${hit.screen.name}`,
      buyStop: plan.entry > close * 1.0005,
    });
  }, [hit, showPlans]);

  // Undo/redo drawing edits on the active chart's symbol.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || document.querySelector(".tx-modal")) return;
      const key = event.key.toLowerCase();
      if (!(event.metaKey || event.ctrlKey) || event.altKey || (key !== "z" && key !== "y")) return;
      event.preventDefault();
      if (key === "y" || event.shiftKey) redoDrawings(cell.symbol);
      else undoDrawings(cell.symbol);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, cell.symbol]);

  // Keyboard pan/zoom while the pointer is over this chart: ←/→ pan, ↑/↓ or +/− zoom (Shift = bigger steps).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const engine = engineRef.current;
      if (!engine || !hoveredRef.current || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target) || document.querySelector(".tx-modal")) return;
      const step = Math.max(1, Math.round(engine.visibleBarCount() * (event.shiftKey ? 0.5 : 0.1)));
      const zoom = event.shiftKey ? 1.5 : 1.15;
      switch (event.key) {
        case "ArrowLeft":
          engine.panBy(-step);
          break;
        case "ArrowRight":
          engine.panBy(step);
          break;
        case "ArrowUp":
        case "+":
        case "=":
          engine.zoomBy(zoom);
          break;
        case "ArrowDown":
        case "-":
        case "_":
          engine.zoomBy(1 / zoom);
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The drawing tool belongs to the active chart only.
  useEffect(() => engineRef.current?.setTool(active ? tool : "cursor"), [tool, active]);

  // History + live ticks for the current symbol/interval.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const { symbol, interval } = cell;
    const meta = INTERVAL_META[interval];
    const controller = new AbortController();
    let loaded = false;
    let volumeBase: number | null = null;

    const onTick = (tick: Parameters<typeof applyTick>[1]) => {
      if (!loaded) return;
      const last = engine.getLastBar();
      if (!last) return;
      const delta = volumeBase === null ? 0 : Math.max(0, tick.volume - volumeBase);
      volumeBase = tick.volume;
      const next = applyTick(last, tick, interval, delta);
      if (next) engine.updateBar(next);
    };

    setStatus({ loading: true, error: null, source: null, reason: null });
    engine.select(null); // the floating properties toolbar would point at stale geometry
    fetchHistory(symbol, interval, controller.signal)
      .then((result) => {
        engine.setData(result.bars, { intervalMs: meta.ms, intraday: meta.intraday, resetView: true });
        loaded = true;
        setStatus({ loading: false, error: null, source: result.source, reason: result.reason });
        if (result.source === "broker") {
          const latest = liveHub.getLatest(symbol);
          if (latest) onTick(latest);
        }
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        engine.setData([], { intervalMs: meta.ms, intraday: meta.intraday, resetView: true });
        setStatus({ loading: false, error: error.message || "Could not load chart data", source: null, reason: null });
      });

    const unsubscribe = liveHub.subscribe(symbol, onTick, 0);
    return () => {
      controller.abort();
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell.symbol, cell.interval]);

  const editingConfig = editing ? cell.indicators.find((indicator) => indicator.id === editing) : null;
  const selectedDrawing = selection ? drawings.find((drawing) => drawing.id === selection.id) : undefined;
  const showProperties = Boolean(active && selection && selectedDrawing && !selectedDrawing.hidden && !hideDrawings);

  const takeSnapshot = () => {
    const engine = engineRef.current;
    if (!engine) return;
    const meta = INTERVAL_META[cell.interval];
    const last = engine.getLastBar();
    const ohlc = last
      ? `O ${formatPrice(last.open)}  H ${formatPrice(last.high)}  L ${formatPrice(last.low)}  C ${formatPrice(last.close)}   ·   `
      : "";
    const url = engine.snapshot(`${cell.symbol} · ${meta.label} · NSE`, `${ohlc}${formatCrosshairTime(Date.now(), true)} IST`);
    const stamp = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    const link = document.createElement("a");
    link.href = url;
    link.download = `${cell.symbol}_${cell.interval}_${stamp}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  const bar = legend?.bar ?? null;
  const change = bar && legend?.prevClose ? bar.close - legend.prevClose : null;
  const changePct = change !== null && legend?.prevClose ? (change / legend.prevClose) * 100 : null;
  const tone = change === null ? "" : change >= 0 ? "is-up" : "is-down";

  const mainRows = cell.indicators.filter(
    (indicator) => INDICATORS[indicator.type]?.pane === "overlay" || indicator.hidden,
  );

  const renderRow = useCallback(
    (indicator: IndicatorConfig) => (
      <LegendRow
        key={indicator.id}
        indicator={indicator}
        values={legend?.values[indicator.id] ?? []}
        onToggle={() => updateIndicator(index, indicator.id, { hidden: !indicator.hidden })}
        onSettings={() => setEditing(indicator.id)}
        onRemove={() => removeIndicator(index, indicator.id)}
        onGuide={INDICATORS[indicator.type]?.guide ? () => ui.openGuide(INDICATORS[indicator.type].guide as "smc") : undefined}
      />
    ),
    [index, legend, ui],
  );

  return (
    <div
      className={`tx-cell ${active && multi ? "is-active" : ""}`}
      onPointerDownCapture={() => setActiveCell(index)}
      onPointerEnter={() => {
        hoveredRef.current = true;
      }}
      onPointerLeave={() => {
        hoveredRef.current = false;
      }}
    >
      <div ref={hostRef} className="tx-canvas-host" />

      {legend && (
        <div ref={toolbarRef} className="tx-cell-actions" style={{ left: legend.plotWidth - 8 }}>
          {idea && hit && (
            <button
              type="button"
              className={`tx-cell-action tx-cell-setups tx-hz-${hit.screen.group} ${showPlans ? "is-on" : ""}`}
              title={`${idea.hits.map((entry) => entry.screen.name).join(" · ")}\n${showPlans ? "Hide" : "Show"} the entry / stop / target`}
              aria-label="Show or hide the trade plan"
              aria-pressed={showPlans}
              onClick={toggleShowPlans}
            >
              <Icons.target size={15} />
              <span>{idea.hits.length}</span>
            </button>
          )}
          <button
            type="button"
            className={`tx-cell-action ${autoPatterns ? "is-on" : ""}`}
            title={autoPatterns ? "Hide automatic chart patterns and S/R zones" : "Show automatic chart patterns and S/R zones"}
            aria-label="Chart patterns"
            aria-pressed={autoPatterns}
            onClick={toggleAutoPatterns}
          >
            <Icons.patterns size={15} />
          </button>
          {multi && (
            <button
              type="button"
              className={`tx-cell-action is-minor ${linkSymbols ? "is-on" : ""}`}
              title={linkSymbols ? "Symbol linked across charts (click to unlink)" : "Link the symbol across charts (each keeps its timeframe)"}
              aria-label="Link symbol"
              aria-pressed={linkSymbols}
              onClick={toggleLinkSymbols}
            >
              <Icons.link size={15} />
            </button>
          )}
          {multi && (
            <button
              type="button"
              className={`tx-cell-action is-minor ${syncCrosshair ? "is-on" : ""}`}
              title={syncCrosshair ? "Crosshair synced across charts (click to unsync)" : "Sync crosshair across charts"}
              aria-label="Sync crosshair"
              onClick={toggleSyncCrosshair}
            >
              <Icons.sync size={15} />
            </button>
          )}
          <button type="button" className="tx-cell-action is-minor" title="Take snapshot (PNG)" aria-label="Take snapshot" onClick={takeSnapshot}>
            <Icons.camera size={15} />
          </button>
        </div>
      )}

      {showProperties && selection && selectedDrawing && (
        <DrawingProperties
          key={selection.id}
          drawing={selectedDrawing}
          symbol={cell.symbol}
          position={selection}
          focusText={focusRequest?.id === selection.id ? focusRequest.n : 0}
          onClone={() => engineRef.current?.cloneSelected()}
          onDelete={() => engineRef.current?.deleteSelected()}
        />
      )}

      <div ref={legendRef} className="tx-legend" style={{ maxWidth: legend ? Math.max(120, legend.plotWidth - 16) : undefined }}>
        <div className="tx-legend-head">
          <button type="button" className="tx-legend-symbol" onClick={() => ui.openSearch()}>
            {cell.symbol}
          </button>
          <span className="tx-legend-dim">· {INTERVAL_META[cell.interval].label} · NSE</span>
          {bar && (
            <span className={`tx-legend-ohlc ${tone}`}>
              <span className="lg-ohl"><em>O</em>{formatPrice(bar.open)}</span>
              <span className="lg-ohl"><em>H</em>{formatPrice(bar.high)}</span>
              <span className="lg-ohl"><em>L</em>{formatPrice(bar.low)}</span>
              <span><em>C</em>{formatPrice(bar.close)}</span>
              {change !== null && changePct !== null && (
                <span>
                  {change >= 0 ? "+" : ""}
                  {formatPrice(change)} ({change >= 0 ? "+" : ""}
                  {changePct.toFixed(2)}%)
                </span>
              )}
              {cell.showVolume && bar.volume > 0 && (
                <span className="tx-legend-vol"><em>Vol</em>{formatCompact(bar.volume)}</span>
              )}
            </span>
          )}
        </div>
        {mainRows.map(renderRow)}
      </div>

      {legend?.panes.slice(1).map((pane) => {
        const indicator = cell.indicators.find((candidate) => candidate.id === pane.id);
        if (!indicator) return null;
        return (
          <div key={pane.id} className="tx-legend tx-legend-sub" style={{ top: pane.top + 4 }}>
            {renderRow(indicator)}
          </div>
        );
      })}

      {status.loading && (
        <div className="tx-cell-overlay">
          <span className="tx-spinner" />
        </div>
      )}
      {status.error && (
        <div className="tx-cell-overlay">
          <div className="tx-cell-error">{status.error}</div>
        </div>
      )}
      {(status.source === "sample" || status.source === "eod") && !status.loading && (
        <div className="tx-sample-badge" title={status.reason ?? undefined}>
          {status.source === "sample" ? "Sample data · no market data source connected" : "End-of-day data · broker not connected"}
        </div>
      )}
      {legend?.scrolledAway && (
        <button
          type="button"
          className="tx-realtime-btn"
          style={{ left: legend.plotWidth - 40 }}
          title="Scroll to the latest bar"
          onClick={() => engineRef.current?.scrollToRealtime()}
        >
          <Icons.realtime size={14} />
        </button>
      )}

      {editingConfig && (
        <IndicatorSettings
          config={editingConfig}
          onClose={() => setEditing(null)}
          onApply={(patch) => updateIndicator(index, editingConfig.id, patch)}
        />
      )}
    </div>
  );
}

function LegendRow({
  indicator,
  values,
  onToggle,
  onSettings,
  onRemove,
  onGuide,
}: {
  indicator: IndicatorConfig;
  values: Array<{ label: string; color: string; value: number | null }>;
  onToggle: () => void;
  onSettings: () => void;
  onRemove: () => void;
  onGuide?: () => void;
}) {
  return (
    // Focusable so a tap on a touch screen reveals the row's buttons (there's no hover there).
    <div className={`tx-legend-row ${indicator.hidden ? "is-hidden" : ""}`} tabIndex={0}>
      <span className="tx-legend-name">{indicatorTitle(indicator)}</span>
      {!indicator.hidden &&
        values.map((entry) => (
          <span key={entry.label} className="tx-legend-value" style={{ color: entry.color }}>
            {entry.value === null ? "—" : formatValue(entry.value)}
          </span>
        ))}
      {onGuide && (
        <button type="button" className="tx-legend-learn" onClick={onGuide} title="How to read this indicator">
          Learn
        </button>
      )}
      <span className="tx-legend-actions">
        <button type="button" onClick={onToggle} title={indicator.hidden ? "Show" : "Hide"}>
          {indicator.hidden ? <Icons.eyeOff size={14} /> : <Icons.eye size={14} />}
        </button>
        <button type="button" onClick={onSettings} title="Settings">
          <Icons.gear size={14} />
        </button>
        <button type="button" onClick={onRemove} title="Remove">
          <Icons.x size={14} />
        </button>
      </span>
    </div>
  );
}
