"use client";

import { useState } from "react";
import { PRESET_MAP } from "./presets";
import { setLayoutGuide, useTerminal } from "./store";
import { Icons } from "./icons";
import { useTerminalUI } from "./ui";

/** Floating "how to read this layout" checklist shown after applying a preset. */
export function LayoutGuide() {
  const presetId = useTerminal((state) => state.layoutGuide);
  const ui = useTerminalUI();
  // Starts as a one-line pill so it never covers the chart until you open it.
  const [collapsed, setCollapsed] = useState(true);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const preset = presetId ? PRESET_MAP[presetId] : null;
  if (!preset?.steps?.length) return null;

  const done = preset.steps.filter((_, index) => checked[`${preset.id}:${index}`]).length;

  return (
    <div className={`tx-lguide ${collapsed ? "is-collapsed" : ""}`} role="complementary" aria-label={`${preset.name} checklist`}>
      <div className="tx-lguide-head">
        <button type="button" className="tx-lguide-title" onClick={() => setCollapsed((value) => !value)} title={collapsed ? "Expand" : "Collapse"}>
          <Icons.chevronDown size={14} style={{ transform: collapsed ? "rotate(-90deg)" : undefined }} />
          How to read: {preset.name}
          <span className="tx-lguide-count">
            {done}/{preset.steps.length}
          </span>
        </button>
        <button type="button" className="tx-icon-btn" title="Hide checklist" onClick={() => setLayoutGuide(null)}>
          <Icons.x size={14} />
        </button>
      </div>
      {!collapsed && (
        <>
          <ol className="tx-lguide-steps">
            {preset.steps.map((step, index) => {
              const key = `${preset.id}:${index}`;
              return (
                <li key={key} className={checked[key] ? "is-done" : ""}>
                  <label>
                    <input
                      type="checkbox"
                      className="tx-check-input"
                      checked={Boolean(checked[key])}
                      onChange={(event) => setChecked((current) => ({ ...current, [key]: event.target.checked }))}
                    />
                    <span>{step}</span>
                  </label>
                </li>
              );
            })}
          </ol>
          {preset.guide && (
            <button type="button" className="tx-btn tx-lguide-learn" onClick={() => ui.openGuide(preset.guide as "smc")}>
              New to SMC? Open the lesson
            </button>
          )}
        </>
      )}
    </div>
  );
}
