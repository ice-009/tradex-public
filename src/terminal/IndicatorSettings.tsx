"use client";

import { useState } from "react";
import { INDICATORS, indicatorTitle } from "@/core/indicators/indicators";
import type { IndicatorConfig } from "@/core/types";
import { Modal } from "./ui";

export function IndicatorSettings({
  config,
  onClose,
  onApply,
}: {
  config: IndicatorConfig;
  onClose: () => void;
  onApply: (patch: Partial<IndicatorConfig>) => void;
}) {
  const def = INDICATORS[config.type];
  const [params, setParams] = useState<Record<string, number>>(config.params);
  const [colors, setColors] = useState<Record<string, string>>(config.colors);

  const colorKeys = def.outputs.flatMap((output) =>
    output.negColor
      ? [
          { key: output.key, label: `${output.label} (positive)` },
          { key: `${output.key}Neg`, label: `${output.label} (negative)` },
        ]
      : [{ key: output.key, label: output.label }],
  );

  const apply = () => {
    const clean = Object.fromEntries(
      def.params.map((param) => {
        const value = Number(params[param.key]);
        const bounded = Number.isFinite(value) ? Math.min(param.max, Math.max(param.min, value)) : param.default;
        return [param.key, param.step ? bounded : Math.round(bounded)];
      }),
    );
    onApply({ params: clean, colors });
    onClose();
  };

  return (
    <Modal title={`${indicatorTitle(config)} settings`} onClose={onClose} width={380}>
      <div className="tx-modal-body">
        {def.params.length > 0 && <div className="tx-section-label">Inputs</div>}
        {def.params.map((param) => (
          <label key={param.key} className="tx-field">
            <span>{param.label}</span>
            {param.toggle ? (
              <input
                type="checkbox"
                className="tx-check-input"
                checked={params[param.key] === 1}
                onChange={(event) => setParams((current) => ({ ...current, [param.key]: event.target.checked ? 1 : 0 }))}
              />
            ) : (
            <input
              type="number"
              className="tx-input tx-input-num"
              value={Number.isFinite(params[param.key]) ? params[param.key] : ""}
              min={param.min}
              max={param.max}
              step={param.step ?? 1}
              onChange={(event) => setParams((current) => ({ ...current, [param.key]: Number(event.target.value) }))}
              onKeyDown={(event) => event.key === "Enter" && apply()}
            />
            )}
          </label>
        ))}
        {colorKeys.length > 0 && <div className="tx-section-label">Style</div>}
        {colorKeys.map((entry) => (
          <label key={entry.key} className="tx-field">
            <span>{entry.label}</span>
            <input
              type="color"
              className="tx-color"
              value={colors[entry.key] ?? "#2962ff"}
              onChange={(event) => setColors((current) => ({ ...current, [entry.key]: event.target.value }))}
            />
          </label>
        ))}
      </div>
      <div className="tx-modal-foot">
        <button
          type="button"
          className="tx-btn"
          onClick={() => {
            setParams(Object.fromEntries(def.params.map((param) => [param.key, param.default])));
            setColors(
              Object.fromEntries(
                def.outputs.flatMap((output) =>
                  output.negColor ? [[output.key, output.color], [`${output.key}Neg`, output.negColor]] : [[output.key, output.color]],
                ),
              ),
            );
          }}
        >
          Defaults
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" className="tx-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="tx-btn tx-btn-primary" onClick={apply}>
          Apply
        </button>
      </div>
    </Modal>
  );
}
