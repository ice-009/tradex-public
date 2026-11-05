import type { Annotations } from "@/core/indicators/smc";
import { withAlpha } from "./drawings";

// Canvas rendering for indicator annotations (boxes, structure lines, labels).
// Boxes go behind the candles; lines, segments and labels on top of them.

export interface AnnotationCoords {
  x(index: number): number;
  y(price: number): number;
  right: number; // plot width: where "x2 = null" boxes/lines end
  from: number; // visible bar range, for culling
  to: number;
  font: string;
  /** Label rectangles already drawn this frame (shared across boxes and marks) — overlapping labels are skipped. */
  placed: Array<[number, number, number, number]>;
  /** Hide "level" lines (a trade plan is showing the same levels). */
  skipLevels?: boolean;
}

const SMALL_FONT = (font: string) => font.replace(/\d+px/, "10px");

function text(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  color: string,
  align: CanvasTextAlign,
  baseline: CanvasTextBaseline,
  placed?: AnnotationCoords["placed"],
) {
  if (placed) {
    const width = ctx.measureText(value).width;
    const height = 12;
    const left = align === "center" ? x - width / 2 : align === "right" || align === "end" ? x - width : x;
    const top = baseline === "middle" ? y - height / 2 : baseline === "bottom" ? y - height : y;
    const rect: [number, number, number, number] = [left - 2, top - 1, left + width + 2, top + height + 1];
    if (placed.some(([x1, y1, x2, y2]) => rect[0] < x2 && rect[2] > x1 && rect[1] < y2 && rect[3] > y1)) return;
    placed.push(rect);
  }
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(value, x, y);
}

export function renderAnnotationBoxes(ctx: CanvasRenderingContext2D, ann: Annotations, c: AnnotationCoords) {
  ctx.save();
  ctx.font = SMALL_FONT(c.font);
  for (const box of ann.boxes) {
    if (box.x2 !== null && box.x2 < c.from) continue;
    const left = Math.max(-2, c.x(box.x1));
    const right = box.x2 === null ? c.right : c.x(box.x2);
    if (left > c.right || right < 0) continue;
    const top = c.y(box.top);
    const bottom = c.y(box.bottom);
    ctx.fillStyle = withAlpha(box.color, box.alpha);
    ctx.fillRect(left, Math.min(top, bottom), right - left, Math.abs(bottom - top));
    if (box.border) {
      ctx.strokeStyle = withAlpha(box.color, 0.55);
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(left) + 0.5, Math.round(Math.min(top, bottom)) + 0.5, Math.round(right - left), Math.round(Math.abs(bottom - top)));
    }
    if (box.label && Math.abs(bottom - top) >= 9) {
      text(ctx, box.label, right - 4, (top + bottom) / 2, withAlpha(box.color, 0.95), "right", "middle", c.placed);
    }
  }
  ctx.restore();
}

export function renderAnnotationMarks(ctx: CanvasRenderingContext2D, ann: Annotations, c: AnnotationCoords) {
  ctx.save();
  const small = SMALL_FONT(c.font);

  for (const line of ann.lines) {
    if (c.skipLevels && line.role === "level") continue;
    if (line.x2 !== null && line.x2 < c.from) continue;
    if (line.x1 > c.to) continue;
    const x1 = c.x(line.x1);
    const x2 = line.x2 === null ? c.right : c.x(line.x2);
    const y = Math.round(c.y(line.y)) + 0.5;
    ctx.strokeStyle = line.color;
    ctx.lineWidth = line.bold ? 1.5 : 1;
    ctx.setLineDash(line.dashed ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.stroke();
    if (line.label) {
      ctx.font = line.bold ? `600 ${c.font}` : small;
      // Centre the label on the part of the line that's on screen, so long lines keep their label visible.
      const visibleLeft = Math.max(x1, 0);
      const visibleRight = Math.min(x2, c.right);
      const labelX = line.x2 === null ? Math.min(x2 - 4, Math.max(x1 + 4, x2 - 80)) : (visibleLeft + visibleRight) / 2;
      text(ctx, line.label, labelX, line.labelSide === "above" ? y - 3 : y + 3, line.color, line.x2 === null ? "left" : "center", line.labelSide === "above" ? "bottom" : "top", c.placed);
    }
  }
  ctx.setLineDash([]);

  ctx.font = small;
  for (const segment of ann.segments) {
    if (segment.x2 < c.from || segment.x1 > c.to) continue;
    const x1 = c.x(segment.x1);
    const x2 = c.x(segment.x2);
    const y1 = c.y(segment.y1);
    const y2 = c.y(segment.y2);
    ctx.strokeStyle = segment.color;
    ctx.lineWidth = segment.width ?? 1;
    ctx.setLineDash(segment.dashed === false ? [] : [2, 3]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    if (segment.label) {
      const above = segment.labelSide === "above";
      text(ctx, segment.label, (x1 + x2) / 2, (above ? Math.min(y1, y2) - 3 : Math.max(y1, y2) + 3), segment.color, "center", above ? "bottom" : "top", c.placed);
    }
  }
  ctx.setLineDash([]);

  for (const label of ann.labels) {
    if (label.x > c.to) continue;
    // Keep the whole label on screen (a pattern that starts off to the left still gets its name shown).
    const half = ctx.measureText(label.text).width / 2;
    const x = Math.min(c.right - half - 4, Math.max(half + 4, c.x(label.x)));
    const y = c.y(label.y);
    const above = label.side === "above";
    text(ctx, label.text, x, above ? y - 4 : y + 4, label.color, "center", above ? "bottom" : "top", c.placed);
  }
  ctx.restore();
}
