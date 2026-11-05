"use client";

import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { Icons, LayoutIcon } from "./icons";
import { INTERVAL_META } from "@/core/market/intervals";
import { PRESETS, PRESET_GROUPS, sourceHost, type LayoutPreset } from "./presets";
import {
  LAYOUTS,
  applyPreset,
  applySavedLayout,
  deleteSavedLayout,
  renameSavedLayout,
  resetWorkspace,
  saveCurrentLayout,
  useTerminal,
  type SavedLayout,
} from "./store";
import { Dropdown, Modal } from "./ui";

// "Layouts" menu: research-backed presets per trading style, the user's own
// saved layouts, and the save/rename dialog. Terminal owns the dialog state so
// its global keyboard shortcuts stay quiet while the dialog is open.

export type LayoutDialogState = { mode: "save" } | { mode: "rename"; id: string; name: string };

// ------------------------------------------------------------------ toast

let notice: { text: string; key: number } | null = null;
const noticeListeners = new Set<() => void>();

export function notifyLayout(text: string) {
  notice = { text, key: Date.now() };
  for (const listener of noticeListeners) listener();
}

function subscribeNotice(listener: () => void) {
  noticeListeners.add(listener);
  return () => {
    noticeListeners.delete(listener);
  };
}

export function LayoutToast() {
  const current = useSyncExternalStore(
    subscribeNotice,
    () => notice,
    () => null,
  );
  const [hiddenKey, setHiddenKey] = useState<number | null>(null);

  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => setHiddenKey(current.key), 2600);
    return () => clearTimeout(timer);
  }, [current]);

  if (!current || hiddenKey === current.key) return null;
  return (
    <div className="tx-toast" role="status" key={current.key}>
      <span className="tx-toast-dot" />
      {current.text}
    </div>
  );
}

// ------------------------------------------------------------------ helpers

function cellCount(layout: SavedLayout["layout"]) {
  return LAYOUTS.find((entry) => entry.id === layout)?.cells ?? 1;
}

function presetTimeframes(preset: LayoutPreset) {
  const labels = preset.cells.map((cell) => INTERVAL_META[cell.interval]?.label ?? cell.interval);
  return [...new Set(labels)].join(" · ");
}

function savedSummary(saved: SavedLayout) {
  const cells = saved.cells.slice(0, cellCount(saved.layout));
  const symbols = [...new Set(cells.map((cell) => cell.symbol))];
  const intervals = cells.map((cell) => INTERVAL_META[cell.interval]?.label ?? cell.interval).join(" · ");
  return `${symbols.join(", ")} — ${intervals}`;
}

function presetTooltip(preset: LayoutPreset) {
  const hosts = [...new Set(preset.sources.map(sourceHost))].join(", ");
  return `${preset.rationale}\n\nSources (${preset.sources.length}): ${hosts}`;
}

const PencilIcon = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
    <path d="m13.5 6.5 4 4" />
  </svg>
);

const BookmarkIcon = () => (
  <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3.5" y="4" width="17" height="16" rx="2" />
    <path d="M3.5 9h17M10 9v11" />
  </svg>
);

// ------------------------------------------------------------------ menu

export function LayoutsMenu({ onDialog }: { onDialog: (dialog: LayoutDialogState) => void }) {
  return (
    <Dropdown
      title="Layouts: presets for each trading style, and your saved layouts"
      trigger={
        <>
          <BookmarkIcon />
          <span>Layouts</span>
          <Icons.chevronDown size={13} />
        </>
      }
    >
      {(close) => <LayoutsMenuBody close={close} onDialog={onDialog} />}
    </Dropdown>
  );
}

function LayoutsMenuBody({ close, onDialog }: { close: () => void; onDialog: (dialog: LayoutDialogState) => void }) {
  const saved = useTerminal((state) => state.savedLayouts);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  return (
    <div className="tx-layouts-menu">
      <button
        type="button"
        className="tx-menu-item tx-layouts-save"
        data-action="save-layout"
        onClick={() => {
          close();
          onDialog({ mode: "save" });
        }}
      >
        <Icons.plus size={15} />
        Save current layout…
      </button>

      <div className="tx-menu-sep" />
      <div className="tx-menu-group">My layouts</div>
      {saved.length === 0 && <div className="tx-menu-note">No saved layouts yet. Arrange your charts, then save them here.</div>}
      {saved.map((entry) =>
        confirmId === entry.id ? (
          <div key={entry.id} className="tx-saved-row tx-saved-confirm">
            <span className="tx-saved-confirm-text">Delete “{entry.name}”?</span>
            <button
              type="button"
              className="tx-btn tx-btn-sm tx-btn-danger"
              data-action="confirm-delete"
              onClick={() => {
                deleteSavedLayout(entry.id);
                setConfirmId(null);
                notifyLayout(`Deleted “${entry.name}”`);
              }}
            >
              Delete
            </button>
            <button type="button" className="tx-btn tx-btn-sm" onClick={() => setConfirmId(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <div key={entry.id} className="tx-saved-row" data-saved={entry.name}>
            <button
              type="button"
              className="tx-menu-item tx-preset-item"
              title={`Load “${entry.name}”`}
              onClick={() => {
                if (applySavedLayout(entry.id)) notifyLayout(`Loaded “${entry.name}”`);
                close();
              }}
            >
              <LayoutIcon layout={entry.layout} />
              <span className="tx-preset-text">
                <span className="tx-preset-name">{entry.name}</span>
                <span className="tx-preset-desc">{savedSummary(entry)}</span>
              </span>
            </button>
            <button
              type="button"
              className="tx-icon-btn tx-saved-action"
              title="Rename"
              aria-label={`Rename ${entry.name}`}
              data-action="rename"
              onClick={() => {
                close();
                onDialog({ mode: "rename", id: entry.id, name: entry.name });
              }}
            >
              <PencilIcon />
            </button>
            <button
              type="button"
              className="tx-icon-btn tx-saved-action"
              title="Delete"
              aria-label={`Delete ${entry.name}`}
              data-action="delete"
              onClick={() => setConfirmId(entry.id)}
            >
              <Icons.trash size={14} />
            </button>
          </div>
        ),
      )}

      {PRESET_GROUPS.map((group) => {
        const presets = PRESETS.filter((preset) => preset.group === group);
        if (presets.length === 0) return null;
        return (
          <div key={group}>
            <div className="tx-menu-sep" />
            <div className="tx-menu-group">{group}</div>
            {presets.map((preset) => (
              <button
                type="button"
                key={preset.id}
                className="tx-menu-item tx-preset-item"
                data-preset={preset.id}
                title={presetTooltip(preset)}
                onClick={() => {
                  if (applyPreset(preset.id)) notifyLayout(`Applied preset “${preset.name}”`);
                  close();
                }}
              >
                <LayoutIcon layout={preset.layout} />
                <span className="tx-preset-text">
                  <span className="tx-preset-name">
                    {preset.name}
                    <span className="tx-preset-tf">{presetTimeframes(preset)}</span>
                  </span>
                  <span className="tx-preset-desc">{preset.description}</span>
                </span>
              </button>
            ))}
          </div>
        );
      })}

      <div className="tx-menu-sep" />
      <div className="tx-menu-note tx-preset-disclaimer">
        Two layouts for futures held at least overnight — BTST and 15–20 day swing; every indicator has one job (Weinstein, Minervini,
        Zerodha Varsity, ChartSchool). Chart patterns and S/R are drawn on every chart. Hover a preset for its reasoning and sources.
        Educational, not trading advice.
      </div>
      <button
        type="button"
        className="tx-menu-item"
        data-action="reset-workspace"
        onClick={() => {
          resetWorkspace();
          notifyLayout("Charts reset to default");
          close();
        }}
      >
        <Icons.reset size={15} />
        Reset charts to default
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ save / rename dialog

export function LayoutNameDialog({ dialog, onClose }: { dialog: LayoutDialogState; onClose: () => void }) {
  const saved = useTerminal((state) => state.savedLayouts);
  const [name, setName] = useState(dialog.mode === "rename" ? dialog.name : "");
  const clean = name.trim();
  const clash = saved.find(
    (entry) => entry.name.toLowerCase() === clean.toLowerCase() && (dialog.mode === "save" || entry.id !== dialog.id),
  );

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!clean) return;
    if (dialog.mode === "save") {
      const entry = saveCurrentLayout(clean);
      if (entry) notifyLayout(clash ? `Updated layout “${entry.name}”` : `Saved layout “${entry.name}”`);
    } else {
      if (clash) return;
      if (renameSavedLayout(dialog.id, clean)) notifyLayout(`Renamed to “${clean}”`);
    }
    onClose();
  };

  return (
    <Modal title={dialog.mode === "save" ? "Save layout" : "Rename layout"} onClose={onClose} width={380}>
      <form onSubmit={submit}>
        <div className="tx-modal-body">
          <label className="tx-layout-name-field">
            <span className="tx-section-label">Name</span>
            <input
              autoFocus
              className="tx-input tx-layout-name-input"
              value={name}
              maxLength={60}
              placeholder="e.g. Morning NIFTY scalps"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {dialog.mode === "save" && (
            <p className="tx-layout-hint">
              {clash
                ? `Replaces your saved layout “${clash.name}”.`
                : "Saves the grid, symbols, timeframes, chart types and indicators. Drawings stay with each symbol."}
            </p>
          )}
          {dialog.mode === "rename" && clash && <p className="tx-layout-hint tx-layout-hint-warn">Another layout already uses this name.</p>}
        </div>
        <div className="tx-modal-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="tx-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="tx-btn tx-btn-primary" disabled={!clean || (dialog.mode === "rename" && Boolean(clash))}>
            {dialog.mode === "save" ? "Save" : "Rename"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
