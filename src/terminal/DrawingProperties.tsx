"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Drawing, LineExtend, LineStyle } from "@/chart/types";
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_LINE_WIDTH,
  DRAWING_LABELS,
  PALETTE_COLORS,
  drawingCaps,
  isPosition,
  positionStats,
} from "@/chart/drawings";
import { updateDrawing } from "./drawingHistory";
import { Icons } from "./icons";

// Floating toolbar shown over a chart while a drawing is selected (TradingView's
// "drawing toolbar"): colour, width, style, extend, text, lock, hide, clone, delete.
// Every edit goes through the undoable drawing history.

const WIDTHS = [1, 2, 3, 4];
const STYLES: Array<{ value: LineStyle; label: string; dash: string }> = [
  { value: "solid", label: "Solid", dash: "" },
  { value: "dashed", label: "Dashed", dash: "6 4" },
  { value: "dotted", label: "Dotted", dash: "1.5 3" },
];
const EXTENDS: Array<{ value: LineExtend; label: string }> = [
  { value: "none", label: "Don't extend" },
  { value: "right", label: "Extend right" },
  { value: "left", label: "Extend left" },
  { value: "both", label: "Extend both ways" },
];
const FONT_SIZES = [10, 12, 14, 16, 20, 24, 28, 32];

type Popover = "color" | "width" | "style" | "extend" | null;

export function DrawingProperties({
  drawing,
  symbol,
  position,
  focusText,
  onClone,
  onDelete,
}: {
  drawing: Drawing;
  symbol: string;
  position: { left: number; top: number };
  focusText: number; // bump to focus the text field
  onClone(): void;
  onDelete(): void;
}) {
  const [popover, setPopover] = useState<Popover>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLInputElement>(null);
  const caps = drawingCaps(drawing.type);
  const patch = (next: Partial<Drawing>, coalesceKey?: string) => updateDrawing(symbol, drawing.id, next, coalesceKey);

  useEffect(() => {
    if (!focusText) return;
    // Deferred: the canvas pointerdown that created the drawing is followed by a
    // mousedown whose default action would steal focus back to <body>.
    const timer = window.setTimeout(() => {
      textRef.current?.focus();
      textRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusText]);

  useEffect(() => {
    if (!popover) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setPopover(null);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [popover]);

  const startDrag = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX - offset.x;
    const startY = event.clientY - offset.y;
    const onMove = (move: PointerEvent) => setOffset({ x: move.clientX - startX, y: move.clientY - startY });
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const toggle = (next: Popover) => setPopover((current) => (current === next ? null : next));
  const width = drawing.lineWidth ?? DEFAULT_LINE_WIDTH;
  const style = STYLES.find((entry) => entry.value === (drawing.lineStyle ?? "solid")) ?? STYLES[0];
  const extend = drawing.extend ?? "none";

  const flipPosition = () => {
    if (!isPosition(drawing)) return;
    const [entry, target, stop] = drawing.points;
    patch({
      type: drawing.type === "long" ? "short" : "long",
      points: [entry, { ...target, p: 2 * entry.p - target.p }, { ...stop, p: 2 * entry.p - stop.p }],
    });
  };

  return (
    <div
      ref={rootRef}
      className="tx-dprops"
      style={{ left: position.left + offset.x, top: position.top + offset.y }}
      role="toolbar"
      aria-label={`${DRAWING_LABELS[drawing.type]} properties`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="tx-dprops-grip" onPointerDown={startDrag} title="Drag toolbar">
        <Icons.grip size={14} />
      </span>
      <span className="tx-dprops-name">{DRAWING_LABELS[drawing.type]}</span>

      {caps.color && (
        <div className="tx-dprops-item">
          <button type="button" className="tx-dprops-btn" title="Color" aria-label="Color" onClick={() => toggle("color")}>
            <span className="tx-dprops-swatch" style={{ background: drawing.color }} />
          </button>
          {popover === "color" && (
            <div className="tx-dprops-pop tx-dprops-colors">
              {PALETTE_COLORS.map((color) => (
                <button
                  type="button"
                  key={color}
                  className={`tx-dprops-color ${color === drawing.color ? "is-active" : ""}`}
                  style={{ background: color }}
                  title={color}
                  aria-label={`Color ${color}`}
                  onClick={() => {
                    patch({ color });
                    setPopover(null);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {caps.line && (
        <div className="tx-dprops-item">
          <button type="button" className="tx-dprops-btn" title="Line width" aria-label="Line width" onClick={() => toggle("width")}>
            <svg width={22} height={14} aria-hidden="true">
              <line x1={2} x2={20} y1={7} y2={7} stroke="currentColor" strokeWidth={width} />
            </svg>
            <span className="tx-dprops-small">{width}px</span>
          </button>
          {popover === "width" && (
            <div className="tx-dprops-pop">
              {WIDTHS.map((value) => (
                <button
                  type="button"
                  key={value}
                  className={`tx-dprops-row ${value === width ? "is-active" : ""}`}
                  onClick={() => {
                    patch({ lineWidth: value });
                    setPopover(null);
                  }}
                >
                  <svg width={40} height={12} aria-hidden="true">
                    <line x1={2} x2={38} y1={6} y2={6} stroke="currentColor" strokeWidth={value} />
                  </svg>
                  {value}px
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {caps.line && (
        <div className="tx-dprops-item">
          <button type="button" className="tx-dprops-btn" title="Line style" aria-label="Line style" onClick={() => toggle("style")}>
            <svg width={22} height={14} aria-hidden="true">
              <line x1={2} x2={20} y1={7} y2={7} stroke="currentColor" strokeWidth={2} strokeDasharray={style.dash} />
            </svg>
          </button>
          {popover === "style" && (
            <div className="tx-dprops-pop">
              {STYLES.map((entry) => (
                <button
                  type="button"
                  key={entry.value}
                  className={`tx-dprops-row ${entry.value === style.value ? "is-active" : ""}`}
                  onClick={() => {
                    patch({ lineStyle: entry.value });
                    setPopover(null);
                  }}
                >
                  <svg width={40} height={12} aria-hidden="true">
                    <line x1={2} x2={38} y1={6} y2={6} stroke="currentColor" strokeWidth={2} strokeDasharray={entry.dash} />
                  </svg>
                  {entry.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {caps.extend && (
        <div className="tx-dprops-item">
          <button
            type="button"
            className={`tx-dprops-btn ${extend !== "none" ? "is-on" : ""}`}
            title="Extend lines"
            aria-label="Extend lines"
            onClick={() => toggle("extend")}
          >
            <Icons.extendRight size={16} />
          </button>
          {popover === "extend" && (
            <div className="tx-dprops-pop">
              {EXTENDS.map((entry) => (
                <button
                  type="button"
                  key={entry.value}
                  className={`tx-dprops-row ${entry.value === extend ? "is-active" : ""}`}
                  onClick={() => {
                    patch({ extend: entry.value });
                    setPopover(null);
                  }}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {caps.text && (
        <>
          <input
            ref={textRef}
            className="tx-dprops-text"
            value={drawing.text ?? ""}
            placeholder="Text"
            aria-label="Text"
            onChange={(event) => patch({ text: event.target.value }, `text:${drawing.id}`)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "Escape") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
          <select
            className="tx-dprops-select"
            value={drawing.fontSize ?? DEFAULT_FONT_SIZE}
            aria-label="Font size"
            title="Font size"
            onChange={(event) => patch({ fontSize: Number(event.target.value) })}
          >
            {FONT_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </>
      )}

      {isPosition(drawing) && (
        <>
          <span className="tx-dprops-stat">R:R {positionStats(drawing).rr.toFixed(2)}</span>
          <button type="button" className="tx-dprops-btn" title="Flip long/short" aria-label="Flip long/short" onClick={flipPosition}>
            {drawing.type === "long" ? <Icons.short size={16} /> : <Icons.long size={16} />}
          </button>
        </>
      )}

      <span className="tx-dprops-sep" />
      <button
        type="button"
        className={`tx-dprops-btn ${drawing.locked ? "is-on" : ""}`}
        title={drawing.locked ? "Unlock" : "Lock"}
        aria-label={drawing.locked ? "Unlock" : "Lock"}
        onClick={() => patch({ locked: !drawing.locked })}
      >
        {drawing.locked ? <Icons.lock size={16} /> : <Icons.unlock size={16} />}
      </button>
      <button type="button" className="tx-dprops-btn" title="Hide" aria-label="Hide" onClick={() => patch({ hidden: true })}>
        <Icons.eyeOff size={16} />
      </button>
      <button type="button" className="tx-dprops-btn" title="Clone" aria-label="Clone" onClick={onClone}>
        <Icons.clone size={16} />
      </button>
      <button type="button" className="tx-dprops-btn is-danger" title="Remove (Del)" aria-label="Remove" onClick={onDelete}>
        <Icons.trash size={16} />
      </button>
    </div>
  );
}
