"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { DecayPoint, HorizonReport, LabReport } from "@/core/lab/engine";
import { isoDay, num, pct } from "@/core/lab/format";

// The report card's charts (#23), as SVG drawn at the element's real pixel
// width so text and lines stay crisp: the long–short spread's equity curve, its
// decay by horizon with a ±2 Newey–West se band, and the bucket returns.
// Colours come from the theme tokens (labCard.css).

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Round tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

const tickPct = (value: number, span: number) => pct(value, span < 0.002 ? 3 : span < 0.05 ? 2 : span < 1 ? 1 : 0);

// ------------------------------------------------------------------ equity curve

const EQ_HEIGHT = 240;
const EQ_PAD = { top: 12, right: 60, bottom: 24, left: 8 };

/**
 * Cumulative net spread at one horizon: the sum of its non-overlapping
 * h-session spreads (every h-th formation day), as a stack of h-session holds
 * would have earned it, with the 60/40 split marked.
 */
export function SpreadEquityChart({ horizon, splitDate }: { horizon: HorizonReport; splitDate: number | null }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const { days, net } = horizon.series ?? { days: [], net: [] };
  const geo = useMemo(() => {
    if (!width || days.length < 2) return null;
    const cumulative: number[] = [];
    let sum = 0;
    for (const value of net) cumulative.push((sum += value));
    const plotW = Math.max(10, width - EQ_PAD.left - EQ_PAD.right);
    const plotH = EQ_HEIGHT - EQ_PAD.top - EQ_PAD.bottom;
    let lo = Math.min(0, ...cumulative);
    let hi = Math.max(0, ...cumulative);
    const padding = (hi - lo) * 0.08 || 0.01;
    lo -= padding;
    hi += padding;
    const t0 = days[0];
    const t1 = days[days.length - 1];
    const x = (t: number) => EQ_PAD.left + ((t - t0) / (t1 - t0 || 1)) * plotW;
    const y = (v: number) => EQ_PAD.top + (1 - (v - lo) / (hi - lo)) * plotH;
    const path = cumulative.map((v, i) => `${i ? "L" : "M"}${x(days[i]).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const area = `${path}L${x(t1).toFixed(1)},${y(0).toFixed(1)}L${x(t0).toFixed(1)},${y(0).toFixed(1)}Z`;
    const ticks = niceTicks(lo, hi, 5);
    const years: number[] = [];
    for (let year = new Date(t0).getUTCFullYear() + 1; year <= new Date(t1).getUTCFullYear(); year += 1) years.push(Date.UTC(year, 0, 1));
    const yearStep = Math.max(1, Math.ceil(years.length / Math.max(1, Math.floor(plotW / 70))));
    return { cumulative, x, y, path, area, ticks, years: years.filter((_, i) => i % yearStep === 0), span: hi - lo, t0, t1, plotW };
  }, [width, days, net]);

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!geo) return;
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left;
    let best = 0;
    for (let i = 1; i < days.length; i += 1) if (Math.abs(geo.x(days[i]) - px) < Math.abs(geo.x(days[best]) - px)) best = i;
    setHover(best);
  };

  const final = geo?.cumulative.at(-1) ?? null;
  return (
    <div className="tx-card-chart" ref={ref}>
      {days.length < 2 ? (
        <p className="tx-dim tx-card-empty">Too few non-overlapping {horizon.horizon}-session spreads to draw.</p>
      ) : (
        geo && (
          <svg width={width} height={EQ_HEIGHT} role="img" aria-label={`Cumulative net spread at ${horizon.horizon} sessions: ${pct(final, 1)}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            {geo.ticks.map((tick) => (
              <g key={tick}>
                <line x1={EQ_PAD.left} x2={EQ_PAD.left + geo.plotW} y1={geo.y(tick)} y2={geo.y(tick)} className={tick === 0 ? "tx-card-zero" : "tx-card-grid"} />
                <text x={EQ_PAD.left + geo.plotW + 6} y={geo.y(tick) + 4} className="tx-card-tick">
                  {tickPct(tick, geo.span)}
                </text>
              </g>
            ))}
            {geo.years.map((t) => (
              <text key={t} x={geo.x(t)} y={EQ_HEIGHT - 6} className="tx-card-tick" textAnchor="middle">
                {new Date(t).getUTCFullYear()}
              </text>
            ))}
            {splitDate !== null && splitDate > geo.t0 && splitDate < geo.t1 && (
              <g>
                <line x1={geo.x(splitDate)} x2={geo.x(splitDate)} y1={EQ_PAD.top} y2={EQ_HEIGHT - EQ_PAD.bottom} className="tx-card-split" />
                <text x={geo.x(splitDate) + 4} y={EQ_PAD.top + 10} className="tx-card-tick">
                  60 / 40
                </text>
              </g>
            )}
            <path d={geo.area} className={(final ?? 0) >= 0 ? "tx-card-area is-pos" : "tx-card-area is-neg"} />
            <path d={geo.path} className="tx-card-line" />
            {hover !== null && (
              <g pointerEvents="none">
                <line x1={geo.x(days[hover])} x2={geo.x(days[hover])} y1={EQ_PAD.top} y2={EQ_HEIGHT - EQ_PAD.bottom} className="tx-card-cross" />
                <circle cx={geo.x(days[hover])} cy={geo.y(geo.cumulative[hover])} r={3.5} className="tx-card-dot" />
                <Tip x={geo.x(days[hover])} y={EQ_PAD.top} width={width} lines={[isoDay(days[hover]), `cumulative ${pct(geo.cumulative[hover], 2)}`, `this hold ${pct(net[hover], 3)}`]} />
              </g>
            )}
          </svg>
        )
      )}
    </div>
  );
}

function Tip({ x, y, width, lines }: { x: number; y: number; width: number; lines: string[] }) {
  const w = 148;
  const h = 14 * lines.length + 8;
  const left = x + 10 + w > width ? x - 10 - w : x + 10;
  return (
    <g transform={`translate(${left},${y})`}>
      <rect width={w} height={h} rx={4} className="tx-card-tip" />
      {lines.map((line, i) => (
        <text key={line} x={8} y={16 + i * 14} className={i ? "tx-card-tiptext" : "tx-card-tiptext is-head"}>
          {line}
        </text>
      ))}
    </g>
  );
}

// ------------------------------------------------------------------ decay

const DECAY_HEIGHT = 220;
const DECAY_PAD = { top: 12, right: 60, bottom: 24, left: 8 };

/** Net spread by horizon 1 … N with a ±2 Newey–West standard-error band; the report's horizons are dotted, the selected one ringed. */
export function DecayBandChart({ decay, horizons, selected }: { decay: DecayPoint[]; horizons: number[]; selected: number | null }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const points = decay.filter((p) => p.net !== null);
  const geo = useMemo(() => {
    if (!width || !points.length) return null;
    const band = (p: DecayPoint) => [(p.net ?? 0) - 2 * (p.netSe ?? 0), (p.net ?? 0) + 2 * (p.netSe ?? 0)];
    const values = points.flatMap((p) => [...band(p), 0]);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    const padding = (hi - lo) * 0.08 || 0.001;
    lo -= padding;
    hi += padding;
    const plotW = Math.max(10, width - DECAY_PAD.left - DECAY_PAD.right);
    const plotH = DECAY_HEIGHT - DECAY_PAD.top - DECAY_PAD.bottom;
    const n = points.length;
    const x = (i: number) => DECAY_PAD.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = (v: number) => DECAY_PAD.top + (1 - (v - lo) / (hi - lo)) * plotH;
    const withSe = points.map((p, i) => ({ p, i })).filter(({ p }) => p.netSe !== null && p.netSe !== undefined);
    const upper = withSe.map(({ p, i }) => `${x(i).toFixed(1)},${y(band(p)[1]).toFixed(1)}`);
    const lower = withSe.map(({ p, i }) => `${x(i).toFixed(1)},${y(band(p)[0]).toFixed(1)}`).reverse();
    const area = withSe.length > 1 ? `M${upper.join("L")}L${lower.join("L")}Z` : "";
    const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.net ?? 0).toFixed(1)}`).join("");
    return { x, y, area, line, ticks: niceTicks(lo, hi, 4), span: hi - lo, plotW, n };
  }, [width, points]);

  return (
    <div className="tx-card-chart" ref={ref}>
      {!points.length ? (
        <p className="tx-dim tx-card-empty">No decay measured.</p>
      ) : (
        geo && (
          <svg
            width={width}
            height={DECAY_HEIGHT}
            role="img"
            aria-label="Net spread by horizon with a ±2 standard error band"
            onPointerMove={(event) => {
              const px = event.clientX - event.currentTarget.getBoundingClientRect().left;
              const i = Math.round(((px - DECAY_PAD.left) / geo.plotW) * (geo.n - 1));
              setHover(Math.max(0, Math.min(geo.n - 1, i)));
            }}
            onPointerLeave={() => setHover(null)}
          >
            {geo.ticks.map((tick) => (
              <g key={tick}>
                <line x1={DECAY_PAD.left} x2={DECAY_PAD.left + geo.plotW} y1={geo.y(tick)} y2={geo.y(tick)} className={tick === 0 ? "tx-card-zero" : "tx-card-grid"} />
                <text x={DECAY_PAD.left + geo.plotW + 6} y={geo.y(tick) + 4} className="tx-card-tick">
                  {tickPct(tick, geo.span)}
                </text>
              </g>
            ))}
            {geo.area && <path d={geo.area} className="tx-card-band" />}
            <path d={geo.line} className="tx-card-line" />
            {points.map((p, i) => (
              <g key={p.horizon}>
                {(p.horizon === 1 || (p.horizon % 5 === 0 && points.length - 1 - i >= 2) || i === points.length - 1) && (
                  <text x={geo.x(i)} y={DECAY_HEIGHT - 6} className="tx-card-tick" textAnchor="middle">
                    {p.horizon}
                  </text>
                )}
                {horizons.includes(p.horizon) && <circle cx={geo.x(i)} cy={geo.y(p.net ?? 0)} r={p.horizon === selected ? 5 : 3} className={p.horizon === selected ? "tx-card-dot is-selected" : "tx-card-dot"} />}
              </g>
            ))}
            {hover !== null && points[hover] && (
              <g pointerEvents="none">
                <line x1={geo.x(hover)} x2={geo.x(hover)} y1={DECAY_PAD.top} y2={DECAY_HEIGHT - DECAY_PAD.bottom} className="tx-card-cross" />
                <Tip
                  x={geo.x(hover)}
                  y={DECAY_PAD.top}
                  width={width}
                  lines={[
                    `${points[hover].horizon} session${points[hover].horizon === 1 ? "" : "s"}`,
                    `net ${pct(points[hover].net, 3)}`,
                    `±2 se ${pct(2 * (points[hover].netSe ?? NaN), 3)}`,
                    `gross ${pct(points[hover].gross, 3)} (t ${num(points[hover].t)})`,
                  ]}
                />
              </g>
            )}
          </svg>
        )
      )}
    </div>
  );
}

// ------------------------------------------------------------------ bucket returns

const Q_HEIGHT = 200;
const Q_PAD = { top: 18, right: 8, bottom: 24, left: 8 };

/** Mean forward return of each occupied bucket at one horizon (gross; net in the tooltip): a working signal climbs from Q1 to the top. */
export function QuantileBars({ report, horizon }: { report: LabReport; horizon: HorizonReport }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const rows = horizon.quantiles.filter((row) => row.stocks > 0 && row.gross !== null);
  const geo = useMemo(() => {
    if (!width || !rows.length) return null;
    const values = rows.flatMap((row) => [row.gross ?? 0, 0]);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo || 0.001;
    const plotW = Math.max(10, width - Q_PAD.left - Q_PAD.right);
    const plotH = Q_HEIGHT - Q_PAD.top - Q_PAD.bottom;
    const slot = plotW / rows.length;
    const y = (v: number) => Q_PAD.top + ((hi - v) / span) * plotH;
    return { slot, y, barW: Math.min(56, slot * 0.6) };
  }, [width, rows]);
  const label = (bucket: number) => (report.signal.kind === "binary" ? (bucket === 1 ? "rest" : "matched") : `Q${bucket}`);
  return (
    <div className="tx-card-chart" ref={ref}>
      {!rows.length ? (
        <p className="tx-dim tx-card-empty">No bucket returns at {horizon.horizon} sessions.</p>
      ) : (
        geo && (
          <svg width={width} height={Q_HEIGHT} role="img" aria-label={`Bucket returns at ${horizon.horizon} sessions`}>
            <line x1={Q_PAD.left} x2={width - Q_PAD.right} y1={geo.y(0)} y2={geo.y(0)} className="tx-card-zero" />
            {rows.map((row, i) => {
              const cx = Q_PAD.left + geo.slot * (i + 0.5);
              const v = row.gross ?? 0;
              const top = Math.min(geo.y(0), geo.y(v));
              return (
                <g key={row.bucket}>
                  <rect x={cx - geo.barW / 2} width={geo.barW} y={top} height={Math.max(1, Math.abs(geo.y(v) - geo.y(0)))} className={v >= 0 ? "tx-card-bar is-pos" : "tx-card-bar is-neg"}>
                    <title>{`${label(row.bucket)}: ${pct(row.gross, 3)} gross (t ${num(row.t)}), ${pct(row.net, 3)} net of a long round trip · ${row.stocks.toFixed(1)} stocks a day`}</title>
                  </rect>
                  <text x={cx} y={v >= 0 ? top - 4 : geo.y(0) - 4} className="tx-card-tick is-value" textAnchor="middle">
                    {pct(row.gross, 2)}
                  </text>
                  <text x={cx} y={Q_HEIGHT - 6} className="tx-card-tick" textAnchor="middle">
                    {label(row.bucket)}
                  </text>
                </g>
              );
            })}
          </svg>
        )
      )}
    </div>
  );
}
