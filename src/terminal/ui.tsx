"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icons } from "./icons";

export interface TerminalUI {
  openSearch(options?: { query?: string; mode?: "chart" | "watchlist" }): void;
  openIndicators(): void;
  openGuide(guide: "smc"): void;
}

export const TerminalUIContext = createContext<TerminalUI>({
  openSearch: () => {},
  openIndicators: () => {},
  openGuide: () => {},
});

export const useTerminalUI = () => useContext(TerminalUIContext);

export function Modal({
  title,
  onClose,
  children,
  width = 520,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="tx-modal-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="tx-modal" style={{ width }} role="dialog" aria-label={title}>
        <div className="tx-modal-head">
          <h2>{title}</h2>
          <button type="button" className="tx-icon-btn" onClick={onClose} aria-label="Close">
            <Icons.x size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Dropdown({
  trigger,
  title,
  children,
  align = "left",
  className = "",
}: {
  trigger: ReactNode;
  title?: string;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="tx-dropdown" ref={ref}>
      <button
        type="button"
        className={`tx-tb-btn ${open ? "is-open" : ""} ${className}`}
        title={title}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
      </button>
      {open && <div className={`tx-menu tx-menu-${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}
