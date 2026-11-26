"use client";

import "./sectorRotation.css";
import type { SectorStat } from "@/core/screener/screens";
import { QUADRANT_LABEL, type Quadrant, type SectorRrg } from "@/core/sector/rrg";

// The Sectors panel's Relative Rotation Graph (issue #30): each sector index
// against NIFTY 500 — x = RS-Ratio (relative strength vs its own last quarter),
// y = RS-Momentum (how fast that is changing) — with a five-week tail, and each
// sector's weekly quadrant timeline. The maths is src/core/sector/rrg.ts: a
// documented approximation of RRG, not RRG Research's proprietary formula.
// Context only: in the Signal Lab, trading the quadrants showed no edge after
// costs (docs/research/sector-rotation.md).

/** Weekly points in a tail (the newest included): five weeks back. */
const TAIL = 6;
const SIZE = 280;
const PAD = 14;

export const RRG_NOTE =
  "Relative Rotation Graph against NIFTY 500 (end of day). RS-Ratio: the sector's relative strength (smoothed) against its own last 63 sessions, in standard deviations around 100. RS-Momentum: how fast RS-Ratio is changing, likewise. Sectors usually turn clockwise: Improving → Leading → Weakening → Lagging. An approximation of RRG — not RRG Research's formula. In the Signal Lab (2013–2026, F&O stocks, futures costs) buying a sector's stocks by quadrant showed no edge: read it as context, not a signal.";

const SHORT: Record<string, string> = {
  "Financial Services": "Fin",
  "Capital Goods": "CapG",
  Healthcare: "Hlth",
  "Automobile and Auto Components": "Auto",
  "Fast Moving Consumer Goods": "FMCG",
  Chemicals: "Chem",
  "Information Technology": "IT",
  "Consumer Services": "CSvc",
  "Metals & Mining": "Metal",
  Power: "Power",
  "Oil Gas & Consumable Fuels": "O&G",
  "Consumer Durables": "CDur",
  Services: "Svcs",
  Realty: "Realty",
  Construction: "Cons",
  "Construction Materials": "Cem",
  Telecommunication: "Tel",
  Textiles: "Tex",
  "Media Entertainment & Publication": "Media",
};

export const shortSector = (sector: string) => SHORT[sector] ?? sector.split(/\s+/)[0].slice(0, 6);

const QUADRANT_HINT: Record<Quadrant, string> = {
  leading: "outperforming NIFTY 500 and still gaining",
  weakening: "outperforming, but losing pace",
  lagging: "underperforming and still losing",
  improving: "underperforming, but gaining",
};

export function QuadrantTag({ rrg }: { rrg: SectorRrg }) {
  return (
    <span className={`tx-rrg-tag is-${rrg.quadrant}`} title={`${QUADRANT_LABEL[rrg.quadrant]}: ${QUADRANT_HINT[rrg.quadrant]} (RS-Ratio ${rrg.ratio.toFixed(2)}, RS-Momentum ${rrg.momentum.toFixed(2)}). ${RRG_NOTE}`}>
      {QUADRANT_LABEL[rrg.quadrant]}
    </span>
  );
}

const isoDay = (day: number) => new Date(day).toISOString().slice(0, 10);

/** The sector's quadrant week by week (oldest left): its rotation timeline. */
export function RotationTimeline({ rrg }: { rrg: SectorRrg }) {
  return (
    <div className="tx-rrg-timeline" aria-label="Weekly RRG quadrant, oldest first">
      <span className="tx-rrg-timeline-label">{rrg.trail.length}w</span>
      <span className="tx-rrg-cells">
        {rrg.trail.map((point) => (
          <i key={point.t} className={`is-${point.quadrant}`} title={`${isoDay(point.t)}: ${QUADRANT_LABEL[point.quadrant]} (RS-Ratio ${point.ratio.toFixed(2)}, RS-Momentum ${point.momentum.toFixed(2)})`} />
        ))}
      </span>
    </div>
  );
}

/** Scatter of RS-Ratio vs RS-Momentum with five-week tails; a click picks a sector. */
export function RotationChart({ sectors, selected, onSelect }: { sectors: SectorStat[]; selected: string | null; onSelect: (sector: string) => void }) {
  const plotted = sectors.flatMap((sector) => (sector.index?.rrg ? [{ sector: sector.sector, rrg: sector.index.rrg, synthetic: sector.index.synthetic, tail: sector.index.rrg.trail.slice(-TAIL) }] : []));
  if (!plotted.length) return <div className="tx-empty">No sector index history for a rotation graph yet.</div>;
  const reach = Math.max(1.5, ...plotted.flatMap(({ tail }) => tail.flatMap((point) => [Math.abs(point.ratio - 100), Math.abs(point.momentum - 100)]))) * 1.12;
  const half = SIZE / 2 - PAD;
  const x = (ratio: number) => SIZE / 2 + ((ratio - 100) / reach) * half;
  const y = (momentum: number) => SIZE / 2 - ((momentum - 100) / reach) * half;
  const mid = SIZE / 2;
  // The selected sector is drawn last, on top.
  const order = [...plotted].sort((a, b) => Number(a.sector === selected) - Number(b.sector === selected));

  return (
    <figure className="tx-rrg">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="Relative Rotation Graph of the sectors against NIFTY 500">
        <rect className="tx-rrg-q is-leading" x={mid} y={0} width={mid} height={mid} />
        <rect className="tx-rrg-q is-weakening" x={mid} y={mid} width={mid} height={mid} />
        <rect className="tx-rrg-q is-lagging" x={0} y={mid} width={mid} height={mid} />
        <rect className="tx-rrg-q is-improving" x={0} y={0} width={mid} height={mid} />
        <line className="tx-rrg-axis" x1={mid} y1={0} x2={mid} y2={SIZE} />
        <line className="tx-rrg-axis" x1={0} y1={mid} x2={SIZE} y2={mid} />
        <text className="tx-rrg-qlabel is-leading" x={SIZE - 6} y={13} textAnchor="end">Leading</text>
        <text className="tx-rrg-qlabel is-weakening" x={SIZE - 6} y={SIZE - 6} textAnchor="end">Weakening</text>
        <text className="tx-rrg-qlabel is-lagging" x={6} y={SIZE - 6}>Lagging</text>
        <text className="tx-rrg-qlabel is-improving" x={6} y={13}>Improving</text>
        {order.map(({ sector, rrg, synthetic, tail }) => {
          const head = tail[tail.length - 1];
          const dim = selected !== null && selected !== sector;
          return (
            <g
              key={sector}
              className={`tx-rrg-sector is-${rrg.quadrant} ${dim ? "is-dim" : ""} ${selected === sector ? "is-selected" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(sector)}
              onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && onSelect(sector)}
            >
              <title>{`${sector}${synthetic ? " (synthetic basket)" : ""}: ${QUADRANT_LABEL[rrg.quadrant]} · RS-Ratio ${rrg.ratio.toFixed(2)} · RS-Momentum ${rrg.momentum.toFixed(2)} · tail: last ${tail.length - 1} weeks`}</title>
              <polyline className="tx-rrg-tail" points={tail.map((point) => `${x(point.ratio).toFixed(1)},${y(point.momentum).toFixed(1)}`).join(" ")} />
              {tail.slice(0, -1).map((point) => (
                <circle key={point.t} className="tx-rrg-step" cx={x(point.ratio)} cy={y(point.momentum)} r={1.6} />
              ))}
              <circle className="tx-rrg-head" cx={x(head.ratio)} cy={y(head.momentum)} r={4} />
              <text className="tx-rrg-name" x={x(head.ratio) + 6} y={y(head.momentum) + 3}>
                {shortSector(sector)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="tx-rrg-axes">
        <span>→ RS-Ratio</span>
        <span>↑ RS-Momentum</span>
        <span title={RRG_NOTE}>vs NIFTY 500 · approximation ⓘ</span>
      </figcaption>
    </figure>
  );
}
