import { QUADRANTS, RRG_DEFAULTS, relativeStrength, rrgSeries, quadrantOf, type Quadrant } from "@/core/sector/rrg";
import type { DailyBar } from "@/core/types";
import type { SignalValues } from "./engine";
import type { LabSignal, ParamSpec, SignalContext } from "./signals";

// Sector rotation in the Signal Lab (issue #30): per-stock signals read from
// the stock's SECTOR — every stock of a sector gets its sector's value. Pure.
//
//   sector-momentum  the sector's relative strength against NIFTY 500 over the
//                    last N sessions: ln(RS_t / RS_{t−N}), RS = sector / NIFTY 500
//                    (industry momentum, Moskowitz & Grinblatt 1999)
//   sector-reversal  minus the sector's own return over the last N sessions
//                    (short-term industry reversal: the sign found for South Asia)
//   sector-rrg       1 when the sector is in the chosen RRG quadrant
//                    (src/core/sector/rrg.ts), else 0 — rotation-in (Improving),
//                    Leading, or either (RS-Momentum ≥ 100)
//
// Sector series come from the service (src/server/services/labSectors.ts): the
// NSE sector index where its history reaches (2012 on), the hub's synthetic
// equal-weight basket of today's members before it and for industries no index
// covers. Baskets are survivorship-biased: `synthetic = 0` gives no value on a
// session whose look-back touches a basket (or NIFTY 500's basket stand-in),
// so only NSE index data is used. Industries are today's classification (no
// history of it is stored): a stock with none (a former F&O member not on
// today's lists) has no value.

export interface SectorSeriesInput {
  bars: readonly DailyBar[];
  /** Last session taken from a synthetic basket (null: none). */
  syntheticUntil: number | null;
  label: string;
}

/** What the sector signals read (built by the service when a signal has `usesSectors`). */
export interface SectorContext {
  /** The stock's sector (its industry), null when unclassified. */
  sectorOf(symbol: string): string | null;
  /** Each sector's long series. */
  series: ReadonlyMap<string, SectorSeriesInput>;
  /** The relative-strength benchmark: NIFTY 500, its synthetic basket before 2012. */
  benchmark: SectorSeriesInput;
}

const sessions = (key: string, label: string, value: number, min: number, max: number): ParamSpec => ({ key, label, default: value, min, max, integer: true });
const SYNTHETIC: ParamSpec = { key: "synthetic", label: "Use synthetic baskets (1 yes, 0 NSE indices only)", default: 1, min: 0, max: 1, integer: true };

/** quadrant param: 1–4 one quadrant, 5 Improving or Leading (RS-Momentum ≥ 100). */
export const QUADRANT_CODES: Record<number, string> = { 1: "Leading", 2: "Weakening", 3: "Lagging", 4: "Improving", 5: "Improving or Leading" };

/** Per sector: its value on each of its sessions (day key → value). */
type SectorValues = (series: SectorSeriesInput, bench: SectorSeriesInput) => Map<number, number>;

/** A stock's value is its sector's on that session; each sector is computed once, on first use. */
export function bySector(ctx: SignalContext, compute: SectorValues): SignalValues {
  const sectors = ctx.sectors;
  if (!sectors) return () => null;
  const cache = new Map<string, Map<number, number> | null>();
  return (day, symbol) => {
    const sector = sectors.sectorOf(symbol);
    if (!sector) return null;
    let values = cache.get(sector);
    if (values === undefined) {
      const series = sectors.series.get(sector);
      values = series ? compute(series, sectors.benchmark) : null;
      cache.set(sector, values);
    }
    const value = values?.get(day);
    return value === undefined || !Number.isFinite(value) ? null : value;
  };
}

/** True when a look-back starting on `fromDay` uses only NSE index data (sector and benchmark). */
const indexOnly = (fromDay: number, ...series: SectorSeriesInput[]) => series.every((entry) => entry.syntheticUntil === null || fromDay > entry.syntheticUntil);

/** ln(RS_t / RS_{t−lookback}) on each session (RS = sector / benchmark, on common sessions). */
export function sectorMomentum(series: SectorSeriesInput, bench: SectorSeriesInput, lookback: number, synthetic: boolean): Map<number, number> {
  const { t, rs } = relativeStrength(series.bars, bench.bars);
  const out = new Map<number, number>();
  for (let i = lookback; i < t.length; i += 1) {
    if (!synthetic && !indexOnly(t[i - lookback], series, bench)) continue;
    out.set(t[i], Math.log(rs[i] / rs[i - lookback]));
  }
  return out;
}

/** −(S_t / S_{t−lookback} − 1): minus the sector's own return. */
export function sectorReversal(series: SectorSeriesInput, lookback: number, synthetic: boolean): Map<number, number> {
  const bars = series.bars;
  const out = new Map<number, number>();
  for (let i = lookback; i < bars.length; i += 1) {
    if (!synthetic && !indexOnly(bars[i - lookback].t, series)) continue;
    if (bars[i].c > 0 && bars[i - lookback].c > 0) out.set(bars[i].t, -(bars[i].c / bars[i - lookback].c - 1));
  }
  return out;
}

const inQuadrant = (quadrant: Quadrant, momentum: number, code: number) => (code === 5 ? momentum >= 100 : QUADRANTS[code - 1] === quadrant);

/** 1 on the sessions the sector is in the quadrant(s) `code` picks, 0 on the others with an RRG reading. */
export function sectorQuadrant(series: SectorSeriesInput, bench: SectorSeriesInput, code: number, params: typeof RRG_DEFAULTS, synthetic: boolean): Map<number, number> {
  const { t, rs } = relativeStrength(series.bars, bench.bars);
  const { ratio, momentum } = rrgSeries(rs, params);
  // Everything a reading leans on: the EMA's seed, both windows and the lag.
  const span = params.smooth + 2 * params.window + params.lag;
  const out = new Map<number, number>();
  for (let i = 0; i < t.length; i += 1) {
    if (!Number.isFinite(ratio[i]) || !Number.isFinite(momentum[i])) continue;
    if (!synthetic && !indexOnly(t[Math.max(0, i - span)], series, bench)) continue;
    out.set(t[i], inQuadrant(quadrantOf(ratio[i], momentum[i]), momentum[i], code) ? 1 : 0);
  }
  return out;
}

export const SECTOR_SIGNALS: LabSignal[] = [
  {
    id: "sector-momentum",
    name: "Sector momentum (RS vs NIFTY 500)",
    group: "sector",
    kind: "numeric",
    usesSectors: true,
    summary:
      "The stock's sector's relative strength against NIFTY 500 over the last N sessions, ln(RS now / RS N sessions ago): every stock of a sector shares its value. High = stocks in the strongest sectors; a positive spread is industry momentum (Moskowitz & Grinblatt 1999). Sector = NSE index from 2012, synthetic equal-weight basket (survivorship-biased) before (issue #30).",
    params: [sessions("lookback", "Look back (sessions)", 126, 5, 252), SYNTHETIC],
    build: (ctx, { lookback, synthetic }) => bySector(ctx, (series, bench) => sectorMomentum(series, bench, lookback, synthetic === 1)),
  },
  {
    id: "sector-reversal",
    name: "Sector reversal (minus 1-month sector return)",
    group: "sector",
    kind: "numeric",
    usesSectors: true,
    summary:
      "Minus the stock's sector's return over the last N sessions: high = stocks in the month's worst sectors. A positive spread is short-term industry reversal (laggard catch-up), the sign found for South Asian markets; a negative one is industry momentum (issue #30).",
    params: [sessions("lookback", "Look back (sessions)", 21, 2, 63), SYNTHETIC],
    build: (ctx, { lookback, synthetic }) => bySector(ctx, (series) => sectorReversal(series, lookback, synthetic === 1)),
  },
  {
    id: "sector-rrg",
    name: "Sector RRG quadrant",
    group: "sector",
    kind: "binary",
    usesSectors: true,
    summary:
      "1 when the stock's sector is in the chosen quadrant of a Relative Rotation Graph against NIFTY 500 (1 Leading, 2 Weakening, 3 Lagging, 4 Improving, 5 Improving or Leading), else 0: matched stocks minus the rest. A documented approximation of RRG (rolling z-scores of smoothed relative strength and of its change), not RRG Research's proprietary formula (issue #30).",
    params: [
      { key: "quadrant", label: "Quadrant (1 Leading, 2 Weakening, 3 Lagging, 4 Improving, 5 Improving or Leading)", default: 5, min: 1, max: 5, integer: true },
      sessions("smooth", "RS smoothing (EMA sessions)", RRG_DEFAULTS.smooth, 1, 63),
      sessions("window", "Normalisation window (sessions)", RRG_DEFAULTS.window, 10, 252),
      sessions("lag", "Momentum lag (sessions)", RRG_DEFAULTS.lag, 1, 63),
      SYNTHETIC,
    ],
    build: (ctx, { quadrant, smooth, window, lag, synthetic }) => bySector(ctx, (series, bench) => sectorQuadrant(series, bench, quadrant, { smooth, window, lag }, synthetic === 1)),
  },
];
