import type { Anchor, ChartType, Drawing, LegendState, PaneLayout, ScaleMode, Tool, TradePlanOverlay } from "@/chart/types";
import type { Bar, IndicatorConfig } from "@/core/types";
import { DARK_THEME, type ChartTheme } from "./theme";
import { INDICATORS, outputOffset, resolveParams, type IndicatorDef, type OutputDef, type Series } from "@/core/indicators/indicators";
import {
  withAlpha,
  axisLabels,
  drawingBounds,
  DEFAULT_TEXT,
  DRAWING_COLORS,
  DRAWING_POINTS,
  hitTestDrawing,
  moveHandle,
  placePoint,
  positionPoints,
  renderDrawing,
  type DrawingCoords,
  type DrawingHit,
} from "./drawings";
import { renderAnnotationBoxes, renderAnnotationMarks, type AnnotationCoords } from "./annotations";
import type { Annotations } from "@/core/indicators/smc";
import { formatCompact, formatCrosshairTime, formatPrice, formatTickLabel, formatValue, istClock } from "@/core/format";

// A self-contained canvas charting engine. One instance renders one chart
// (price pane + any oscillator panes + both axes) into a single <canvas> and
// owns all pointer interaction. It knows nothing about React or the network:
// the UI pushes data/config in and listens to the callbacks below.

export interface EngineCallbacks {
  onLegend?(legend: LegendState): void;
  onDrawingsChange?(drawings: Drawing[]): void;
  onToolChange?(tool: Tool): void;
  onPointerDown?(): void;
  /** Selected drawing changed. `reason` is "create" right after a drawing is placed. */
  onSelectionChange?(id: string | null, reason: "create" | "click" | "other"): void;
  /** Double-click on a drawing (e.g. to edit a text drawing). */
  onDrawingDoubleClick?(id: string): void;
  /** Crosshair moved to a bar time (null when it left the plot); used to sync other charts. */
  onCrosshairMove?(time: number | null): void;
}

export interface DrawingScreenBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  plotWidth: number;
  plotHeight: number;
}

export interface DataMeta {
  intervalMs: number;
  intraday: boolean;
  resetView: boolean;
}

interface Pane {
  id: string;
  def: IndicatorDef | null; // null for the main price pane
  top: number;
  height: number;
  auto: boolean;
  min: number; // scale space (log10 when the main pane is in log mode)
  max: number;
}

type Region =
  | { kind: "plot"; pane: Pane }
  | { kind: "priceAxis"; pane: Pane }
  | { kind: "timeAxis" }
  | { kind: "separator"; upper: Pane; lower: Pane }
  | { kind: "none" };

type DragState =
  | { kind: "pan"; pane: Pane; startX: number; startY: number; startOffset: number; startMin: number; startMax: number; vertical: boolean }
  | { kind: "priceScale"; pane: Pane; startY: number; startMin: number; startMax: number }
  | { kind: "timeScale"; startX: number; startSpacing: number }
  | { kind: "separator"; upper: Pane; lower: Pane; startY: number; startUpper: number; startLower: number }
  | { kind: "drawing"; id: string; hit: DrawingHit; startX: number; startY: number; origin: Anchor[]; moved: boolean };

interface PendingDrawing {
  drawing: Drawing;
  startX: number;
  startY: number;
  dragged: boolean;
  freehand?: boolean; // brush: points stream in while the button is held
}

const TIME_AXIS_HEIGHT = 28;
const MIN_PRICE_AXIS_WIDTH = 64;
const MIN_PANE_HEIGHT = 36;
const MIN_BAR_SPACING = 0.5;
const MAX_BAR_SPACING = 80;
const DEFAULT_BAR_SPACING = 8;
const DEFAULT_RIGHT_OFFSET = 6;
const PLAN_RIGHT_OFFSET = 18;
const LONG_PRESS_MS = 350;
const ALERT_COLOR = "#f7a600";
const TOUCH_SLOP = 8;
const VOLUME_PANE_RATIO = 0.2;
const SESSION_BREAK_COLOR = "rgba(41, 98, 255, 0.28)";

function newDrawingId() {
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export class ChartEngine {
  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly callbacks: EngineCallbacks;
  private readonly resizeObserver: ResizeObserver;
  private readonly theme: ChartTheme = DARK_THEME;

  private width = 0;
  private height = 0;
  private dpr = 1;
  private plotWidth = 0;
  private priceAxisWidth = MIN_PRICE_AXIS_WIDTH;

  private bars: Bar[] = [];
  private displayBars: Bar[] = []; // == bars, or Heikin Ashi transform
  private tickWeights: Uint8Array = new Uint8Array(0);
  private intervalMs = 60_000;
  private intraday = true;
  private chartType: ChartType = "candles";
  private scaleMode: ScaleMode = "linear";
  private showVolume = true;

  private indicatorConfigs: IndicatorConfig[] = [];
  private indicatorData = new Map<string, Record<string, Series>>();
  private annotations = new Map<string, Annotations>();
  private indicatorsDirty = false;

  private drawings: Drawing[] = [];
  private tool: Tool = "cursor";
  private magnet = false;
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private pending: PendingDrawing | null = null;
  private drawingColorIndex = 0;
  private drawingsVisible = true;
  private tradePlan: TradePlanOverlay | null = null;
  /** Armed price alerts for this symbol: dashed lines with a bell label. */
  private alertLines: Array<{ price: number; label: string }> = [];
  /** Size of the DOM legend over the top-left of the price pane; chart labels keep out of it. */
  private legendBox = { width: 0, height: 0 };
  /** Size of the chart's top-right toolbar (plan / patterns / link / snapshot buttons). */
  private toolbarBox = { width: 0, height: 0 };
  private externalTime: number | null = null; // crosshair synced from another chart
  private lastCrosshairTime: number | null = null;

  private barSpacing = DEFAULT_BAR_SPACING;
  private rightOffset = DEFAULT_RIGHT_OFFSET;
  private panes: Pane[] = [];
  private paneWeights = new Map<string, number>();

  private mouse: { x: number; y: number } | null = null;
  // Touch: active fingers, a two-finger pinch, and long-press crosshair mode (TradingView-style).
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { startDist: number; startSpacing: number; anchorIndex: number; lastMidX: number } | null = null;
  private longPress: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
  private touchCrosshair = false;
  private drag: DragState | null = null;
  private frame = 0;
  private lastLegendKey = "";
  private dataVersion = 0;
  private destroyed = false;

  constructor(container: HTMLElement, callbacks: EngineCallbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.touchAction = "none";
    container.appendChild(this.canvas);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;

    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointercancel", this.handlePointerUp);
    this.canvas.addEventListener("pointerleave", this.handlePointerLeave);
    this.canvas.addEventListener("dblclick", this.handleDoubleClick);
    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  destroy() {
    this.destroyed = true;
    this.clearLongPress();
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerUp);
    this.canvas.removeEventListener("pointerleave", this.handlePointerLeave);
    this.canvas.removeEventListener("dblclick", this.handleDoubleClick);
    this.canvas.removeEventListener("wheel", this.handleWheel);
    this.canvas.remove();
  }

  // ---------------------------------------------------------------- public API

  setData(bars: Bar[], meta: DataMeta) {
    this.bars = bars.slice();
    this.intervalMs = meta.intervalMs;
    this.intraday = meta.intraday;
    this.rebuildDerived();
    if (meta.resetView) {
      this.barSpacing = DEFAULT_BAR_SPACING;
      this.rightOffset = this.tradePlan ? PLAN_RIGHT_OFFSET : DEFAULT_RIGHT_OFFSET;
      for (const pane of this.panes) pane.auto = true;
    }
    this.clampView();
    this.invalidate();
  }

  /** Apply a live update: replaces the last bar when times match, else appends. */
  updateBar(bar: Bar) {
    const last = this.bars[this.bars.length - 1];
    if (last && bar.time < last.time) return;
    if (last && bar.time === last.time) {
      this.bars[this.bars.length - 1] = bar;
    } else {
      this.bars.push(bar);
    }
    this.rebuildDerived();
    this.invalidate();
  }

  getLastBar(): Bar | null {
    return this.bars[this.bars.length - 1] ?? null;
  }

  setChartType(type: ChartType) {
    if (type === this.chartType) return;
    this.chartType = type;
    this.displayBars = type === "heikin" ? toHeikinAshi(this.bars) : this.bars;
    this.invalidate();
  }

  setScaleMode(mode: ScaleMode) {
    if (mode === this.scaleMode) return;
    this.scaleMode = mode;
    const main = this.panes.find((pane) => pane.id === "main");
    if (main) main.auto = true;
    this.invalidate();
  }

  setShowVolume(show: boolean) {
    this.showVolume = show;
    this.invalidate();
  }

  setIndicators(configs: IndicatorConfig[]) {
    this.indicatorConfigs = configs.filter((config) => INDICATORS[config.type]);
    this.indicatorsDirty = true;
    this.syncPanes();
    this.invalidate();
  }

  setDrawings(drawings: Drawing[]) {
    if (this.drag?.kind === "drawing") return; // don't clobber an in-flight edit
    this.drawings = drawings;
    const selected = drawings.find((drawing) => drawing.id === this.selectedId);
    if (this.selectedId && (!selected || selected.hidden)) this.setSelected(null);
    if (this.hoveredId && !drawings.some((drawing) => drawing.id === this.hoveredId)) this.hoveredId = null;
    this.invalidate();
  }

  setTool(tool: Tool) {
    this.tool = tool;
    this.pending = null;
    if (tool !== "cursor") this.setSelected(null);
    this.updateCursor();
    this.invalidate();
  }

  setAlertLines(lines: Array<{ price: number; label: string }>) {
    const same = lines.length === this.alertLines.length && lines.every((line, i) => line.price === this.alertLines[i].price && line.label === this.alertLines[i].label);
    if (same) return;
    this.alertLines = lines;
    this.invalidate();
  }

  /** The legend's on-screen size, so labels drawn on the canvas don't hide under it. */
  setLegendBox(width: number, height: number) {
    if (Math.abs(width - this.legendBox.width) < 1 && Math.abs(height - this.legendBox.height) < 1) return;
    this.legendBox = { width, height };
    this.invalidate();
  }

  setToolbarBox(width: number, height: number) {
    if (Math.abs(width - this.toolbarBox.width) < 1 && Math.abs(height - this.toolbarBox.height) < 1) return;
    this.toolbarBox = { width, height };
    this.invalidate();
  }

  /** Show (or clear) a screener trade plan: entry, stop and target zones from the signal bar onward. */
  setTradePlan(plan: TradePlanOverlay | null) {
    const same =
      plan === this.tradePlan ||
      (plan && this.tradePlan && plan.entry === this.tradePlan.entry && plan.stop === this.tradePlan.stop &&
        plan.target === this.tradePlan.target && plan.time === this.tradePlan.time && plan.label === this.tradePlan.label);
    if (same) return;
    this.tradePlan = plan;
    // Like placing a position tool: give the zone room on the right, unless the user has scrolled away.
    if (plan && Math.abs(this.rightOffset - DEFAULT_RIGHT_OFFSET) < 0.5) {
      this.rightOffset = PLAN_RIGHT_OFFSET;
      this.clampView();
    }
    this.invalidate();
  }

  setMagnet(magnet: boolean) {
    this.magnet = magnet;
  }

  /** Global "hide all drawings" (does not change the drawings themselves). */
  setDrawingsVisible(visible: boolean) {
    if (visible === this.drawingsVisible) return;
    this.drawingsVisible = visible;
    if (!visible) {
      this.pending = null;
      this.hoveredId = null;
      this.setSelected(null);
    }
    this.invalidate();
  }

  getSelectedId() {
    return this.selectedId;
  }

  /** Programmatic selection (e.g. after cloning from the properties toolbar). */
  select(id: string | null) {
    this.setSelected(id && this.drawings.some((drawing) => drawing.id === id) ? id : null);
    this.invalidate();
  }

  /** Canvas-local pixel bounds of a drawing (clamped to the price pane), or null when not drawable. */
  getDrawingBounds(id: string): DrawingScreenBounds | null {
    const drawing = this.drawings.find((candidate) => candidate.id === id);
    if (!drawing || !this.bars.length || !this.panes.length) return null;
    const coords = this.drawingCoords();
    return { ...drawingBounds(drawing, coords, this.theme), plotWidth: this.plotWidth, plotHeight: coords.height };
  }

  deleteSelected(): boolean {
    if (!this.selectedId) return false;
    this.drawings = this.drawings.filter((drawing) => drawing.id !== this.selectedId);
    this.setSelected(null);
    this.callbacks.onDrawingsChange?.(this.drawings);
    this.invalidate();
    return true;
  }

  /** Duplicate the selected drawing a few bars to the right and select the copy. */
  cloneSelected(): boolean {
    const source = this.drawings.find((drawing) => drawing.id === this.selectedId);
    if (!source || !this.bars.length) return false;
    const shift = Math.max(3, Math.round(40 / this.barSpacing));
    const copy: Drawing = {
      ...source,
      id: newDrawingId(),
      locked: false,
      points: source.points.map((point) => ({ t: this.indexToTime(Math.round(this.timeToIndex(point.t)) + shift), p: point.p })),
    };
    this.drawings = [...this.drawings, copy];
    this.callbacks.onDrawingsChange?.(this.drawings);
    this.setSelected(copy.id);
    this.invalidate();
    return true;
  }

  /** Escape: abandon an in-progress drawing, then the active tool, then the selection. */
  cancel(): boolean {
    if (this.pending) {
      this.pending = null;
      this.invalidate();
      return true;
    }
    if (this.tool !== "cursor") {
      this.setTool("cursor");
      this.callbacks.onToolChange?.("cursor");
      return true;
    }
    if (this.selectedId) {
      this.setSelected(null);
      this.invalidate();
      return true;
    }
    return false;
  }

  /** Show another chart's crosshair time (vertical line + time label); null hides it. */
  setExternalCrosshair(time: number | null) {
    if (time === this.externalTime) return;
    this.externalTime = time;
    this.invalidate();
  }

  /** Keyboard pan: positive = towards newer bars. */
  panBy(bars: number) {
    this.rightOffset -= bars;
    this.clampView();
    this.invalidate();
  }

  /** Keyboard zoom around the right edge of the plot: factor > 1 zooms in. */
  zoomBy(factor: number) {
    const anchorX = this.plotWidth;
    const anchorIndex = this.xToIndex(anchorX);
    this.barSpacing = Math.min(MAX_BAR_SPACING, Math.max(MIN_BAR_SPACING, this.barSpacing * factor));
    this.rightOffset = anchorIndex - (this.bars.length - 1) + (this.plotWidth - this.barSpacing / 2 - anchorX) / this.barSpacing;
    this.clampView();
    this.invalidate();
  }

  /** Visible bar count (for keyboard pan step sizes). */
  visibleBarCount() {
    return this.plotWidth > 0 ? this.plotWidth / this.barSpacing : 0;
  }

  /**
   * Render a clean frame (no crosshair/hover) and return it as a PNG data URL,
   * with a header strip carrying `title` (symbol · interval) and `subtitle`.
   */
  snapshot(title: string, subtitle?: string): string {
    const mouse = this.mouse;
    const hovered = this.hoveredId;
    const external = this.externalTime;
    this.mouse = null;
    this.hoveredId = null;
    this.externalTime = null;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.render();
    const header = 30;
    const out = document.createElement("canvas");
    out.width = this.canvas.width;
    out.height = this.canvas.height + Math.round(header * this.dpr);
    const ctx = out.getContext("2d");
    if (ctx) {
      ctx.fillStyle = this.theme.background;
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(this.canvas, 0, Math.round(header * this.dpr));
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = this.theme.axisBorder;
      ctx.fillRect(0, header - 1, this.width, 1);
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillStyle = this.theme.textStrong;
      ctx.font = `600 13px ${this.theme.font.replace(/^[\d.]+px\s*/, "")}`;
      ctx.fillText(title, 10, header / 2);
      if (subtitle) {
        const offset = ctx.measureText(title).width + 18;
        ctx.font = this.theme.font;
        ctx.fillStyle = this.theme.text;
        ctx.fillText(subtitle, 10 + offset, header / 2);
      }
      ctx.textAlign = "right";
      ctx.font = this.theme.font;
      ctx.fillStyle = this.theme.text;
      ctx.fillText("Tradex Charts", this.width - 10, header / 2);
    }
    this.mouse = mouse;
    this.hoveredId = hovered;
    this.externalTime = external;
    this.invalidate();
    return out.toDataURL("image/png");
  }

  private setSelected(id: string | null, reason: "create" | "click" | "other" = "other") {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.callbacks.onSelectionChange?.(id, reason);
  }

  resetView() {
    this.barSpacing = DEFAULT_BAR_SPACING;
    this.rightOffset = DEFAULT_RIGHT_OFFSET;
    for (const pane of this.panes) pane.auto = true;
    this.clampView();
    this.invalidate();
  }

  scrollToRealtime() {
    this.rightOffset = DEFAULT_RIGHT_OFFSET;
    const main = this.panes.find((pane) => pane.id === "main");
    if (main) main.auto = true;
    this.clampView();
    this.invalidate();
  }

  // ---------------------------------------------------------------- derived data

  private rebuildDerived() {
    this.displayBars = this.chartType === "heikin" ? toHeikinAshi(this.bars) : this.bars;
    this.tickWeights = computeTickWeights(this.bars, this.intraday);
    this.indicatorsDirty = true;
    this.dataVersion += 1;
  }

  private recomputeIndicators() {
    const next = new Map<string, Record<string, Series>>();
    const annotations = new Map<string, Annotations>();
    for (const config of this.indicatorConfigs) {
      const def = INDICATORS[config.type];
      try {
        const params = resolveParams(def, config.params);
        next.set(config.id, def.calc(this.bars, params));
        if (def.annotate) annotations.set(config.id, def.annotate(this.bars, params));
      } catch (error) {
        console.warn(`Indicator ${config.type} failed`, error);
      }
    }
    this.indicatorData = next;
    this.annotations = annotations;
    this.indicatorsDirty = false;
    this.lastLegendKey = ""; // param/color edits change values without changing the legend key
  }

  private syncPanes() {
    const previous = new Map(this.panes.map((pane) => [pane.id, pane]));
    const ids = ["main", ...this.indicatorConfigs.filter((c) => !c.hidden && INDICATORS[c.type].pane === "separate").map((c) => c.id)];
    this.panes = ids.map((id) => {
      const existing = previous.get(id);
      if (existing) return existing;
      const config = this.indicatorConfigs.find((c) => c.id === id);
      return { id, def: config ? INDICATORS[config.type] : null, top: 0, height: 0, auto: true, min: 0, max: 1 };
    });
    for (const id of [...this.paneWeights.keys()]) {
      if (!ids.includes(id)) this.paneWeights.delete(id);
    }
  }

  // ---------------------------------------------------------------- layout & coordinates

  private resize() {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(0, Math.floor(rect.width));
    this.height = Math.max(0, Math.floor(rect.height));
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.invalidate();
  }

  private layoutPanes() {
    this.plotWidth = Math.max(0, this.width - this.priceAxisWidth);
    const total = Math.max(0, this.height - TIME_AXIS_HEIGHT);
    const weights = this.panes.map((pane) => this.paneWeights.get(pane.id) ?? (pane.id === "main" ? 3 : 1));
    // Default: main gets 3 parts, each oscillator 1 part; dragged separators override.
    const sum = weights.reduce((acc, weight) => acc + weight, 0) || 1;
    let top = 0;
    this.panes.forEach((pane, index) => {
      const isLast = index === this.panes.length - 1;
      const height = isLast ? total - top : Math.max(MIN_PANE_HEIGHT, Math.round((weights[index] / sum) * total));
      pane.top = top;
      pane.height = Math.max(0, height);
      top += height;
    });
  }

  private get mainPane(): Pane {
    return this.panes[0];
  }

  private indexToX(index: number) {
    return this.plotWidth - (this.bars.length - 1 - index + this.rightOffset) * this.barSpacing - this.barSpacing / 2;
  }

  private xToIndex(x: number) {
    return this.bars.length - 1 + this.rightOffset - (this.plotWidth - this.barSpacing / 2 - x) / this.barSpacing;
  }

  private visibleRange(): [number, number] {
    const n = this.bars.length;
    if (!n) return [0, -1];
    const from = Math.max(0, Math.floor(this.xToIndex(0)) - 1);
    const to = Math.min(n - 1, Math.ceil(this.xToIndex(this.plotWidth)) + 1);
    return [from, to];
  }

  /** Fractional bar index for an arbitrary time (extrapolates past both ends). */
  private timeToIndex(time: number) {
    const bars = this.bars;
    const n = bars.length;
    if (!n) return 0;
    if (time <= bars[0].time) return (time - bars[0].time) / this.intervalMs;
    if (time >= bars[n - 1].time) return n - 1 + (time - bars[n - 1].time) / this.intervalMs;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].time <= time) lo = mid;
      else hi = mid;
    }
    return lo + (time - bars[lo].time) / (bars[hi].time - bars[lo].time);
  }

  private indexToTime(index: number) {
    const bars = this.bars;
    const n = bars.length;
    if (!n) return 0;
    if (index <= 0) return bars[0].time + index * this.intervalMs;
    if (index >= n - 1) return bars[n - 1].time + (index - (n - 1)) * this.intervalMs;
    const lo = Math.floor(index);
    return bars[lo].time + (index - lo) * (bars[lo + 1].time - bars[lo].time);
  }

  private isLog(pane: Pane) {
    return pane.id === "main" && this.scaleMode === "log";
  }

  private toScale(pane: Pane, value: number) {
    return this.isLog(pane) ? Math.log10(Math.max(value, 1e-9)) : value;
  }

  private fromScale(pane: Pane, value: number) {
    return this.isLog(pane) ? 10 ** value : value;
  }

  private valueToY(pane: Pane, value: number) {
    const range = pane.max - pane.min || 1;
    return pane.top + ((pane.max - this.toScale(pane, value)) / range) * pane.height;
  }

  private yToValue(pane: Pane, y: number) {
    const range = pane.max - pane.min || 1;
    return this.fromScale(pane, pane.max - ((y - pane.top) / pane.height) * range);
  }

  private clampView() {
    this.barSpacing = Math.min(MAX_BAR_SPACING, Math.max(MIN_BAR_SPACING, this.barSpacing));
    const n = this.bars.length;
    const visibleSlots = this.plotWidth > 0 ? this.plotWidth / this.barSpacing : 100;
    const maxOffset = Math.max(0, visibleSlots - 3);
    const minOffset = -Math.max(0, n - 3);
    this.rightOffset = Math.min(maxOffset, Math.max(minOffset, this.rightOffset));
  }

  private regionAt(x: number, y: number): Region {
    const plotBottom = this.height - TIME_AXIS_HEIGHT;
    if (y >= plotBottom) return x < this.plotWidth ? { kind: "timeAxis" } : { kind: "none" };
    for (let index = 1; index < this.panes.length; index += 1) {
      const pane = this.panes[index];
      if (Math.abs(y - pane.top) <= 3) return { kind: "separator", upper: this.panes[index - 1], lower: pane };
    }
    const pane = this.panes.find((candidate) => y >= candidate.top && y < candidate.top + candidate.height);
    if (!pane) return { kind: "none" };
    return x >= this.plotWidth ? { kind: "priceAxis", pane } : { kind: "plot", pane };
  }

  private drawingCoords(): DrawingCoords {
    const main = this.mainPane;
    return {
      toX: (time) => this.indexToX(this.timeToIndex(time)),
      toY: (price) => this.valueToY(main, price),
      width: this.plotWidth,
      height: main.top + main.height,
      barSpacing: this.barSpacing,
      barsBetween: (fromTime, toTime) => {
        const n = this.bars.length;
        if (!n) return [];
        const start = Math.max(0, Math.ceil(this.timeToIndex(fromTime) - 1e-6));
        const end = Math.min(n - 1, Math.floor(this.timeToIndex(toTime) + 1e-6));
        return end >= start ? this.bars.slice(start, end + 1) : [];
      },
    };
  }

  /** Pixel → anchor without bar snapping or magnet (freehand brush). */
  private pointToRawAnchor(x: number, y: number): Anchor {
    return { t: this.indexToTime(this.xToIndex(x)), p: this.yToValue(this.mainPane, y) };
  }

  /** Bar index containing `time` (the last bar opening at or before it), or null when off the data. */
  private barIndexAt(time: number): number | null {
    const n = this.bars.length;
    if (!n || time < this.bars[0].time) return null;
    if (time >= this.bars[n - 1].time + this.intervalMs) return null;
    return Math.min(n - 1, Math.floor(this.timeToIndex(time) + 1e-6));
  }

  /** Default stop distance for a new position tool: ~1.5 ATR(14), kept readable on screen. */
  private positionRisk(index: number, price: number) {
    const main = this.mainPane;
    const end = Math.min(this.bars.length - 1, Math.max(0, index));
    let sum = 0;
    let count = 0;
    for (let i = Math.max(1, end - 13); i <= end; i += 1) {
      const bar = this.bars[i];
      const prev = this.bars[i - 1].close;
      sum += Math.max(bar.high - bar.low, Math.abs(bar.high - prev), Math.abs(bar.low - prev));
      count += 1;
    }
    const atr = count ? sum / count : price * 0.01;
    const visible = Math.abs(this.fromScale(main, main.max) - this.fromScale(main, main.min)) || price * 0.05;
    return Math.min(visible * 0.2, Math.max(visible * 0.05, atr * 1.5));
  }

  /** Pixel → drawing anchor, snapped to the nearest bar (and OHLC with magnet on). */
  private pointToAnchor(x: number, y: number): Anchor {
    const main = this.mainPane;
    const index = Math.round(this.xToIndex(x));
    let price = this.yToValue(main, y);
    const bar = this.bars[index];
    if (this.magnet && bar) {
      let best = price;
      let bestDistance = 28;
      for (const candidate of [bar.open, bar.high, bar.low, bar.close]) {
        const distance = Math.abs(this.valueToY(main, candidate) - y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
      price = best;
    }
    return { t: this.indexToTime(index), p: price };
  }

  // ---------------------------------------------------------------- autoscale

  /**
   * Series index range whose points land in view for an output shifted by
   * `offset` bars (value i is drawn at bar i + offset). Unshifted outputs use the
   * clamped visible range; shifted ones use the raw x range so forward-shifted
   * values can occupy the empty area right of the last bar.
   */
  private offsetSourceRange(offset: number, from: number, to: number): [number, number] {
    if (!offset) return [from, to];
    const rawFrom = Math.floor(this.xToIndex(0)) - 1;
    const rawTo = Math.ceil(this.xToIndex(this.plotWidth)) + 1;
    return [Math.max(0, rawFrom - offset), Math.min(this.bars.length - 1, rawTo - offset)];
  }

  private autoscale(pane: Pane, from: number, to: number) {
    if (!pane.auto) return;
    let min = Infinity;
    let max = -Infinity;

    if (pane.id === "main") {
      const lineOnly = this.chartType === "line" || this.chartType === "area";
      for (let i = from; i <= to; i += 1) {
        const bar = this.displayBars[i];
        const low = lineOnly ? bar.close : bar.low;
        const high = lineOnly ? bar.close : bar.high;
        if (low < min) min = low;
        if (high > max) max = high;
      }
      // Keep a shown trade plan's stop and target on screen (only when its zone is in view).
      // Skipped when the plan is nowhere near the prices in view (stale levels, other data source).
      const plan = this.tradePlan;
      const near = plan && Number.isFinite(min) && plan.entry >= min * 0.7 && plan.entry <= max * 1.3;
      if (plan && near && this.bars.length && this.timeToIndex(plan.time) <= to + 1) {
        for (const level of [plan.stop, plan.target ?? plan.entry]) {
          if (level < min) min = level;
          if (level > max) max = level;
        }
      }
      for (const config of this.indicatorConfigs) {
        const def = INDICATORS[config.type];
        if (config.hidden || def.pane !== "overlay") continue;
        const data = this.indicatorData.get(config.id);
        if (!data) continue;
        const params = resolveParams(def, config.params);
        for (const output of def.outputs) {
          const series = data[output.key];
          if (!series || output.noAutoscale) continue;
          // Shifted outputs (Ichimoku) are scaled by what is drawn in view, incl. the future area.
          const [start, end] = this.offsetSourceRange(outputOffset(output, params), from, to);
          for (let i = start; i <= end; i += 1) {
            const value = series[i];
            if (Number.isNaN(value)) continue;
            if (value < min) min = value;
            if (value > max) max = value;
          }
        }
      }
    } else if (pane.def?.bounds) {
      [min, max] = pane.def.bounds;
    } else {
      const data = this.indicatorData.get(pane.id);
      if (data && pane.def) {
        for (const output of pane.def.outputs) {
          const series = data[output.key];
          if (!series) continue;
          if (output.style === "histogram") {
            min = Math.min(min, 0);
            max = Math.max(max, 0);
          }
          for (let i = from; i <= to; i += 1) {
            const value = series[i];
            if (Number.isNaN(value)) continue;
            if (value < min) min = value;
            if (value > max) max = value;
          }
        }
      }
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0;
      max = 1;
    }
    let lo = this.toScale(pane, min);
    let hi = this.toScale(pane, max);
    if (hi - lo < 1e-9) {
      const pad = Math.abs(hi) * 0.01 || 1;
      lo -= pad;
      hi += pad;
    }
    const range = hi - lo;
    const topMargin = pane.id === "main" ? 0.1 : 0.12;
    const bottomMargin = pane.id === "main" ? (this.showVolume ? 0.16 : 0.08) : 0.12;
    pane.min = lo - range * bottomMargin;
    pane.max = hi + range * topMargin;
  }

  private priceTicks(pane: Pane): number[] {
    const targetCount = Math.max(2, Math.floor(pane.height / 42));
    const lo = this.fromScale(pane, pane.min);
    const hi = this.fromScale(pane, pane.max);
    const step = niceStep((hi - lo) / targetCount);
    if (!Number.isFinite(step) || step <= 0) return [];
    const ticks: number[] = [];
    let lastY = Infinity;
    for (let k = Math.ceil(lo / step); k * step <= hi; k += 1) {
      const value = Number((k * step).toPrecision(12));
      const y = this.valueToY(pane, value);
      if (y < pane.top + 6 || y > pane.top + pane.height - 6) continue;
      if (Math.abs(lastY - y) < 20) continue; // log scale bunches ticks at the low end
      ticks.push(value);
      lastY = y;
    }
    return ticks;
  }

  private timeTicks(from: number, to: number): Array<{ index: number; weight: number }> {
    const minGap = this.intraday ? 64 : 56;
    const candidates: Array<{ index: number; weight: number }> = [];
    for (let i = from; i <= to; i += 1) {
      const weight = this.tickWeights[i];
      if (weight > 0) candidates.push({ index: i, weight });
    }
    candidates.sort((a, b) => b.weight - a.weight || a.index - b.index);
    const placed: Array<{ index: number; weight: number; x: number }> = [];
    for (const candidate of candidates) {
      const x = this.indexToX(candidate.index);
      if (x < 16 || x > this.plotWidth - 16) continue;
      if (placed.every((other) => Math.abs(other.x - x) >= minGap)) placed.push({ ...candidate, x });
    }
    return placed.sort((a, b) => a.index - b.index);
  }

  // ---------------------------------------------------------------- render loop

  private invalidate() {
    if (this.destroyed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render() {
    if (this.indicatorsDirty) this.recomputeIndicators();
    const ctx = this.ctx;
    const theme = this.theme;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.font = theme.font;
    if (!this.width || !this.height || !this.panes.length) return;

    // The axis width depends on label text, which depends on the scale. Lay out,
    // scale, measure, and re-lay out once if the width changed.
    this.layoutPanes();
    let [from, to] = this.visibleRange();
    if (to >= from) for (const pane of this.panes) this.autoscale(pane, from, to);
    const measured = this.measurePriceAxis();
    if (measured !== this.priceAxisWidth) {
      this.priceAxisWidth = measured;
      this.layoutPanes();
      [from, to] = this.visibleRange();
      if (to >= from) for (const pane of this.panes) this.autoscale(pane, from, to);
    }

    const timeTicks = to >= from ? this.timeTicks(from, to) : [];

    for (const pane of this.panes) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, pane.top, this.plotWidth, pane.height);
      ctx.clip();
      this.drawGrid(pane, timeTicks);
      if (to >= from && this.intraday) this.drawSessionBreaks(pane, from, to);
      if (to >= from) {
        if (pane.id === "main") this.drawMainPane(pane, from, to);
        else this.drawIndicatorPane(pane, from, to);
      }
      ctx.restore();
    }

    this.drawSeparators();
    this.drawPriceAxis();
    this.drawTimeAxis(timeTicks);
    this.drawCrosshair();
    this.emitLegend();
  }

  private measurePriceAxis() {
    const main = this.mainPane;
    let widest = 0;
    // Measure with the same formatter the axis draws with (Indian digit grouping adds commas).
    const samples: Array<[Pane, number]> = [
      [main, this.fromScale(main, main.max)],
      [main, this.fromScale(main, main.min)],
    ];
    const last = this.bars[this.bars.length - 1];
    if (last) samples.push([main, last.close]);
    for (const pane of this.panes.slice(1)) {
      samples.push([pane, pane.max], [pane, pane.min]);
    }
    for (const [pane, value] of samples) {
      widest = Math.max(widest, this.ctx.measureText(this.formatPaneValue(pane, value)).width);
    }
    return Math.max(MIN_PRICE_AXIS_WIDTH, Math.ceil(widest + 20));
  }

  private drawGrid(pane: Pane, timeTicks: Array<{ index: number }>) {
    const ctx = this.ctx;
    ctx.strokeStyle = this.theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const value of this.priceTicks(pane)) {
      const y = Math.round(this.valueToY(pane, value)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(this.plotWidth, y);
    }
    for (const tick of timeTicks) {
      const x = Math.round(this.indexToX(tick.index)) + 0.5;
      ctx.moveTo(x, pane.top);
      ctx.lineTo(x, pane.top + pane.height);
    }
    ctx.stroke();
  }

  /** Intraday: a faint dashed line between the last bar of one IST day and the first of the next. */
  private drawSessionBreaks(pane: Pane, from: number, to: number) {
    if (this.barSpacing * 3 < 1) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = SESSION_BREAK_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    for (let i = Math.max(1, from); i <= to; i += 1) {
      if (this.tickWeights[i] < 40) continue; // 40+ = new day (or month/year)
      const x = Math.round(this.indexToX(i) - this.barSpacing / 2) + 0.5;
      ctx.moveTo(x, pane.top);
      ctx.lineTo(x, pane.top + pane.height);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawMainPane(pane: Pane, from: number, to: number) {
    if (this.showVolume) this.drawVolume(pane, from, to);
    const annotationCoords = this.annotationCoords(pane, from, to);
    const visibleAnnotations = this.indicatorConfigs
      .filter((config) => !config.hidden && this.annotations.has(config.id))
      .map((config) => this.annotations.get(config.id) as Annotations);
    for (const ann of visibleAnnotations) renderAnnotationBoxes(this.ctx, ann, annotationCoords);
    this.drawOverlayFills(pane, from, to);
    this.drawSeries(pane, from, to);
    for (const config of this.indicatorConfigs) {
      if (config.hidden || INDICATORS[config.type].pane !== "overlay") continue;
      this.drawIndicatorOutputs(pane, config, from, to);
    }
    // The plan's labels claim space first; pattern / S/R labels then skip anything they'd overlap.
    this.drawTradePlan(pane, annotationCoords.placed);
    this.drawAlertLines(pane, annotationCoords.placed);
    for (const ann of visibleAnnotations) renderAnnotationMarks(this.ctx, ann, annotationCoords);
    this.drawLastPriceLine(pane);
    this.drawDrawings();
  }

  private drawAlertLines(pane: Pane, placedRects: Array<[number, number, number, number]>) {
    if (!this.alertLines.length || !this.bars.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = this.theme.font;
    ctx.textBaseline = "middle";
    for (const alert of this.alertLines) {
      const y = Math.round(this.valueToY(pane, alert.price)) + 0.5;
      if (y < pane.top || y > pane.top + pane.height) continue;
      ctx.strokeStyle = withAlpha(ALERT_COLOR, 0.85);
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.plotWidth, y);
      ctx.stroke();
      ctx.setLineDash([]);
      const text = `🔔 ${alert.label}`;
      const width = ctx.measureText(text).width + 10;
      const rect: [number, number, number, number] = [8, y - 18, 8 + width, y - 2];
      if (placedRects.some(([x1, y1, x2, y2]) => rect[0] < x2 && rect[2] > x1 && rect[1] < y2 && rect[3] > y1)) continue;
      placedRects.push(rect);
      ctx.fillStyle = withAlpha(this.theme.background, 0.88);
      ctx.beginPath();
      ctx.roundRect(rect[0], rect[1], width, 16, 3);
      ctx.fill();
      ctx.fillStyle = ALERT_COLOR;
      ctx.textAlign = "left";
      ctx.fillText(text, rect[0] + 5, y - 9.5);
    }
    ctx.restore();
  }

  /** TradingView-style position zones for the screener plan: green to the target, red to the stop. */
  private drawTradePlan(pane: Pane, placedRects: Array<[number, number, number, number]>) {
    const plan = this.tradePlan;
    if (!plan || !this.bars.length) return;
    const ctx = this.ctx;
    const startX = Math.max(0, this.indexToX(Math.round(this.timeToIndex(plan.time))) - this.barSpacing / 2);
    if (startX >= this.plotWidth) return;
    const right = this.plotWidth;
    const yEntry = Math.round(this.valueToY(pane, plan.entry)) + 0.5;
    const yStop = Math.round(this.valueToY(pane, plan.stop)) + 0.5;
    const yTarget = plan.target !== null ? Math.round(this.valueToY(pane, plan.target)) + 0.5 : null;
    const up = this.theme.up;
    const down = this.theme.down;
    const pct = (price: number) => `${price >= plan.entry ? "+" : ""}${(((price - plan.entry) / plan.entry) * 100).toFixed(2)}%`;
    const risk = plan.entry - plan.stop;

    ctx.save();
    if (yTarget !== null) {
      ctx.fillStyle = withAlpha(up, 0.13);
      ctx.fillRect(startX, Math.min(yTarget, yEntry), right - startX, Math.abs(yEntry - yTarget));
    }
    ctx.fillStyle = withAlpha(down, 0.13);
    ctx.fillRect(startX, Math.min(yStop, yEntry), right - startX, Math.abs(yStop - yEntry));

    const line = (y: number, color: string, dash: number[]) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    };
    line(yEntry, this.theme.textStrong, plan.buyStop ? [5, 3] : []);
    line(yStop, down, []);
    if (yTarget !== null) line(yTarget, up, []);
    ctx.setLineDash([]);

    // Labels on small pills at the zone's right edge. They claim space in the frame's shared label
    // list (seeded with the legend), moving away from their line until they find a free spot.
    ctx.font = this.theme.font;
    ctx.textBaseline = "middle";
    const overlaps = (r: [number, number, number, number]) => placedRects.some(([x1, y1, x2, y2]) => r[0] < x2 && r[2] > x1 && r[1] < y2 && r[3] > y1);
    const tag = (y: number, text: string, color: string, below: boolean) => {
      const width = ctx.measureText(text).width + 10;
      const x = Math.max(2, right - width - 4);
      const step = below ? 17 : -17;
      let top = below ? y + 3 : y - 19;
      for (let tries = 0; tries < 8 && overlaps([x, top, x + width, top + 16]); tries += 1) top += step;
      // Ran off the top of the pane: flip below the line instead.
      if (top < pane.top + 2) {
        top = y + 3;
        for (let tries = 0; tries < 8 && overlaps([x, top, x + width, top + 16]); tries += 1) top += 17;
      }
      placedRects.push([x, top, x + width, top + 16]);
      ctx.fillStyle = withAlpha(this.theme.background, 0.88);
      ctx.beginPath();
      ctx.roundRect(x, top, width, 16, 3);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.textAlign = "left";
      ctx.fillText(text, x + 5, top + 8.5);
    };
    const rr = plan.target !== null && risk > 0 ? ((plan.target - plan.entry) / risk).toFixed(1) : null;
    if (yTarget !== null && plan.target !== null) tag(yTarget, `Target ${formatPrice(plan.target)} (${pct(plan.target)})${rr ? ` · ${rr}R` : ""}`, up, yTarget > yEntry);
    tag(yEntry, `${plan.buyStop ? "Buy above" : "Entry"} ${formatPrice(plan.entry)} · ${plan.label}`, this.theme.textStrong, yTarget !== null && yTarget < yEntry);
    tag(yStop, `Stop ${formatPrice(plan.stop)} (${pct(plan.stop)})`, down, yStop > yEntry);
    ctx.restore();
  }

  private annotationCoords(pane: Pane, from: number, to: number): AnnotationCoords {
    return {
      x: (index) => this.indexToX(index),
      y: (price) => this.valueToY(pane, price),
      right: this.plotWidth,
      from,
      to,
      font: this.theme.font,
      // The legend's and the toolbar's areas count as already taken.
      placed:
        pane.id === "main"
          ? [
              ...(this.legendBox.height > 0 ? [[0, pane.top, this.legendBox.width + 8, pane.top + this.legendBox.height + 6] as [number, number, number, number]] : []),
              ...(this.toolbarBox.height > 0
                ? [[this.plotWidth - this.toolbarBox.width - 12, pane.top, this.plotWidth, pane.top + this.toolbarBox.height + 10] as [number, number, number, number]]
                : []),
            ]
          : [],
      skipLevels: Boolean(this.tradePlan),
    };
  }

  private drawVolume(pane: Pane, from: number, to: number) {
    const ctx = this.ctx;
    let maxVolume = 0;
    for (let i = from; i <= to; i += 1) maxVolume = Math.max(maxVolume, this.bars[i].volume);
    if (maxVolume <= 0) return;
    const areaHeight = pane.height * VOLUME_PANE_RATIO;
    const bottom = pane.top + pane.height;
    const width = Math.max(1, Math.floor(this.barSpacing * 0.75));
    const up = new Path2D();
    const down = new Path2D();
    for (let i = from; i <= to; i += 1) {
      const bar = this.bars[i];
      const height = Math.max(1, (bar.volume / maxVolume) * areaHeight);
      const x = Math.round(this.indexToX(i)) - Math.floor(width / 2);
      (bar.close >= bar.open ? up : down).rect(x, bottom - height, width, height);
    }
    ctx.fillStyle = this.theme.upVolume;
    ctx.fill(up);
    ctx.fillStyle = this.theme.downVolume;
    ctx.fill(down);
  }

  private drawSeries(pane: Pane, from: number, to: number) {
    const ctx = this.ctx;
    const theme = this.theme;
    const bars = this.displayBars;

    if (this.chartType === "line" || this.chartType === "area") {
      ctx.beginPath();
      for (let i = from; i <= to; i += 1) {
        const x = this.indexToX(i);
        const y = this.valueToY(pane, bars[i].close);
        if (i === from) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      if (this.chartType === "area") {
        const bottom = pane.top + pane.height;
        const gradient = ctx.createLinearGradient(0, pane.top, 0, bottom);
        gradient.addColorStop(0, theme.areaTop);
        gradient.addColorStop(1, theme.areaBottom);
        ctx.save();
        ctx.lineTo(this.indexToX(to), bottom);
        ctx.lineTo(this.indexToX(from), bottom);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();
        ctx.restore();
        ctx.beginPath();
        for (let i = from; i <= to; i += 1) {
          const x = this.indexToX(i);
          const y = this.valueToY(pane, bars[i].close);
          if (i === from) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = theme.line;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.stroke();
      return;
    }

    const bodyWidth = Math.max(1, Math.floor(this.barSpacing * 0.75));
    const half = Math.floor(bodyWidth / 2);
    const upFill = new Path2D();
    const downFill = new Path2D();
    const upStroke = new Path2D();

    for (let i = from; i <= to; i += 1) {
      const bar = bars[i];
      const up = bar.close >= bar.open;
      const x = Math.round(this.indexToX(i));
      const yHigh = Math.round(this.valueToY(pane, bar.high));
      const yLow = Math.round(this.valueToY(pane, bar.low));
      const yOpen = Math.round(this.valueToY(pane, bar.open));
      const yClose = Math.round(this.valueToY(pane, bar.close));
      const target = up ? upFill : downFill;

      if (this.chartType === "bars") {
        const tick = Math.max(1, half);
        target.rect(x, yHigh, 1, Math.max(1, yLow - yHigh));
        target.rect(x - tick, yOpen, tick, 1);
        target.rect(x + 1, yClose, tick, 1);
        continue;
      }

      const top = Math.min(yOpen, yClose);
      const height = Math.max(1, Math.abs(yClose - yOpen));
      if (this.chartType === "hollow" && up && bodyWidth >= 3) {
        // Wick above and below a hollow body.
        if (top > yHigh) upFill.rect(x, yHigh, 1, top - yHigh);
        if (yLow > top + height) upFill.rect(x, top + height, 1, yLow - top - height);
        upStroke.rect(x - half + 0.5, top + 0.5, bodyWidth - 1, Math.max(1, height - 1));
        continue;
      }
      target.rect(x, yHigh, 1, Math.max(1, yLow - yHigh));
      if (bodyWidth >= 2) target.rect(x - half, top, bodyWidth, height);
    }

    ctx.fillStyle = theme.up;
    ctx.fill(upFill);
    ctx.fillStyle = theme.down;
    ctx.fill(downFill);
    ctx.strokeStyle = theme.up;
    ctx.lineWidth = 1;
    ctx.stroke(upStroke);
  }

  private drawOverlayFills(pane: Pane, from: number, to: number) {
    for (const config of this.indicatorConfigs) {
      const def = INDICATORS[config.type];
      if (config.hidden || def.pane !== "overlay" || !def.fill) continue;
      this.drawBandFill(pane, config, def, from, to);
    }
  }

  private drawBandFill(pane: Pane, config: IndicatorConfig, def: IndicatorDef, from: number, to: number) {
    const data = this.indicatorData.get(config.id);
    const fill = def.fill;
    if (!data || !fill) return;
    const upper = data[fill.from];
    const lower = data[fill.to];
    if (!upper || !lower) return;
    const ctx = this.ctx;
    const edge = def.outputs.find((output) => output.key === fill.from);
    const offset = edge ? outputOffset(edge, resolveParams(def, config.params)) : 0;
    const [first, last] = this.offsetSourceRange(offset, Math.max(0, from - 1), Math.min(this.bars.length - 1, to + 1));
    const xAt = (i: number) => this.indexToX(i + offset);
    const yAt = (value: number) => this.valueToY(pane, value);
    const tint = (color: string, alpha: number) => (color.startsWith("#") ? withAlpha(color, alpha) : color);
    const color = config.colors[fill.from] ?? def.outputs[0].color;

    if (edge?.style === "levels") {
      // Stepped band (CPR, opening range): one rectangle per run of constant edges, no slope between days.
      ctx.fillStyle = tint(color, 0.08);
      const half = this.barSpacing / 2;
      let run = -1;
      for (let i = first; i <= last + 1; i += 1) {
        const valid = i <= last && !Number.isNaN(upper[i]) && !Number.isNaN(lower[i]);
        const continues = valid && run >= 0 && upper[i] === upper[run] && lower[i] === lower[run];
        if (run >= 0 && !continues) {
          const top = yAt(upper[run]);
          const bottom = yAt(lower[run]);
          ctx.fillRect(xAt(run) - half, Math.min(top, bottom), xAt(i - 1) - xAt(run) + 2 * half, Math.abs(bottom - top));
          run = -1;
        }
        if (valid && run < 0) run = i;
      }
      return;
    }

    if (fill.upColor && fill.downColor) {
      // Two-tone cloud (Ichimoku): per-bar trapezoids, split at crossovers so the color flips exactly there.
      const up = new Path2D();
      const down = new Path2D();
      const polygon = (path: Path2D, points: Array<[number, number]>) => {
        path.moveTo(points[0][0], points[0][1]);
        for (let k = 1; k < points.length; k += 1) path.lineTo(points[k][0], points[k][1]);
        path.closePath();
      };
      for (let i = first; i < last; i += 1) {
        const a0 = upper[i];
        const b0 = lower[i];
        const a1 = upper[i + 1];
        const b1 = lower[i + 1];
        if (Number.isNaN(a0) || Number.isNaN(b0) || Number.isNaN(a1) || Number.isNaN(b1)) continue;
        const x0 = xAt(i);
        const x1 = xAt(i + 1);
        const d0 = a0 - b0;
        const d1 = a1 - b1;
        if (d0 * d1 >= 0) {
          polygon(d0 + d1 >= 0 ? up : down, [[x0, yAt(a0)], [x1, yAt(a1)], [x1, yAt(b1)], [x0, yAt(b0)]]);
          continue;
        }
        const t = d0 / (d0 - d1);
        const cross: [number, number] = [x0 + t * (x1 - x0), yAt(a0 + t * (a1 - a0))];
        polygon(d0 > 0 ? up : down, [[x0, yAt(a0)], cross, [x0, yAt(b0)]]);
        polygon(d1 > 0 ? up : down, [cross, [x1, yAt(a1)], [x1, yAt(b1)]]);
      }
      ctx.fillStyle = tint(fill.upColor, 0.16);
      ctx.fill(up);
      ctx.fillStyle = tint(fill.downColor, 0.16);
      ctx.fill(down);
      return;
    }

    ctx.fillStyle = tint(color, 0.07);
    let start = -1;
    const flush = (end: number) => {
      if (start < 0) return;
      ctx.beginPath();
      for (let i = start; i <= end; i += 1) ctx.lineTo(xAt(i), yAt(upper[i]));
      for (let i = end; i >= start; i -= 1) ctx.lineTo(xAt(i), yAt(lower[i]));
      ctx.closePath();
      ctx.fill();
      start = -1;
    };
    for (let i = first; i <= last; i += 1) {
      const valid = !Number.isNaN(upper[i]) && !Number.isNaN(lower[i]);
      if (valid && start < 0) start = i;
      if (!valid) flush(i - 1);
    }
    flush(last);
  }

  private drawIndicatorPane(pane: Pane, from: number, to: number) {
    const ctx = this.ctx;
    const config = this.indicatorConfigs.find((candidate) => candidate.id === pane.id);
    if (!config || !pane.def) return;

    if (pane.def.levels) {
      ctx.save();
      ctx.strokeStyle = "rgba(138, 147, 166, 0.35)";
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const level of pane.def.levels) {
        const y = Math.round(this.valueToY(pane, level)) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(this.plotWidth, y);
      }
      ctx.stroke();
      ctx.restore();
      if (pane.def.bounds && pane.def.levels.length >= 2) {
        // Shade the "normal" band between the outer levels (RSI 30–70, Stoch 20–80).
        const levels = [...pane.def.levels].sort((a, b) => a - b);
        const top = this.valueToY(pane, levels[levels.length - 1]);
        const bottom = this.valueToY(pane, levels[0]);
        ctx.fillStyle = withAlpha(config.colors[pane.def.outputs[0].key] ?? pane.def.outputs[0].color, 0.06);
        ctx.fillRect(0, top, this.plotWidth, bottom - top);
      }
    }
    this.drawIndicatorOutputs(pane, config, from, to);
  }

  private drawIndicatorOutputs(pane: Pane, config: IndicatorConfig, from: number, to: number) {
    const def = INDICATORS[config.type];
    const data = this.indicatorData.get(config.id);
    if (!data) return;
    const ctx = this.ctx;
    const params = resolveParams(def, config.params);
    const visibleFrom = Math.max(0, from - 1);
    const visibleTo = Math.min(this.bars.length - 1, to + 1);
    const labels: Array<{ x: number; y: number }> = [];

    for (const output of def.outputs) {
      const series = data[output.key];
      if (!series) continue;
      const color = config.colors[output.key] ?? output.color;
      // Value i is drawn at bar i + offset (Ichimoku spans run into the future area).
      const offset = outputOffset(output, params);
      const [start, end] = this.offsetSourceRange(offset, visibleFrom, visibleTo);
      const xAt = (i: number) => this.indexToX(i + offset);

      if (output.style === "levels") {
        this.drawLevelSegments(pane, output, series, start, end, offset, color, labels);
        continue;
      }

      if (output.style === "dots") {
        const radius = Math.max(1.25, Math.min(3, this.barSpacing * 0.2));
        const dots = new Path2D();
        for (let i = start; i <= end; i += 1) {
          const value = series[i];
          if (Number.isNaN(value)) continue;
          const x = xAt(i);
          const y = this.valueToY(pane, value);
          dots.moveTo(x + radius, y);
          dots.arc(x, y, radius, 0, Math.PI * 2);
        }
        ctx.fillStyle = color;
        ctx.fill(dots);
        continue;
      }

      if (output.style === "histogram") {
        const zeroY = this.valueToY(pane, 0);
        const width = Math.max(1, Math.floor(this.barSpacing * 0.6));
        const positive = new Path2D();
        const negative = new Path2D();
        for (let i = start; i <= end; i += 1) {
          const value = series[i];
          if (Number.isNaN(value)) continue;
          const x = Math.round(xAt(i)) - Math.floor(width / 2);
          const y = this.valueToY(pane, value);
          (value >= 0 ? positive : negative).rect(x, Math.min(y, zeroY), width, Math.max(1, Math.abs(zeroY - y)));
        }
        ctx.save();
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = color;
        ctx.fill(positive);
        ctx.fillStyle = config.colors[`${output.key}Neg`] ?? output.negColor ?? color;
        ctx.fill(negative);
        ctx.restore();
        continue;
      }

      ctx.beginPath();
      let drawing = false;
      for (let i = start; i <= end; i += 1) {
        const value = series[i];
        if (Number.isNaN(value)) {
          drawing = false;
          continue;
        }
        const x = xAt(i);
        const y = this.valueToY(pane, value);
        if (drawing) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        drawing = true;
      }
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = output.width ?? 1.5;
      ctx.lineJoin = "round";
      if (output.dash) ctx.setLineDash(output.dash);
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * "levels" style: a flat segment per run of equal values (one trading day of
   * a pivot/CPR level), spanning the run's bars edge to edge. Runs never connect,
   * so day-to-day changes show as breaks, not slopes. Wide segments get a small
   * label (R1, TC, PDH…) at their left end, skipping ones that would collide.
   */
  private drawLevelSegments(
    pane: Pane,
    output: OutputDef,
    series: Series,
    start: number,
    end: number,
    offset: number,
    color: string,
    labels: Array<{ x: number; y: number }>,
  ) {
    const ctx = this.ctx;
    const half = this.barSpacing / 2;
    const segments: Array<[number, number]> = [];
    let run = -1;
    for (let i = start; i <= end + 1; i += 1) {
      const valid = i <= end && !Number.isNaN(series[i]);
      const continues = valid && run >= 0 && series[i] === series[run];
      if (run >= 0 && !continues) {
        segments.push([run, i - 1]);
        run = -1;
      }
      if (valid && run < 0) run = i;
    }
    if (!segments.length) return;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = output.width ?? 1;
    if (output.dash) ctx.setLineDash(output.dash);
    ctx.beginPath();
    for (const [a, b] of segments) {
      const y = Math.round(this.valueToY(pane, series[a])) + 0.5;
      ctx.moveTo(this.indexToX(a + offset) - half, y);
      ctx.lineTo(this.indexToX(b + offset) + half, y);
    }
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = this.theme.font;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    for (const [a, b] of segments) {
      const left = Math.max(0, this.indexToX(a + offset) - half);
      const right = Math.min(this.plotWidth, this.indexToX(b + offset) + half);
      if (right - left < 56) continue;
      const x = left + 4;
      const y = this.valueToY(pane, series[a]) - 2;
      if (labels.some((label) => Math.abs(label.x - x) < 40 && Math.abs(label.y - y) < 11)) continue;
      labels.push({ x, y });
      ctx.fillText(output.label, x, y);
    }
    ctx.restore();
  }

  private drawLastPriceLine(pane: Pane) {
    const last = this.bars[this.bars.length - 1];
    if (!last) return;
    const ctx = this.ctx;
    const y = Math.round(this.valueToY(pane, last.close)) + 0.5;
    ctx.save();
    ctx.strokeStyle = last.close >= last.open ? this.theme.up : this.theme.down;
    ctx.globalAlpha = 0.8;
    ctx.setLineDash([1, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(this.plotWidth, y);
    ctx.stroke();
    ctx.restore();
  }

  private drawDrawings() {
    if (!this.bars.length || !this.drawingsVisible) return;
    const coords = this.drawingCoords();
    for (const drawing of this.drawings) {
      if (drawing.hidden) continue;
      renderDrawing(this.ctx, drawing, coords, this.theme, {
        selected: drawing.id === this.selectedId,
        hovered: drawing.id === this.hoveredId,
      });
    }
    if (this.pending) {
      renderDrawing(this.ctx, this.pending.drawing, coords, this.theme, { selected: true, hovered: false });
    }
  }

  private drawSeparators() {
    const ctx = this.ctx;
    ctx.fillStyle = this.theme.axisBorder;
    for (const pane of this.panes.slice(1)) ctx.fillRect(0, pane.top, this.width, 1);
    ctx.fillRect(this.plotWidth, 0, 1, this.height - TIME_AXIS_HEIGHT);
    ctx.fillRect(0, this.height - TIME_AXIS_HEIGHT, this.width, 1);
  }

  private drawAxisTag(y: number, text: string, background: string, color: string) {
    const ctx = this.ctx;
    const height = 18;
    ctx.fillStyle = background;
    ctx.beginPath();
    ctx.roundRect(this.plotWidth + 1, y - height / 2, this.priceAxisWidth - 2, height, 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, this.plotWidth + 8, y + 0.5);
  }

  private formatPaneValue(pane: Pane, value: number) {
    if (pane.id === "main") return formatPrice(value);
    return pane.def?.compact ? formatCompact(value) : formatValue(value);
  }

  /**
   * Price-axis tags without overlaps (TradingView-style): tags are placed in priority order — the last
   * price never moves — and each later tag slides to the nearest free slot. Tick labels a tag covers
   * are hidden instead of being drawn underneath it.
   */
  private drawPriceAxis() {
    const ctx = this.ctx;
    const TAG = 18;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const pane of this.panes) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(this.plotWidth, pane.top, this.priceAxisWidth, pane.height);
      ctx.clip();

      const tags: Array<{ y: number; text: string; bg: string; fg: string; priority: number }> = [];
      if (pane.id === "main") {
        const last = this.bars[this.bars.length - 1];
        if (last) tags.push({ y: this.valueToY(pane, last.close), text: formatPrice(last.close), bg: last.close >= last.open ? this.theme.up : this.theme.down, fg: "#fff", priority: 0 });
        if (this.tradePlan) {
          const plan = this.tradePlan;
          if (plan.target !== null) tags.push({ y: this.valueToY(pane, plan.target), text: formatPrice(plan.target), bg: this.theme.up, fg: "#fff", priority: 1 });
          tags.push({ y: this.valueToY(pane, plan.stop), text: formatPrice(plan.stop), bg: this.theme.down, fg: "#fff", priority: 1 });
          // The entry usually equals the last price at the close; one tag is enough then.
          if (!last || Math.abs(plan.entry - last.close) > plan.entry * 0.0005) {
            tags.push({ y: this.valueToY(pane, plan.entry), text: formatPrice(plan.entry), bg: this.theme.crosshairLabel, fg: this.theme.textStrong, priority: 2 });
          }
        }
        for (const alert of this.alertLines) tags.push({ y: this.valueToY(pane, alert.price), text: formatPrice(alert.price), bg: ALERT_COLOR, fg: "#1b1300", priority: 2 });
        if (this.drawingsVisible) {
          for (const drawing of this.drawings) {
            const active = drawing.id === this.selectedId || drawing.id === this.hoveredId;
            for (const level of axisLabels(drawing, active, this.theme)) {
              tags.push({ y: this.valueToY(pane, level.price), text: formatPrice(level.price), bg: level.color, fg: "#fff", priority: active ? 1 : 3 });
            }
          }
        }
      } else {
        // Latest value tag for each line output of the indicator.
        const config = this.indicatorConfigs.find((candidate) => candidate.id === pane.id);
        const data = this.indicatorData.get(pane.id);
        if (config && data && pane.def) {
          for (const output of pane.def.outputs) {
            if (output.style !== "line") continue;
            const series = data[output.key];
            const value = series?.[series.length - 1];
            if (value === undefined || Number.isNaN(value)) continue;
            tags.push({ y: this.valueToY(pane, value), text: this.formatPaneValue(pane, value), bg: config.colors[output.key] ?? output.color, fg: "#fff", priority: 1 });
          }
        }
      }

      // Place by priority; slide each tag to the nearest free slot within the pane.
      const placed: number[] = [];
      const free = (y: number) => placed.every((other) => Math.abs(other - y) >= TAG + 1);
      const laid = tags
        .filter((tag) => Number.isFinite(tag.y))
        .sort((a, b) => a.priority - b.priority)
        .map((tag) => {
          let y = tag.y;
          if (!free(y)) {
            for (let step = 1; step < 12; step += 1) {
              const up = tag.y - step * (TAG / 2);
              const down = tag.y + step * (TAG / 2);
              if (free(down) && down < pane.top + pane.height - TAG / 2) {
                y = down;
                break;
              }
              if (free(up) && up > pane.top + TAG / 2) {
                y = up;
                break;
              }
            }
          }
          placed.push(y);
          return { ...tag, y };
        });

      ctx.fillStyle = this.theme.text;
      for (const value of this.priceTicks(pane)) {
        const y = this.valueToY(pane, value);
        if (laid.some((tag) => Math.abs(tag.y - y) < TAG / 2 + 5)) continue;
        ctx.fillText(this.formatPaneValue(pane, value), this.plotWidth + 8, y);
      }
      // Draw low priority first so the most important tag ends up on top.
      for (const tag of [...laid].reverse()) this.drawAxisTag(tag.y, tag.text, tag.bg, tag.fg);
      ctx.restore();
    }
  }

  private drawTimeAxis(ticks: Array<{ index: number; weight: number }>) {
    const ctx = this.ctx;
    const y = this.height - TIME_AXIS_HEIGHT / 2;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const tick of ticks) {
      const bar = this.bars[tick.index];
      ctx.fillStyle = tick.weight >= 50 ? this.theme.textStrong : this.theme.text;
      ctx.font = tick.weight >= 50 ? `600 ${this.theme.font}` : this.theme.font;
      ctx.fillText(formatTickLabel(bar.time, tick.weight), this.indexToX(tick.index), y);
    }
    ctx.font = this.theme.font;
  }

  private drawCrosshair() {
    if (this.drag?.kind === "separator" || !this.bars.length) return;
    const region = this.mouse ? this.regionAt(this.mouse.x, this.mouse.y) : null;
    const local = this.mouse && region?.kind === "plot";
    // A crosshair synced from another chart: vertical line + time label only.
    const externalIndex = !local && this.externalTime !== null ? this.barIndexAt(this.externalTime) : null;
    if (!local && externalIndex === null) return;
    const ctx = this.ctx;
    const index = local && this.mouse ? Math.round(this.xToIndex(this.mouse.x)) : (externalIndex as number);
    const snappedX = Math.round(this.indexToX(index)) + 0.5;
    const plotBottom = this.height - TIME_AXIS_HEIGHT;
    if (snappedX < 0 || snappedX > this.plotWidth) return;

    ctx.save();
    ctx.strokeStyle = this.theme.crosshair;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(snappedX, 0);
    ctx.lineTo(snappedX, plotBottom);
    if (local && this.mouse) {
      ctx.moveTo(0, Math.round(this.mouse.y) + 0.5);
      ctx.lineTo(this.plotWidth, Math.round(this.mouse.y) + 0.5);
    }
    ctx.stroke();
    ctx.restore();

    if (local && this.mouse && region?.kind === "plot") {
      const { y } = this.mouse;
      const pane = region.pane;
      this.drawAxisTag(y, this.formatPaneValue(pane, this.yToValue(pane, y)), this.theme.crosshairLabel, this.theme.textStrong);
    }

    const label = formatCrosshairTime(local ? this.indexToTime(index) : this.bars[index].time, this.intraday);
    ctx.font = this.theme.font;
    const width = ctx.measureText(label).width + 16;
    const left = Math.min(Math.max(0, snappedX - width / 2), this.plotWidth - width);
    ctx.fillStyle = this.theme.crosshairLabel;
    ctx.beginPath();
    ctx.roundRect(left, plotBottom + 3, width, TIME_AXIS_HEIGHT - 6, 2);
    ctx.fill();
    ctx.fillStyle = this.theme.textStrong;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, left + width / 2, plotBottom + TIME_AXIS_HEIGHT / 2);
  }

  private emitLegend() {
    if (!this.callbacks.onLegend) return;
    const n = this.bars.length;
    let index = n - 1;
    if (this.mouse && this.mouse.x < this.plotWidth && this.mouse.y < this.height - TIME_AXIS_HEIGHT) {
      index = Math.min(n - 1, Math.max(0, Math.round(this.xToIndex(this.mouse.x))));
    } else if (!this.mouse && this.externalTime !== null) {
      index = this.barIndexAt(this.externalTime) ?? index;
    }
    const scrolledAway = this.rightOffset < 0;
    const layoutKey = this.panes.map((pane) => `${pane.id}:${pane.top}:${pane.height}`).join("|");
    const key = `${index}:${this.dataVersion}:${layoutKey}:${this.plotWidth}:${scrolledAway}:${this.indicatorConfigs.length}:${this.indicatorsDirty}`;
    if (key === this.lastLegendKey) return;
    this.lastLegendKey = key;

    const values: LegendState["values"] = {};
    for (const config of this.indicatorConfigs) {
      const def = INDICATORS[config.type];
      const data = this.indicatorData.get(config.id);
      const params = resolveParams(def, config.params);
      values[config.id] = def.outputs.map((output) => {
        // Shifted outputs report the value plotted at the crosshair bar, not the one computed there.
        const value = data?.[output.key]?.[index - outputOffset(output, params)];
        return {
          label: output.label,
          color: config.colors[output.key] ?? output.color,
          value: value === undefined || Number.isNaN(value) ? null : value,
        };
      });
    }

    const panes: PaneLayout[] = this.panes.map((pane) => ({ id: pane.id, top: pane.top, height: pane.height }));
    this.callbacks.onLegend({
      bar: this.bars[index] ?? null,
      prevClose: index > 0 ? this.bars[index - 1].close : null,
      panes,
      plotWidth: this.plotWidth,
      values,
      scrolledAway,
    });
  }

  // ---------------------------------------------------------------- interaction

  private localPoint(event: PointerEvent | MouseEvent | WheelEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private hitDrawing(x: number, y: number): { drawing: Drawing; hit: DrawingHit } | null {
    const main = this.mainPane;
    if (!this.bars.length || !this.drawingsVisible || y > main.top + main.height || x > this.plotWidth) return null;
    const coords = this.drawingCoords();
    // Topmost (last drawn) first; the selected drawing wins ties so its anchors stay grabbable.
    const ordered = [...this.drawings].reverse().sort((a, b) => Number(b.id === this.selectedId) - Number(a.id === this.selectedId));
    for (const drawing of ordered) {
      if (drawing.hidden) continue;
      const hit = hitTestDrawing(drawing, coords, x, y, this.theme);
      if (hit) return { drawing, hit };
    }
    return null;
  }

  private updateCursor(region?: Region, overDrawing?: { drawing: Drawing; hit: DrawingHit } | null) {
    let cursor = "crosshair";
    if (this.drag?.kind === "pan") cursor = "grabbing";
    else if (this.drag?.kind === "drawing") cursor = "grabbing";
    else if (region?.kind === "priceAxis") cursor = "ns-resize";
    else if (region?.kind === "timeAxis") cursor = "ew-resize";
    else if (region?.kind === "separator") cursor = "row-resize";
    else if (overDrawing && this.tool === "cursor") {
      cursor = overDrawing.drawing.locked ? "default" : overDrawing.hit.kind === "anchor" ? "move" : "pointer";
    }
    this.canvas.style.cursor = cursor;
  }

  private finishPending() {
    if (!this.pending) return;
    this.drawings = [...this.drawings, this.pending.drawing];
    const id = this.pending.drawing.id;
    this.pending = null;
    this.tool = "cursor";
    this.callbacks.onToolChange?.("cursor");
    this.callbacks.onDrawingsChange?.(this.drawings);
    this.setSelected(id, "create");
  }

  /** Start a drawing with the active tool at (x, y). */
  private beginDrawing(x: number, y: number) {
    const type = this.tool;
    if (type === "cursor") return;
    const anchor = this.pointToAnchor(x, y);
    const count = DRAWING_POINTS[type];
    const color = type === "text" ? "#e6e9f0" : DRAWING_COLORS[this.drawingColorIndex % DRAWING_COLORS.length];
    if (type !== "text") this.drawingColorIndex += 1;
    const drawing: Drawing = { id: newDrawingId(), type, points: [anchor], color };

    if (type === "long" || type === "short") {
      // One click places a full position with sensible defaults (≈1.5 ATR stop, 2R target).
      const index = Math.round(this.timeToIndex(anchor.t));
      const widthBars = Math.max(8, Math.round(140 / this.barSpacing));
      drawing.points = positionPoints(type, anchor, this.positionRisk(index, anchor.p), this.indexToTime(index + widthBars));
      this.pending = { drawing, startX: x, startY: y, dragged: false };
      this.finishPending();
      return;
    }
    if (type === "brush") {
      drawing.points = [this.pointToRawAnchor(x, y)];
      this.pending = { drawing, startX: x, startY: y, dragged: false, freehand: true };
      return;
    }
    if (type === "text") drawing.text = DEFAULT_TEXT;
    if (count > 1) drawing.points = [anchor, { ...anchor }];
    this.pending = { drawing, startX: x, startY: y, dragged: false };
    if (count === 1) this.finishPending();
  }

  /** A click (or drag release) while a multi-point drawing is pending: fix the point, then next or finish. */
  private advancePending(x: number, y: number) {
    const pending = this.pending;
    if (!pending) return;
    const drawing = pending.drawing;
    const index = drawing.points.length - 1;
    drawing.points = placePoint(drawing, index, this.pointToAnchor(x, y), this.drawingCoords());
    if (drawing.points.length < DRAWING_POINTS[drawing.type]) {
      drawing.points = [...drawing.points, this.pointToAnchor(x, y)];
      drawing.points = placePoint(drawing, drawing.points.length - 1, this.pointToAnchor(x, y), this.drawingCoords());
      pending.startX = x;
      pending.startY = y;
      pending.dragged = false;
    } else {
      this.finishPending();
    }
  }

  private clearLongPress() {
    if (this.longPress) clearTimeout(this.longPress.timer);
    this.longPress = null;
  }

  /** Two fingers down: zoom around their midpoint (and pan with it). */
  private startPinch() {
    const [a, b] = [...this.touches.values()];
    const midX = Math.min((a.x + b.x) / 2, this.plotWidth);
    this.pinch = {
      startDist: Math.max(10, Math.abs(a.x - b.x)),
      startSpacing: this.barSpacing,
      anchorIndex: this.xToIndex(midX),
      lastMidX: midX,
    };
    this.drag = null;
    this.touchCrosshair = false;
    this.mouse = null;
    this.clearLongPress();
  }

  private handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    if (event.pointerType === "touch") {
      const point = this.localPoint(event);
      this.touches.set(event.pointerId, point);
      this.canvas.setPointerCapture(event.pointerId);
      if (this.touches.size === 2 && !this.pending) {
        this.startPinch();
        this.invalidate();
        return;
      }
      if (this.touches.size > 2) return;
      // Hold still to get a crosshair; moving first means pan.
      this.clearLongPress();
      this.touchCrosshair = false;
      if (this.tool === "cursor") {
        this.longPress = {
          x: point.x,
          y: point.y,
          timer: setTimeout(() => {
            if (!this.longPress || this.touches.size !== 1) return;
            this.touchCrosshair = true;
            if (this.drag?.kind === "pan") this.drag = null;
            this.mouse = { x: this.longPress.x, y: this.longPress.y };
            this.longPress = null;
            this.emitCrosshair(this.mouse.x, this.mouse.y);
            this.invalidate();
          }, LONG_PRESS_MS),
        };
      }
    }
    this.callbacks.onPointerDown?.();
    const { x, y } = this.localPoint(event);
    this.mouse = { x, y };
    const region = this.regionAt(x, y);
    this.canvas.setPointerCapture(event.pointerId);

    if (region.kind === "plot" && region.pane.id === "main" && this.tool !== "cursor" && this.bars.length) {
      if (!this.drawingsVisible) this.drawingsVisible = true;
      if (this.pending && !this.pending.freehand) this.advancePending(x, y);
      else if (!this.pending) this.beginDrawing(x, y);
      this.invalidate();
      return;
    }

    if (region.kind === "plot") {
      const target = this.tool === "cursor" ? this.hitDrawing(x, y) : null;
      if (target) {
        this.setSelected(target.drawing.id, "click");
      } else {
        this.setSelected(null, "click");
      }
      if (target && !target.drawing.locked) {
        this.drag = {
          kind: "drawing",
          id: target.drawing.id,
          hit: target.hit,
          startX: x,
          startY: y,
          origin: target.drawing.points.map((point) => ({ ...point })),
          moved: false,
        };
      } else {
        const pane = region.pane;
        this.drag = { kind: "pan", pane, startX: x, startY: y, startOffset: this.rightOffset, startMin: pane.min, startMax: pane.max, vertical: false };
      }
    } else if (region.kind === "priceAxis") {
      this.drag = { kind: "priceScale", pane: region.pane, startY: y, startMin: region.pane.min, startMax: region.pane.max };
    } else if (region.kind === "timeAxis") {
      this.drag = { kind: "timeScale", startX: x, startSpacing: this.barSpacing };
    } else if (region.kind === "separator") {
      for (const pane of this.panes) this.paneWeights.set(pane.id, pane.height);
      this.drag = { kind: "separator", upper: region.upper, lower: region.lower, startY: y, startUpper: region.upper.height, startLower: region.lower.height };
    }
    this.updateCursor(region);
    this.invalidate();
  };

  private emitCrosshair(x: number, y: number) {
    if (!this.callbacks.onCrosshairMove) return;
    const region = this.regionAt(x, y);
    const time = region.kind === "plot" && this.bars.length ? this.indexToTime(Math.round(this.xToIndex(x))) : null;
    if (time === this.lastCrosshairTime) return;
    this.lastCrosshairTime = time;
    this.callbacks.onCrosshairMove(time);
  }

  private handlePointerMove = (event: PointerEvent) => {
    const { x, y } = this.localPoint(event);
    if (event.pointerType === "touch" && this.touches.has(event.pointerId)) {
      this.touches.set(event.pointerId, { x, y });
      if (this.pinch && this.touches.size >= 2) {
        const [a, b] = [...this.touches.values()];
        const midX = Math.min((a.x + b.x) / 2, this.plotWidth);
        const dist = Math.max(10, Math.abs(a.x - b.x));
        this.barSpacing = Math.min(MAX_BAR_SPACING, Math.max(MIN_BAR_SPACING, (this.pinch.startSpacing * dist) / this.pinch.startDist));
        // Keep the bar that was under the fingers' midpoint under it (zoom + pan in one gesture).
        this.rightOffset = this.pinch.anchorIndex - (this.bars.length - 1) + (this.plotWidth - this.barSpacing / 2 - midX) / this.barSpacing;
        this.pinch.lastMidX = midX;
        this.clampView();
        this.invalidate();
        return;
      }
      if (this.longPress && Math.hypot(x - this.longPress.x, y - this.longPress.y) > TOUCH_SLOP) this.clearLongPress();
      if (this.touchCrosshair) {
        this.mouse = { x, y };
        this.emitCrosshair(x, y);
        this.invalidate();
        return;
      }
    }
    // A finger panning the chart shouldn't drag a crosshair along with it.
    this.mouse = event.pointerType === "touch" && !this.pending && this.tool === "cursor" ? null : { x, y };
    const drag = this.drag;
    this.emitCrosshair(x, y);

    if (this.pending?.freehand) {
      const points = this.pending.drawing.points;
      const last = points[points.length - 1];
      const coords = this.drawingCoords();
      if ((event.buttons & 1) && Math.hypot(coords.toX(last.t) - x, coords.toY(last.p) - y) >= 3) {
        points.push(this.pointToRawAnchor(x, y));
        this.pending.dragged = true;
      }
    } else if (this.pending) {
      const drawing = this.pending.drawing;
      drawing.points = placePoint(drawing, drawing.points.length - 1, this.pointToAnchor(x, y), this.drawingCoords());
      if (Math.hypot(x - this.pending.startX, y - this.pending.startY) > 4) this.pending.dragged = true;
    } else if (drag?.kind === "pan") {
      this.rightOffset = drag.startOffset - (x - drag.startX) / this.barSpacing;
      this.clampView();
      const dy = y - drag.startY;
      if (!drag.vertical && Math.abs(dy) > 24) drag.vertical = true;
      if (drag.vertical && !drag.pane.def?.bounds) {
        drag.pane.auto = false;
        const shift = (dy / drag.pane.height) * (drag.startMax - drag.startMin);
        drag.pane.min = drag.startMin + shift;
        drag.pane.max = drag.startMax + shift;
      }
    } else if (drag?.kind === "priceScale") {
      const factor = Math.exp((y - drag.startY) * 0.006);
      const center = (drag.startMin + drag.startMax) / 2;
      const half = ((drag.startMax - drag.startMin) / 2) * factor;
      drag.pane.auto = false;
      drag.pane.min = center - half;
      drag.pane.max = center + half;
    } else if (drag?.kind === "timeScale") {
      this.barSpacing = drag.startSpacing * Math.exp((x - drag.startX) * 0.008);
      this.clampView();
    } else if (drag?.kind === "separator") {
      const dy = y - drag.startY;
      const upper = Math.max(MIN_PANE_HEIGHT, drag.startUpper + dy);
      const lower = Math.max(MIN_PANE_HEIGHT, drag.startLower - dy);
      if (upper + lower <= drag.startUpper + drag.startLower + 0.5) {
        this.paneWeights.set(drag.upper.id, upper);
        this.paneWeights.set(drag.lower.id, lower);
      }
    } else if (drag?.kind === "drawing") {
      this.dragDrawing(drag, x, y);
    } else {
      const region = this.regionAt(x, y);
      const target = region.kind === "plot" && this.tool === "cursor" ? this.hitDrawing(x, y) : null;
      this.hoveredId = target?.drawing.id ?? null;
      this.updateCursor(region, target);
    }
    this.invalidate();
  };

  private dragDrawing(drag: Extract<DragState, { kind: "drawing" }>, x: number, y: number) {
    const drawing = this.drawings.find((candidate) => candidate.id === drag.id);
    if (!drawing || drawing.locked) return;
    if (Math.hypot(x - drag.startX, y - drag.startY) > 2) drag.moved = true;
    if (!drag.moved) return;
    const main = this.mainPane;
    let points: Anchor[];

    if (drag.hit.kind === "anchor") {
      points = moveHandle(drawing, drag.origin, drag.hit.index, this.pointToAnchor(x, y));
    } else {
      // Freehand strokes keep their sub-bar timing; everything else moves in whole bars.
      const freehand = drawing.type === "brush";
      const deltaIndex = freehand ? this.xToIndex(x) - this.xToIndex(drag.startX) : Math.round(this.xToIndex(x) - this.xToIndex(drag.startX));
      const deltaScale = this.toScale(main, this.yToValue(main, y)) - this.toScale(main, this.yToValue(main, drag.startY));
      points = drag.origin.map((point) => ({
        t: this.indexToTime((freehand ? this.timeToIndex(point.t) : Math.round(this.timeToIndex(point.t))) + deltaIndex),
        p: this.fromScale(main, this.toScale(main, point.p) + deltaScale),
      }));
    }
    this.drawings = this.drawings.map((candidate) => (candidate.id === drag.id ? { ...candidate, points } : candidate));
  }

  private handlePointerUp = (event: PointerEvent) => {
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (event.pointerType === "touch") {
      this.touches.delete(event.pointerId);
      this.clearLongPress();
      if (this.pinch) {
        // Lifting one finger of a pinch ends the gesture; don't turn the other into a pan.
        if (this.touches.size < 2) this.pinch = null;
        this.drag = null;
        this.invalidate();
        return;
      }
      if (this.touchCrosshair) {
        this.touchCrosshair = false;
        this.mouse = null;
        this.lastCrosshairTime = null;
        this.callbacks.onCrosshairMove?.(null);
      }
    }
    const { x, y } = this.localPoint(event);
    if (this.pending?.freehand) {
      if (this.pending.drawing.points.length >= 2) this.finishPending();
      else this.pending = null;
    } else if (this.pending?.dragged) {
      // Drag-to-draw: releasing the button places the point being dragged.
      this.advancePending(x, y);
    }
    if (this.drag?.kind === "drawing" && this.drag.moved) this.callbacks.onDrawingsChange?.(this.drawings);
    this.drag = null;
    this.updateCursor(this.regionAt(x, y));
    this.invalidate();
  };

  private handlePointerLeave = () => {
    if (this.drag) return;
    this.mouse = null;
    this.hoveredId = null;
    if (this.lastCrosshairTime !== null) {
      this.lastCrosshairTime = null;
      this.callbacks.onCrosshairMove?.(null);
    }
    this.invalidate();
  };

  private handleDoubleClick = (event: MouseEvent) => {
    const { x, y } = this.localPoint(event);
    const region = this.regionAt(x, y);
    if (region.kind === "priceAxis") {
      region.pane.auto = true;
    } else if (region.kind === "timeAxis") {
      this.resetView();
    } else if (region.kind === "plot" && this.tool === "cursor") {
      const target = this.hitDrawing(x, y);
      if (target) {
        this.setSelected(target.drawing.id, "click");
        this.callbacks.onDrawingDoubleClick?.(target.drawing.id);
      }
    }
    this.invalidate();
  };

  private handleWheel = (event: WheelEvent) => {
    event.preventDefault();
    const { x, y } = this.localPoint(event);
    const region = this.regionAt(x, y);

    if (region.kind === "priceAxis") {
      const pane = region.pane;
      const factor = Math.exp(event.deltaY * 0.002);
      const center = (pane.min + pane.max) / 2;
      const half = ((pane.max - pane.min) / 2) * factor;
      pane.auto = false;
      pane.min = center - half;
      pane.max = center + half;
      this.invalidate();
      return;
    }

    const zoom = event.ctrlKey || Math.abs(event.deltaY) > Math.abs(event.deltaX);
    if (zoom) {
      const anchorX = Math.min(x, this.plotWidth);
      const anchorIndex = this.xToIndex(anchorX);
      const speed = event.ctrlKey ? 0.012 : 0.0018;
      this.barSpacing *= Math.exp(-event.deltaY * speed);
      this.barSpacing = Math.min(MAX_BAR_SPACING, Math.max(MIN_BAR_SPACING, this.barSpacing));
      this.rightOffset = anchorIndex - (this.bars.length - 1) + (this.plotWidth - this.barSpacing / 2 - anchorX) / this.barSpacing;
    } else {
      this.rightOffset += event.deltaX / this.barSpacing;
    }
    this.clampView();
    this.invalidate();
  };
}

// -------------------------------------------------------------------- helpers

function niceStep(raw: number) {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const exponent = Math.floor(Math.log10(raw));
  const base = 10 ** exponent;
  const fraction = raw / base;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * base;
}

export function toHeikinAshi(bars: Bar[]): Bar[] {
  const out: Bar[] = new Array(bars.length);
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const close = (bar.open + bar.high + bar.low + bar.close) / 4;
    const open = i === 0 ? (bar.open + bar.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out[i] = {
      time: bar.time,
      open,
      close,
      high: Math.max(bar.high, open, close),
      low: Math.min(bar.low, open, close),
      volume: bar.volume,
    };
  }
  return out;
}

/**
 * Importance of each bar as a time-axis label position: year > month > week >
 * day > hour > half-hour > quarter-hour > 5 minutes. 0 = never label.
 */
function computeTickWeights(bars: Bar[], intraday: boolean): Uint8Array {
  const weights = new Uint8Array(bars.length);
  let prev = bars.length ? istClock(bars[0].time) : null;
  for (let i = 1; i < bars.length; i += 1) {
    const current = istClock(bars[i].time);
    if (!prev) break;
    let weight = 0;
    if (current.year !== prev.year) weight = 60;
    else if (current.month !== prev.month) weight = 50;
    else if (!intraday && current.weekday < prev.weekday) weight = 45;
    else if (current.day !== prev.day) weight = 40;
    else if (current.hours !== prev.hours) weight = 30;
    else if (current.minutes % 30 === 0) weight = 20;
    else if (current.minutes % 15 === 0) weight = 15;
    else if (current.minutes % 5 === 0) weight = 10;
    weights[i] = weight;
    prev = current;
  }
  return weights;
}
