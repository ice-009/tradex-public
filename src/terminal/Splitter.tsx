"use client";

import { useRef, type CSSProperties } from "react";

/**
 * A draggable divider (TradingView-style). `axis="x"` is a vertical bar you
 * drag sideways, `axis="y"` a horizontal bar you drag up/down. It reports the
 * pointer's movement in px since the drag began; the parent turns that into a
 * size. Double-click (or double-tap) resets.
 */
export function Splitter({
  axis,
  onStart,
  onDrag,
  onReset,
  className = "",
  style,
  label,
}: {
  axis: "x" | "y";
  onStart?: () => void;
  onDrag: (delta: number) => void;
  onReset?: () => void;
  className?: string;
  style?: CSSProperties;
  label: string;
}) {
  const start = useRef<number | null>(null);
  const lastTap = useRef(0);

  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      title={`${label} — drag to resize, double-click to reset`}
      className={`tx-splitter tx-splitter-${axis} ${className}`}
      style={style}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        // Touch has no dblclick: two taps within 300 ms reset.
        if (event.pointerType === "touch") {
          const now = Date.now();
          if (now - lastTap.current < 300) {
            onReset?.();
            lastTap.current = 0;
            return;
          }
          lastTap.current = now;
        }
        start.current = axis === "x" ? event.clientX : event.clientY;
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        document.body.classList.add(axis === "x" ? "is-resizing-x" : "is-resizing-y");
        onStart?.();
      }}
      onPointerMove={(event) => {
        if (start.current === null) return;
        onDrag((axis === "x" ? event.clientX : event.clientY) - start.current);
      }}
      onPointerUp={() => {
        start.current = null;
        document.body.classList.remove("is-resizing-x", "is-resizing-y");
      }}
      onPointerCancel={() => {
        start.current = null;
        document.body.classList.remove("is-resizing-x", "is-resizing-y");
      }}
      onDoubleClick={onReset}
    />
  );
}
