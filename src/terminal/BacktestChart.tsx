"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EquityPoint } from "@/core/backtest/metrics";
import { formatDate, formatRupees, formatPct } from "./BacktestFormat";

// Equity vs NIFTY (top) with the drawdown area beneath, drawn as SVG at the
// element's real pixel width so lines stay crisp. A crosshair + tooltip follows
// the pointer (mouse or touch).

const HEIGHT = 300;
const PAD = { top: 12, right: 64, bottom: 22, left: 8 };
const GAP = 14;
const DD_SHARE = 0.27;

function niceTicks(min: number, max: number, count: number): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(v);
  return out;
}

export function EquityChart({ curve, capital, splitDate }: { curve: EquityPoint[]; capital: number; splitDate: number }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const geo = useMemo(() => {
    if (!width || curve.length < 2) return null;
    const plotW = Math.max(10, width - PAD.left - PAD.right);
    const plotH = HEIGHT - PAD.top - PAD.bottom - GAP;
    const eqH = Math.round(plotH * (1 - DD_SHARE));
    const ddTop = PAD.top + eqH + GAP;
    const ddH = plotH - eqH;
    const values = curve.flatMap((p) => (p.bench !== null ? [p.equity, p.bench] : [p.equity]));
    let lo = Math.min(capital, ...values);
    let hi = Math.max(capital, ...values);
    const pad = (hi - lo) * 0.08 || capital * 0.01;
    lo -= pad;
    hi += pad;
    const minDd = Math.min(-0.01, ...curve.map((p) => p.drawdown));
    const n = curve.length;
    const x = (i: number) => PAD.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * eqH;
    const yd = (d: number) => ddTop + (d / minDd) * ddH;
    const line = (get: (p: EquityPoint) => number | null) => {
      let d = "";
      curve.forEach((p, i) => {
        const v = get(p);
        if (v === null) return;
        d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      });
      return d;
    };
    const ddPath = `M${x(0).toFixed(1)},${ddTop}` + curve.map((p, i) => `L${x(i).toFixed(1)},${yd(p.drawdown).toFixed(1)}`).join("") + `L${x(n - 1).toFixed(1)},${ddTop}Z`;
    const yTicks = niceTicks(lo, hi, 4);
    const ddTicks = [0, minDd / 2, minDd].map((d) => Math.round(d * 1000) / 1000);
    // Month starts as x labels, thinned to fit.
    const months: number[] = [];
    curve.forEach((p, i) => {
      if (i === 0) return;
      if (new Date(p.t).getUTCMonth() !== new Date(curve[i - 1].t).getUTCMonth()) months.push(i);
    });
    const every = Math.max(1, Math.ceil((months.length * 56) / plotW));
    const xTicks = months.filter((_, k) => k % every === 0);
    const splitIndex = curve.findIndex((p) => p.t >= splitDate);
    return { plotW, eqH, ddTop, ddH, x, y, yd, lo, hi, minDd, equityPath: line((p) => p.equity), benchPath: line((p) => p.bench), ddPath, yTicks, ddTicks, xTicks, splitIndex, n };
  }, [width, curve, capital, splitDate]);

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!geo) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const i = Math.round(((px - PAD.left) / geo.plotW) * (geo.n - 1));
    setHover(Math.min(geo.n - 1, Math.max(0, i)));
  };

  const point = hover !== null ? curve[hover] : null;
  const hasBench = curve.some((p) => p.bench !== null);

  return (
    <div className="tx-bt-chart" ref={wrapRef}>
      <div className="tx-bt-legend">
        <span>
          <i className="tx-bt-key is-equity" /> Strategy equity
        </span>
        {hasBench && (
          <span>
            <i className="tx-bt-key is-bench" /> NIFTY buy &amp; hold
          </span>
        )}
        <span>
          <i className="tx-bt-key is-dd" /> Drawdown
        </span>
      </div>
      {geo && (
        <svg width={width} height={HEIGHT} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Equity curve, NIFTY benchmark and drawdown">
          {geo.yTicks.map((v) => (
            <g key={v}>
              <line className="tx-bt-grid" x1={PAD.left} x2={PAD.left + geo.plotW} y1={geo.y(v)} y2={geo.y(v)} />
              <text className="tx-bt-axis" x={PAD.left + geo.plotW + 6} y={geo.y(v) + 3.5}>
                {formatRupees(v, true)}
              </text>
            </g>
          ))}
          {geo.ddTicks.map((d) => (
            <g key={d}>
              <line className="tx-bt-grid" x1={PAD.left} x2={PAD.left + geo.plotW} y1={geo.yd(d)} y2={geo.yd(d)} />
              <text className="tx-bt-axis" x={PAD.left + geo.plotW + 6} y={geo.yd(d) + 3.5}>
                {d === 0 ? "0%" : `${(d * 100).toFixed(1)}%`}
              </text>
            </g>
          ))}
          {geo.xTicks.map((i) => (
            <text key={i} className="tx-bt-axis" x={geo.x(i)} y={HEIGHT - 6} textAnchor="middle">
              {new Date(curve[i].t).toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" })}
            </text>
          ))}
          {geo.splitIndex > 0 && (
            <g>
              <rect className="tx-bt-oos" x={geo.x(geo.splitIndex)} y={PAD.top} width={PAD.left + geo.plotW - geo.x(geo.splitIndex)} height={geo.ddTop + geo.ddH - PAD.top} />
              <line className="tx-bt-split" x1={geo.x(geo.splitIndex)} x2={geo.x(geo.splitIndex)} y1={PAD.top} y2={geo.ddTop + geo.ddH} />
              <text className="tx-bt-axis" x={geo.x(geo.splitIndex) - 5} y={PAD.top + 10} textAnchor="end">
                In-sample
              </text>
              <text className="tx-bt-axis" x={geo.x(geo.splitIndex) + 5} y={PAD.top + 10}>
                Out-of-sample
              </text>
            </g>
          )}
          <line className="tx-bt-base" x1={PAD.left} x2={PAD.left + geo.plotW} y1={geo.y(capital)} y2={geo.y(capital)} />
          <path className="tx-bt-ddarea" d={geo.ddPath} />
          {hasBench && <path className="tx-bt-bench" d={geo.benchPath} />}
          <path className="tx-bt-equity" d={geo.equityPath} />
          {point && hover !== null && (
            <g>
              <line className="tx-bt-cross" x1={geo.x(hover)} x2={geo.x(hover)} y1={PAD.top} y2={geo.ddTop + geo.ddH} />
              {point.bench !== null && <circle className="tx-bt-dot is-bench" cx={geo.x(hover)} cy={geo.y(point.bench)} r={3.5} />}
              <circle className="tx-bt-dot" cx={geo.x(hover)} cy={geo.y(point.equity)} r={4} />
              <circle className="tx-bt-dot is-dd" cx={geo.x(hover)} cy={geo.yd(point.drawdown)} r={3} />
            </g>
          )}
        </svg>
      )}
      {point && geo && hover !== null && (
        <div className="tx-bt-tip" style={{ left: Math.min(width - 190, Math.max(0, geo.x(hover) + 12)), top: 34 }}>
          <strong>{formatDate(point.t)}</strong>
          <span>
            Equity <b>{formatRupees(point.equity)}</b> <em className={point.equity >= capital ? "is-up" : "is-down"}>{formatPct(point.equity / capital - 1)}</em>
          </span>
          {point.bench !== null && (
            <span>
              NIFTY <b>{formatRupees(point.bench)}</b> <em className={point.bench >= capital ? "is-up" : "is-down"}>{formatPct(point.bench / capital - 1)}</em>
            </span>
          )}
          <span>
            Drawdown <b className={point.drawdown < 0 ? "is-down" : ""}>{formatPct(point.drawdown)}</b>
          </span>
          <span>
            Open positions <b>{point.open}</b>
          </span>
        </div>
      )}
    </div>
  );
}
