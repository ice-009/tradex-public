"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Tool } from "@/chart/types";
import { DRAWING_LABELS } from "@/chart/drawings";
import { setTool, toggleMagnet, useTerminal } from "./store";
import { canRedo, canUndo, commitDrawings, redoDrawings, subscribeHistory, undoDrawings } from "./drawingHistory";
import { setGroupTool, setHideDrawings, usePrefs } from "./uiPrefs";
import { Icons, ToolIcon } from "./icons";

interface ToolGroup {
  id: string;
  label: string;
  tools: Tool[];
}

// Sections separated by a rule; each group is one button (with a flyout when it holds several tools).
const SECTIONS: ToolGroup[][] = [
  [{ id: "cursor", label: "Cursor", tools: ["cursor"] }],
  [
    { id: "lines", label: "Lines", tools: ["trendline", "ray", "extended", "arrow", "hline", "hray", "vline"] },
    { id: "channels", label: "Channels", tools: ["channel"] },
    { id: "fib", label: "Fibonacci", tools: ["fib"] },
  ],
  [
    { id: "shapes", label: "Shapes", tools: ["rect", "brush"] },
    { id: "text", label: "Text", tools: ["text"] },
  ],
  [
    { id: "long", label: "Long position", tools: ["long"] },
    { id: "short", label: "Short position", tools: ["short"] },
    { id: "measure", label: "Measure", tools: ["measure", "pricerange", "daterange"] },
  ],
];

const SHORTCUTS: Partial<Record<Tool, string>> = { trendline: "Alt+T", hline: "Alt+H", fib: "Alt+F", rect: "Alt+R" };

const toolLabel = (tool: Tool) => (tool === "cursor" ? "Cursor" : DRAWING_LABELS[tool]);

function useHistoryFlags(symbol: string) {
  const undo = useSyncExternalStore(subscribeHistory, () => canUndo(symbol), () => false);
  const redo = useSyncExternalStore(subscribeHistory, () => canRedo(symbol), () => false);
  return { undo, redo };
}

export function DrawingToolbar() {
  const tool = useTerminal((state) => state.tool);
  const magnet = useTerminal((state) => state.magnet);
  const symbol = useTerminal((state) => state.cells[state.activeCell].symbol);
  const drawings = useTerminal((state) => state.drawings[state.cells[state.activeCell].symbol]);
  const groupTools = usePrefs((prefs) => prefs.groupTools);
  const hideAll = usePrefs((prefs) => prefs.hideDrawings);
  const history = useHistoryFlags(symbol);
  const [flyout, setFlyout] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);

  const count = drawings?.length ?? 0;
  const hiddenCount = drawings?.filter((drawing) => drawing.hidden).length ?? 0;

  useEffect(() => {
    if (!flyout) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setFlyout(null);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setFlyout(null);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [flyout]);

  const shownTool = (group: ToolGroup): Tool => {
    if (group.tools.includes(tool)) return tool;
    const remembered = groupTools[group.id];
    return remembered && group.tools.includes(remembered) ? remembered : group.tools[0];
  };

  const toggleVisibility = () => {
    if (hideAll) {
      setHideDrawings(false);
    } else if (hiddenCount && drawings) {
      commitDrawings(symbol, drawings.map((drawing) => (drawing.hidden ? { ...drawing, hidden: false } : drawing)));
    } else {
      setHideDrawings(true);
    }
  };
  const visibilityTitle = hideAll
    ? "Show all drawings"
    : hiddenCount
      ? `Show ${hiddenCount} hidden drawing${hiddenCount === 1 ? "" : "s"}`
      : "Hide all drawings";

  return (
    <nav className="tx-tools" aria-label="Drawing tools" ref={rootRef}>
      {SECTIONS.map((section, index) => (
        <div key={index} className="tx-tools-group">
          {section.map((group) => {
            const shown = shownTool(group);
            const label = toolLabel(shown);
            const shortcut = SHORTCUTS[shown];
            const multi = group.tools.length > 1;
            return (
              <div key={group.id} className="tx-tool-wrap">
                <button
                  type="button"
                  className={`tx-tool ${group.tools.includes(tool) ? "is-active" : ""}`}
                  title={shortcut ? `${label} (${shortcut})` : label}
                  aria-label={label}
                  onClick={() => {
                    setFlyout(null);
                    setTool(shown);
                  }}
                >
                  <ToolIcon tool={shown} size={19} />
                </button>
                {multi && (
                  <button
                    type="button"
                    className={`tx-tool-caret ${flyout === group.id ? "is-open" : ""}`}
                    title={`More ${group.label.toLowerCase()}`}
                    aria-label={`More ${group.label.toLowerCase()}`}
                    onClick={() => setFlyout((current) => (current === group.id ? null : group.id))}
                  >
                    <Icons.caret size={9} />
                  </button>
                )}
                {flyout === group.id && (
                  <div className="tx-flyout" role="menu" aria-label={group.label}>
                    <div className="tx-flyout-title">{group.label}</div>
                    {group.tools.map((item) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={item}
                        className={`tx-flyout-item ${tool === item ? "is-active" : ""}`}
                        onClick={() => {
                          setGroupTool(group.id, item);
                          setTool(item);
                          setFlyout(null);
                        }}
                      >
                        <ToolIcon tool={item} size={18} />
                        <span>{toolLabel(item)}</span>
                        {SHORTCUTS[item] && <kbd>{SHORTCUTS[item]}</kbd>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      <div className="tx-tools-group">
        <button
          type="button"
          className="tx-tool"
          title="Undo (Ctrl/Cmd+Z)"
          aria-label="Undo drawing change"
          disabled={!history.undo}
          onClick={() => undoDrawings(symbol)}
        >
          <Icons.undo size={18} />
        </button>
        <button
          type="button"
          className="tx-tool"
          title="Redo (Ctrl/Cmd+Shift+Z)"
          aria-label="Redo drawing change"
          disabled={!history.redo}
          onClick={() => redoDrawings(symbol)}
        >
          <Icons.redo size={18} />
        </button>
        <button
          type="button"
          className={`tx-tool ${magnet ? "is-active" : ""}`}
          title="Magnet: snap anchors to OHLC"
          aria-label="Magnet mode"
          onClick={toggleMagnet}
        >
          <Icons.magnet size={19} />
        </button>
        <button
          type="button"
          className={`tx-tool ${hideAll || hiddenCount ? "is-active" : ""}`}
          title={visibilityTitle}
          aria-label={visibilityTitle}
          disabled={!count && !hideAll}
          onClick={toggleVisibility}
        >
          {hideAll || hiddenCount ? <Icons.eyeOff size={19} /> : <Icons.eye size={19} />}
        </button>
        <button
          type="button"
          className="tx-tool"
          title={`Remove all drawings on ${symbol}`}
          aria-label="Remove all drawings"
          disabled={!count}
          onClick={() => {
            if (window.confirm(`Remove all ${count} drawing${count === 1 ? "" : "s"} on ${symbol}?`)) commitDrawings(symbol, []);
          }}
        >
          <Icons.trash size={19} />
        </button>
      </div>
    </nav>
  );
}

