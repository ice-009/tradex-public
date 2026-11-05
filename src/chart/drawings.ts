import type { Anchor, Drawing, DrawingType, LineExtend } from "@/chart/types";
import type { Bar } from "@/core/types";
import type { ChartTheme } from "./theme";
import { formatPrice } from "@/core/format";

// Drawing tools: geometry, handles, hit testing and rendering. Drawings are
// anchored in (time, price) space; the engine supplies converters into pixel
// space. Handles (the grabbable dots) are derived from the anchors and may not
// map 1:1 onto them (a position tool has 3 anchors but 4 handles), so dragging
// a handle goes through `moveHandle`.

export interface DrawingCoords {
  toX(time: number): number;
  toY(price: number): number;
  width: number; // plot width (excludes price axis)
  height: number; // main pane height
  barSpacing: number;
  /** Bars whose open time falls in [from, to] (position outcome). */
  barsBetween?(from: number, to: number): Bar[];
}

export type DrawingHit = { kind: "anchor"; index: number } | { kind: "body" };

/** Anchors a drawing has once placed. Position tools and brush are placed specially by the engine. */
export const DRAWING_POINTS: Record<DrawingType, number> = {
  trendline: 2,
  ray: 2,
  extended: 2,
  arrow: 2,
  hline: 1,
  hray: 1,
  vline: 1,
  channel: 3,
  rect: 2,
  brush: 2,
  text: 1,
  fib: 2,
  long: 3,
  short: 3,
  pricerange: 2,
  daterange: 2,
  measure: 2,
};

export const DRAWING_LABELS: Record<DrawingType, string> = {
  trendline: "Trend line",
  ray: "Ray",
  extended: "Extended line",
  arrow: "Arrow",
  hline: "Horizontal line",
  hray: "Horizontal ray",
  vline: "Vertical line",
  channel: "Parallel channel",
  rect: "Rectangle",
  brush: "Brush",
  text: "Text",
  fib: "Fib retracement",
  long: "Long position",
  short: "Short position",
  pricerange: "Price range",
  daterange: "Date range",
  measure: "Date & price range",
};

export const DRAWING_COLORS = ["#2962ff", "#f5b544", "#089981", "#f23645", "#c77dff", "#22d3ee", "#e6e9f0"];
/** Wider palette for the properties toolbar. */
export const PALETTE_COLORS = [
  "#2962ff", "#22d3ee", "#089981", "#84cc16", "#f5b544", "#f59e42",
  "#f23645", "#ec4899", "#c77dff", "#8a93a6", "#e6e9f0", "#ffffff",
];

export const DEFAULT_LINE_WIDTH = 2;
export const DEFAULT_FONT_SIZE = 14;
export const DEFAULT_TEXT = "Text";

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS = ["#8a93a6", "#f23645", "#f59e42", "#089981", "#22d3ee", "#2962ff", "#8a93a6"];

const HIT_TOLERANCE = 6;
const ANCHOR_RADIUS = 5;

/** Which tools honour the style controls in the properties toolbar. */
export function drawingCaps(type: DrawingType) {
  const position = type === "long" || type === "short";
  const measure = type === "pricerange" || type === "daterange" || type === "measure";
  return {
    color: !position && !measure,
    line: !position && !measure && type !== "text" && type !== "fib",
    extend: type === "trendline" || type === "arrow" || type === "channel",
    text: type === "text",
  };
}

export function isPosition(drawing: Drawing) {
  return drawing.type === "long" || drawing.type === "short";
}

export function withAlpha(color: string, alpha: number) {
  const hex = color.replace("#", "");
  if (hex.length !== 6) return color;
  const value = parseInt(hex, 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

export interface Point {
  x: number;
  y: number;
}

function toPixels(points: Anchor[], c: DrawingCoords): Point[] {
  return points.map((point) => ({ x: c.toX(point.t), y: c.toY(point.p) }));
}

/** Extend segment a→b to the plot edges, forwards (past b) and/or backwards (past a). */
function extendSegment(a: Point, b: Point, width: number, backward: boolean, forward: boolean): [Point, Point] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (!backward && !forward) return [a, b];
  if (Math.abs(dx) < 1e-9) {
    // Vertical: extend to a generous y range; the canvas clip handles the rest.
    const far = 1e5;
    const down = dy >= 0;
    return [
      backward ? { x: a.x, y: down ? -far : far } : a,
      forward ? { x: b.x, y: down ? far : -far } : b,
    ];
  }
  const slope = dy / dx;
  const at = (x: number) => ({ x, y: a.y + slope * (x - a.x) });
  const forwardEdge = dx > 0 ? width : 0;
  const backwardEdge = dx > 0 ? 0 : width;
  return [backward ? at(backwardEdge) : a, forward ? at(forwardEdge) : b];
}

function lineEnds(drawing: Drawing, a: Point, b: Point, width: number): [Point, Point] {
  switch (drawing.type) {
    case "ray":
      return extendSegment(a, b, width, false, true);
    case "extended":
      return extendSegment(a, b, width, true, true);
    default: {
      const extend: LineExtend = drawing.extend ?? "none";
      return extendSegment(a, b, width, extend === "left" || extend === "both", extend === "right" || extend === "both");
    }
  }
}

function distanceToSegment(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function fibPrice(points: Anchor[], level: number) {
  // Level 0 sits at the second anchor, level 1 at the first (TradingView convention).
  return points[1].p + (points[0].p - points[1].p) * level;
}

// ------------------------------------------------------------------ text measuring

let measureCtx: CanvasRenderingContext2D | null = null;

export function textFont(size: number, theme?: ChartTheme) {
  const family = theme?.font.replace(/^[\d.]+px\s*/, "") ?? '"Geist", -apple-system, "Segoe UI", Roboto, sans-serif';
  return `500 ${size}px ${family}`;
}

function textLines(drawing: Drawing) {
  return (drawing.text || DEFAULT_TEXT).split("\n");
}

/** Text box (top-left at the anchor) in pixels. */
function textBox(drawing: Drawing, c: DrawingCoords, font: string) {
  const size = drawing.fontSize ?? DEFAULT_FONT_SIZE;
  const lines = textLines(drawing);
  if (!measureCtx && typeof document !== "undefined") measureCtx = document.createElement("canvas").getContext("2d");
  let width = 0;
  for (const line of lines) {
    if (measureCtx) {
      measureCtx.font = font;
      width = Math.max(width, measureCtx.measureText(line || " ").width);
    } else {
      width = Math.max(width, line.length * size * 0.6);
    }
  }
  const lineHeight = Math.round(size * 1.3);
  const x = c.toX(drawing.points[0].t);
  const y = c.toY(drawing.points[0].p);
  return { x, y, width, height: lines.length * lineHeight, lineHeight, lines };
}

// ------------------------------------------------------------------ channels & positions

/** Channel offset (price) between the base line and the parallel line. */
function channelOffset(points: Anchor[]) {
  return points[2] ? points[2].p - points[0].p : 0;
}

function channelLines(drawing: Drawing, c: DrawingCoords) {
  const [p0, p1] = drawing.points;
  const offset = channelOffset(drawing.points);
  const a = { x: c.toX(p0.t), y: c.toY(p0.p) };
  const b = { x: c.toX(p1.t), y: c.toY(p1.p) };
  const qa = { x: a.x, y: c.toY(p0.p + offset) };
  const qb = { x: b.x, y: c.toY(p1.p + offset) };
  const ma = { x: a.x, y: c.toY(p0.p + offset / 2) };
  const mb = { x: b.x, y: c.toY(p1.p + offset / 2) };
  return {
    base: lineEnds(drawing, a, b, c.width),
    parallel: lineEnds(drawing, qa, qb, c.width),
    middle: lineEnds(drawing, ma, mb, c.width),
    raw: [a, b, qa, qb] as Point[],
  };
}

export interface PositionStats {
  long: boolean;
  entry: number;
  target: number;
  stop: number;
  reward: number; // points, always >= 0
  risk: number;
  rr: number;
  targetPct: number;
  stopPct: number;
}

export function positionStats(drawing: Drawing): PositionStats {
  const [entry, target, stop] = drawing.points;
  const reward = Math.abs(target.p - entry.p);
  const risk = Math.abs(entry.p - stop.p);
  return {
    long: drawing.type === "long",
    entry: entry.p,
    target: target.p,
    stop: stop.p,
    reward,
    risk,
    rr: risk > 0 ? reward / risk : 0,
    targetPct: entry.p ? (reward / entry.p) * 100 : 0,
    stopPct: entry.p ? (risk / entry.p) * 100 : 0,
  };
}

export type PositionOutcome =
  | { status: "waiting" }
  | { status: "open" | "target" | "stop"; entryTime: number; exitTime: number; exitPrice: number };

/** Walk the bars inside the position's window: entry fill first, then target/stop (same bar → stop). */
export function positionOutcome(drawing: Drawing, bars: Bar[]): PositionOutcome {
  const { long, entry, target, stop } = positionStats(drawing);
  let entryTime: number | null = null;
  for (const bar of bars) {
    if (entryTime === null) {
      if (bar.low <= entry && bar.high >= entry) entryTime = bar.time;
      else continue;
    }
    const hitStop = long ? bar.low <= stop : bar.high >= stop;
    const hitTarget = long ? bar.high >= target : bar.low <= target;
    if (hitStop) return { status: "stop", entryTime, exitTime: bar.time, exitPrice: stop };
    if (hitTarget) return { status: "target", entryTime, exitTime: bar.time, exitPrice: target };
  }
  if (entryTime === null) return { status: "waiting" };
  const last = bars[bars.length - 1];
  return { status: "open", entryTime, exitTime: last.time, exitPrice: last.close };
}

/**
 * Default anchors for a new position: entry at the click, stop one "risk" away,
 * target at 2R, right edge `endTime`.
 */
export function positionPoints(type: "long" | "short", entry: Anchor, risk: number, endTime: number): Anchor[] {
  const sign = type === "long" ? 1 : -1;
  return [
    { t: entry.t, p: entry.p },
    { t: endTime, p: entry.p + sign * risk * 2 },
    { t: endTime, p: entry.p - sign * risk },
  ];
}

// ------------------------------------------------------------------ handles

/** Grabbable handle positions, in pixels. Index order is what `moveHandle` receives. */
export function drawingHandles(drawing: Drawing, c: DrawingCoords): Point[] {
  const pts = toPixels(drawing.points, c);
  switch (drawing.type) {
    case "brush":
      return [];
    case "long":
    case "short": {
      const [e, t, s] = pts;
      return [
        { x: e.x, y: e.y },
        { x: e.x, y: t.y },
        { x: e.x, y: s.y },
        { x: t.x, y: e.y },
      ];
    }
    case "channel":
      return pts.length < 3 ? pts : channelLines(drawing, c).raw;
    case "rect":
    case "pricerange":
    case "daterange":
    case "measure":
      return [pts[0], pts[1], { x: pts[0].x, y: pts[1].y }, { x: pts[1].x, y: pts[0].y }];
    default:
      return pts;
  }
}

/**
 * New anchors after dragging handle `index` of a drawing (whose points are the
 * pre-drag `origin`) to `anchor`.
 */
export function moveHandle(drawing: Drawing, origin: Anchor[], index: number, anchor: Anchor): Anchor[] {
  const points = origin.map((point) => ({ ...point }));
  switch (drawing.type) {
    case "long":
    case "short": {
      const long = drawing.type === "long";
      const [entry, target, stop] = points;
      const above = (value: number) => Math.max(value, entry.p * (1 + 1e-6));
      const below = (value: number) => Math.min(value, entry.p * (1 - 1e-6));
      if (index === 0) {
        // Entry: price and start time; keep target/stop on the correct sides.
        entry.t = Math.min(anchor.t, target.t);
        const minGap = Math.abs(anchor.p) * 1e-4;
        entry.p = long
          ? Math.min(Math.max(anchor.p, stop.p + minGap), target.p - minGap)
          : Math.min(Math.max(anchor.p, target.p + minGap), stop.p - minGap);
      } else if (index === 1) {
        target.p = long ? above(anchor.p) : below(anchor.p);
      } else if (index === 2) {
        stop.p = long ? below(anchor.p) : above(anchor.p);
      } else if (index === 3) {
        const end = Math.max(anchor.t, entry.t);
        target.t = end;
        stop.t = end;
      }
      return points;
    }
    case "channel": {
      const offset = channelOffset(origin);
      if (index === 0) points[0] = { ...anchor };
      else if (index === 1) points[1] = { ...anchor };
      const nextOffset = index === 2 ? anchor.p - points[0].p : index === 3 ? anchor.p - points[1].p : offset;
      points[2] = { t: points[0].t, p: points[0].p + nextOffset };
      return points;
    }
    case "rect":
    case "pricerange":
    case "daterange":
    case "measure": {
      if (index === 0) points[0] = { ...anchor };
      else if (index === 1) points[1] = { ...anchor };
      else if (index === 2) {
        points[0].t = anchor.t;
        points[1].p = anchor.p;
      } else if (index === 3) {
        points[1].t = anchor.t;
        points[0].p = anchor.p;
      }
      return points;
    }
    default:
      if (points[index]) points[index] = { ...anchor };
      return points;
  }
}

/**
 * Place anchor `index` while a drawing is being created. The channel's third
 * click sets the parallel line's price offset, measured against the base line
 * at the cursor's x; it is stored normalised at the first anchor's time.
 */
export function placePoint(drawing: Drawing, index: number, anchor: Anchor, c: DrawingCoords): Anchor[] {
  const points = drawing.points.map((point) => ({ ...point }));
  if (drawing.type === "channel" && index === 2) {
    const x0 = c.toX(points[0].t);
    const x1 = c.toX(points[1].t);
    const x = c.toX(anchor.t);
    const fraction = Math.abs(x1 - x0) < 1e-6 ? 0 : (x - x0) / (x1 - x0);
    const base = points[0].p + fraction * (points[1].p - points[0].p);
    points[2] = { t: points[0].t, p: points[0].p + (anchor.p - base) };
    return points;
  }
  points[index] = { ...anchor };
  return points;
}

// ------------------------------------------------------------------ hit testing

function boxHit(pts: Point[], x: number, y: number) {
  const left = Math.min(pts[0].x, pts[1].x);
  const right = Math.max(pts[0].x, pts[1].x);
  const top = Math.min(pts[0].y, pts[1].y);
  const bottom = Math.max(pts[0].y, pts[1].y);
  return x >= left - HIT_TOLERANCE && x <= right + HIT_TOLERANCE && y >= top - HIT_TOLERANCE && y <= bottom + HIT_TOLERANCE;
}

export function hitTestDrawing(drawing: Drawing, c: DrawingCoords, x: number, y: number, theme?: ChartTheme): DrawingHit | null {
  const cursor = { x, y };
  const handles = drawingHandles(drawing, c);
  for (let index = 0; index < handles.length; index += 1) {
    if (Math.hypot(handles[index].x - x, handles[index].y - y) <= ANCHOR_RADIUS + 3) {
      return { kind: "anchor", index };
    }
  }

  const pts = toPixels(drawing.points, c);
  const near = (distance: number) => (distance <= HIT_TOLERANCE ? ({ kind: "body" } as const) : null);

  switch (drawing.type) {
    case "trendline":
    case "ray":
    case "extended":
    case "arrow": {
      const [a, b] = lineEnds(drawing, pts[0], pts[1], c.width);
      return near(distanceToSegment(cursor, a, b));
    }
    case "hline":
      return near(Math.abs(y - pts[0].y));
    case "hray":
      return x >= pts[0].x - HIT_TOLERANCE ? near(Math.abs(y - pts[0].y)) : null;
    case "vline":
      return near(Math.abs(x - pts[0].x));
    case "channel": {
      if (pts.length < 3) return near(distanceToSegment(cursor, pts[0], pts[1]));
      const lines = channelLines(drawing, c);
      const distance = Math.min(
        distanceToSegment(cursor, ...lines.base),
        distanceToSegment(cursor, ...lines.parallel),
        distanceToSegment(cursor, ...lines.middle),
      );
      if (distance <= HIT_TOLERANCE) return { kind: "body" };
      // Inside the band between the two raw segments.
      const [a, b, qa] = lines.raw;
      const left = Math.min(a.x, b.x);
      const right = Math.max(a.x, b.x);
      if (x < left || x > right || Math.abs(b.x - a.x) < 1e-6) return null;
      const fraction = (x - a.x) / (b.x - a.x);
      const yBase = a.y + fraction * (b.y - a.y);
      const yPar = yBase + (qa.y - a.y);
      return y >= Math.min(yBase, yPar) && y <= Math.max(yBase, yPar) ? { kind: "body" } : null;
    }
    case "brush": {
      for (let i = 1; i < pts.length; i += 1) {
        if (distanceToSegment(cursor, pts[i - 1], pts[i]) <= HIT_TOLERANCE) return { kind: "body" };
      }
      return null;
    }
    case "text": {
      const box = textBox(drawing, c, textFont(drawing.fontSize ?? DEFAULT_FONT_SIZE, theme));
      const inside = x >= box.x - 4 && x <= box.x + box.width + 4 && y >= box.y - 4 && y <= box.y + box.height + 4;
      return inside ? { kind: "body" } : null;
    }
    case "rect":
    case "pricerange":
    case "daterange":
    case "measure":
      return boxHit(pts, x, y) ? { kind: "body" } : null;
    case "long":
    case "short": {
      const [e, t, s] = pts;
      const left = Math.min(e.x, t.x);
      const right = Math.max(e.x, t.x);
      const top = Math.min(t.y, s.y);
      const bottom = Math.max(t.y, s.y);
      return x >= left - 2 && x <= right + 2 && y >= top - 2 && y <= bottom + 2 ? { kind: "body" } : null;
    }
    case "fib": {
      const left = Math.min(pts[0].x, pts[1].x);
      const right = Math.max(pts[0].x, pts[1].x);
      if (x < left - HIT_TOLERANCE || x > right + HIT_TOLERANCE) return null;
      for (const level of FIB_LEVELS) {
        if (Math.abs(c.toY(fibPrice(drawing.points, level)) - y) <= HIT_TOLERANCE) return { kind: "body" };
      }
      return null;
    }
  }
}

/** Pixel bounding box of a drawing (clamped to the plot), for placing the properties toolbar. */
export function drawingBounds(drawing: Drawing, c: DrawingCoords, theme?: ChartTheme) {
  let points = [...toPixels(drawing.points, c), ...drawingHandles(drawing, c)];
  if (drawing.type === "hline") points = [{ x: 0, y: points[0].y }, { x: c.width, y: points[0].y }];
  if (drawing.type === "vline") points = [{ x: points[0].x, y: 0 }, { x: points[0].x, y: c.height }];
  if (drawing.type === "text") {
    const box = textBox(drawing, c, textFont(drawing.fontSize ?? DEFAULT_FONT_SIZE, theme));
    points.push({ x: box.x + box.width, y: box.y + box.height });
  }
  // Positions and ranges carry labels just outside their box.
  const labelPad = isPosition(drawing) ? 24 : drawing.type === "pricerange" || drawing.type === "daterange" || drawing.type === "measure" ? 34 : 0;
  const xs = points.map((point) => Math.min(c.width, Math.max(0, point.x)));
  const ys = points.map((point) => Math.min(c.height, Math.max(0, point.y)));
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.max(0, Math.min(...ys) - labelPad),
    bottom: Math.min(c.height, Math.max(...ys) + labelPad),
  };
}

// ------------------------------------------------------------------ rendering

function strokeLine(ctx: CanvasRenderingContext2D, a: Point, b: Point) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function applyLineStyle(ctx: CanvasRenderingContext2D, drawing: Drawing) {
  const width = drawing.lineWidth ?? DEFAULT_LINE_WIDTH;
  ctx.lineWidth = width;
  if (drawing.lineStyle === "dashed") ctx.setLineDash([width * 4, width * 3]);
  else if (drawing.lineStyle === "dotted") ctx.setLineDash([width, width * 2]);
  else ctx.setLineDash([]);
}

function drawHandles(ctx: CanvasRenderingContext2D, pts: Point[], color: string, theme: ChartTheme, square = false) {
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  for (const point of pts) {
    ctx.beginPath();
    if (square) ctx.rect(point.x - ANCHOR_RADIUS + 0.5, point.y - ANCHOR_RADIUS + 0.5, ANCHOR_RADIUS * 2 - 1, ANCHOR_RADIUS * 2 - 1);
    else ctx.arc(point.x, point.y, ANCHOR_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = theme.background;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.stroke();
  }
}

function drawTag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, background: string, color: string) {
  const lines = text.split("\n");
  const paddingX = 7;
  const lineHeight = 15;
  const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + paddingX * 2;
  const height = lines.length * lineHeight + 5;
  ctx.fillStyle = background;
  ctx.beginPath();
  ctx.roundRect(x - width / 2, y - height / 2, width, height, 3);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((line, index) => {
    ctx.fillText(line, x, y - ((lines.length - 1) * lineHeight) / 2 + index * lineHeight + 0.5);
  });
}

function drawArrowHead(ctx: CanvasRenderingContext2D, from: Point, to: Point, size: number) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(angle - Math.PI / 7), to.y - size * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(to.x - size * Math.cos(angle + Math.PI / 7), to.y - size * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

function signed(value: number, digits?: number) {
  const text = digits === undefined ? formatPrice(Math.abs(value)) : Math.abs(value).toFixed(digits);
  return `${value >= 0 ? "+" : "−"}${text}`;
}

export function formatDuration(ms: number) {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

function renderPosition(ctx: CanvasRenderingContext2D, drawing: Drawing, c: DrawingCoords, theme: ChartTheme, active: boolean) {
  const stats = positionStats(drawing);
  const [entry, target, stop] = drawing.points;
  const x0 = c.toX(entry.t);
  const x1 = c.toX(target.t);
  const left = Math.min(x0, x1);
  const width = Math.max(2, Math.abs(x1 - x0));
  const yE = c.toY(entry.p);
  const yT = c.toY(target.p);
  const yS = c.toY(stop.p);

  ctx.fillStyle = withAlpha(theme.up, active ? 0.26 : 0.2);
  ctx.fillRect(left, Math.min(yE, yT), width, Math.abs(yT - yE));
  ctx.fillStyle = withAlpha(theme.down, active ? 0.26 : 0.2);
  ctx.fillRect(left, Math.min(yE, yS), width, Math.abs(yS - yE));

  // Outcome: shade the path from the fill to the exit (or the last bar while open).
  const outcome = c.barsBetween ? positionOutcome(drawing, c.barsBetween(entry.t, target.t)) : ({ status: "waiting" } as const);
  if (outcome.status !== "waiting") {
    const xa = c.toX(outcome.entryTime);
    const xb = c.toX(outcome.exitTime);
    const yX = c.toY(outcome.exitPrice);
    const win = stats.long ? outcome.exitPrice >= stats.entry : outcome.exitPrice <= stats.entry;
    ctx.fillStyle = withAlpha(win ? theme.up : theme.down, 0.22);
    ctx.fillRect(Math.min(xa, xb), Math.min(yE, yX), Math.max(1, Math.abs(xb - xa)), Math.abs(yX - yE));
    ctx.strokeStyle = withAlpha(theme.textStrong, 0.7);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    strokeLine(ctx, { x: xa, y: yE }, { x: xb, y: yX });
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = withAlpha(theme.textStrong, 0.75);
  ctx.lineWidth = 1;
  strokeLine(ctx, { x: left, y: yE }, { x: left + width, y: yE });
  ctx.strokeStyle = withAlpha(theme.up, 0.8);
  strokeLine(ctx, { x: left, y: yT }, { x: left + width, y: yT });
  ctx.strokeStyle = withAlpha(theme.down, 0.8);
  strokeLine(ctx, { x: left, y: yS }, { x: left + width, y: yS });

  const midX = left + width / 2;
  const targetDiff = stats.target - stats.entry;
  const stopDiff = stats.stop - stats.entry;
  const targetLabel = `Target: ${formatPrice(stats.target)} (${signed((targetDiff / stats.entry) * 100, 2)}%) ${signed(targetDiff)}`;
  const stopLabel = `Stop: ${formatPrice(stats.stop)} (${signed((stopDiff / stats.entry) * 100, 2)}%) ${signed(stopDiff)}`;
  const targetAbove = yT < yE;
  drawTag(ctx, targetLabel, midX, yT + (targetAbove ? -12 : 12), theme.up, "#fff");
  drawTag(ctx, stopLabel, midX, yS + (targetAbove ? 12 : -12), theme.down, "#fff");

  let center = `${stats.long ? "Long" : "Short"} @ ${formatPrice(stats.entry)}  ·  R:R ${stats.rr.toFixed(2)}`;
  if (outcome.status !== "waiting") {
    const pnl = (outcome.exitPrice - stats.entry) * (stats.long ? 1 : -1);
    const pct = (pnl / stats.entry) * 100;
    const head = outcome.status === "target" ? "Target hit" : outcome.status === "stop" ? "Stop hit" : "Open P&L";
    center += `\n${head}: ${signed(pnl)} (${signed(pct, 2)}%)`;
  }
  const centerBg = outcome.status === "target" ? theme.up : outcome.status === "stop" ? theme.down : "#3a4256";
  drawTag(ctx, center, midX, yE, centerBg, "#fff");
}

function renderRange(ctx: CanvasRenderingContext2D, drawing: Drawing, pts: Point[], c: DrawingCoords, theme: ChartTheme) {
  const [a, b] = drawing.points;
  const change = b.p - a.p;
  const timeForward = b.t >= a.t;
  const up = drawing.type === "daterange" ? timeForward : change >= 0;
  const tint = drawing.type === "daterange" ? "#2962ff" : up ? theme.up : theme.down;
  const x = Math.min(pts[0].x, pts[1].x);
  const y = Math.min(pts[0].y, pts[1].y);
  const w = Math.abs(pts[1].x - pts[0].x);
  const h = Math.abs(pts[1].y - pts[0].y);
  ctx.fillStyle = withAlpha(tint, 0.16);
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = tint;
  ctx.fillStyle = tint;
  ctx.lineWidth = 1;
  const midX = x + w / 2;
  const midY = y + h / 2;

  const pct = a.p !== 0 ? (change / a.p) * 100 : 0;
  const bars = Math.round((pts[1].x - pts[0].x) / c.barSpacing);
  const priceText = `${signed(change)} (${signed(pct, 2)}%)`;
  const timeText = `${bars} bars, ${formatDuration(b.t - a.t)}`;

  if (drawing.type !== "daterange") {
    strokeLine(ctx, { x: midX, y: pts[0].y }, { x: midX, y: pts[1].y });
    if (h > 12) drawArrowHead(ctx, { x: midX, y: pts[0].y }, { x: midX, y: pts[1].y }, 8);
  }
  if (drawing.type !== "pricerange") {
    strokeLine(ctx, { x: pts[0].x, y: midY }, { x: pts[1].x, y: midY });
    if (w > 12) drawArrowHead(ctx, { x: pts[0].x, y: midY }, { x: pts[1].x, y: midY }, 8);
  }

  const label = drawing.type === "pricerange" ? priceText : drawing.type === "daterange" ? timeText : `${priceText}\n${timeText}`;
  const lines = label.split("\n").length;
  const offset = 8 + lines * 8;
  const labelY = drawing.type === "daterange" || !up ? y + h + offset : y - offset;
  drawTag(ctx, label, midX, labelY, tint, "#fff");
}

export function renderDrawing(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  c: DrawingCoords,
  theme: ChartTheme,
  state: { selected: boolean; hovered: boolean },
) {
  const pts = toPixels(drawing.points, c);
  const color = drawing.color;
  const active = state.hovered || state.selected;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.font = theme.font;
  applyLineStyle(ctx, drawing);

  switch (drawing.type) {
    case "trendline":
    case "ray":
    case "extended": {
      const [a, b] = lineEnds(drawing, pts[0], pts[1], c.width);
      strokeLine(ctx, a, b);
      break;
    }
    case "arrow": {
      const [a, b] = lineEnds(drawing, pts[0], pts[1], c.width);
      strokeLine(ctx, a, b);
      if (Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) > 2) {
        drawArrowHead(ctx, pts[0], pts[1], 9 + (drawing.lineWidth ?? DEFAULT_LINE_WIDTH) * 2);
      }
      break;
    }
    case "hline":
      strokeLine(ctx, { x: 0, y: pts[0].y }, { x: c.width, y: pts[0].y });
      break;
    case "hray":
      strokeLine(ctx, pts[0], { x: c.width, y: pts[0].y });
      break;
    case "vline":
      strokeLine(ctx, { x: pts[0].x, y: 0 }, { x: pts[0].x, y: c.height });
      break;
    case "channel": {
      if (pts.length < 3) {
        strokeLine(ctx, pts[0], pts[1]);
        break;
      }
      const lines = channelLines(drawing, c);
      ctx.fillStyle = withAlpha(color, 0.12);
      ctx.beginPath();
      ctx.moveTo(lines.base[0].x, lines.base[0].y);
      ctx.lineTo(lines.base[1].x, lines.base[1].y);
      ctx.lineTo(lines.parallel[1].x, lines.parallel[1].y);
      ctx.lineTo(lines.parallel[0].x, lines.parallel[0].y);
      ctx.closePath();
      ctx.fill();
      strokeLine(ctx, ...lines.base);
      strokeLine(ctx, ...lines.parallel);
      ctx.save();
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = withAlpha(color, 0.7);
      strokeLine(ctx, ...lines.middle);
      ctx.restore();
      break;
    }
    case "rect": {
      const x = Math.min(pts[0].x, pts[1].x);
      const y = Math.min(pts[0].y, pts[1].y);
      const w = Math.abs(pts[1].x - pts[0].x);
      const h = Math.abs(pts[1].y - pts[0].y);
      ctx.fillStyle = withAlpha(color, 0.14);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      break;
    }
    case "brush": {
      if (pts.length < 2) break;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      break;
    }
    case "text": {
      const size = drawing.fontSize ?? DEFAULT_FONT_SIZE;
      const font = textFont(size, theme);
      ctx.font = font;
      const box = textBox(drawing, c, font);
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = color;
      box.lines.forEach((line, index) => ctx.fillText(line, box.x, box.y + index * box.lineHeight + 1));
      if (active) {
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = withAlpha(color, 0.7);
        ctx.strokeRect(box.x - 4.5, box.y - 3.5, box.width + 9, box.height + 6);
      }
      break;
    }
    case "fib": {
      const left = Math.min(pts[0].x, pts[1].x);
      const right = Math.max(pts[0].x, pts[1].x);
      ctx.lineWidth = 1;
      let prevY: number | null = null;
      FIB_LEVELS.forEach((level, index) => {
        const price = fibPrice(drawing.points, level);
        const y = c.toY(price);
        const levelColor = FIB_COLORS[index];
        if (prevY !== null) {
          ctx.fillStyle = withAlpha(levelColor, 0.08);
          ctx.fillRect(left, Math.min(prevY, y), right - left, Math.abs(y - prevY));
        }
        ctx.strokeStyle = levelColor;
        strokeLine(ctx, { x: left, y }, { x: right, y });
        ctx.fillStyle = levelColor;
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillText(`${level} (${formatPrice(price)})`, left - 4, y + 5);
        prevY = y;
      });
      ctx.strokeStyle = withAlpha(color, 0.6);
      ctx.setLineDash([4, 4]);
      strokeLine(ctx, pts[0], pts[1]);
      ctx.setLineDash([]);
      break;
    }
    case "long":
    case "short":
      if (pts.length >= 3) renderPosition(ctx, drawing, c, theme, active);
      break;
    case "pricerange":
    case "daterange":
    case "measure":
      renderRange(ctx, drawing, pts, c, theme);
      break;
  }

  if (active) {
    const handleColor = isPosition(drawing) ? theme.textStrong : drawing.type === "measure" || drawing.type === "pricerange" || drawing.type === "daterange" ? "#2962ff" : color;
    drawHandles(ctx, drawingHandles(drawing, c), drawing.locked ? theme.text : handleColor, theme, isPosition(drawing));
  }
  ctx.restore();
}

/** Price tags on the axis: horizontal lines always, position levels while the tool is active. */
export function axisLabels(drawing: Drawing, active: boolean, theme: ChartTheme): Array<{ price: number; color: string }> {
  if (drawing.hidden) return [];
  if (drawing.type === "hline" || drawing.type === "hray") return [{ price: drawing.points[0].p, color: drawing.color }];
  if (active && isPosition(drawing) && drawing.points.length >= 3) {
    const [entry, target, stop] = drawing.points;
    return [
      { price: target.p, color: theme.up },
      { price: entry.p, color: "#3a4256" },
      { price: stop.p, color: theme.down },
    ];
  }
  return [];
}
