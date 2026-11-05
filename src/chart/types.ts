// Chart-renderer types: chart styles, drawings, tools, legend state. Market data
// types (Bar, IndicatorConfig) live in src/core/types.ts.

import type { Bar } from "@/core/types";

export type ChartType = "candles" | "hollow" | "bars" | "line" | "area" | "heikin";

export const CHART_TYPES: Array<{ value: ChartType; label: string }> = [
  { value: "candles", label: "Candles" },
  { value: "hollow", label: "Hollow candles" },
  { value: "heikin", label: "Heikin Ashi" },
  { value: "bars", label: "Bars (OHLC)" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
];

export type ScaleMode = "linear" | "log";

/** A drawing anchor lives in (time, price) space so it survives timeframe switches. */
export interface Anchor {
  t: number;
  p: number;
}

export type DrawingType =
  | "trendline"
  | "ray"
  | "extended"
  | "arrow"
  | "hline"
  | "hray"
  | "vline"
  | "channel"
  | "rect"
  | "brush"
  | "text"
  | "fib"
  | "long"
  | "short"
  | "pricerange"
  | "daterange"
  | "measure";

export type LineStyle = "solid" | "dashed" | "dotted";
export type LineExtend = "none" | "left" | "right" | "both";

export interface Drawing {
  id: string;
  type: DrawingType;
  points: Anchor[];
  color: string;
  lineWidth?: number; // px, default 2
  lineStyle?: LineStyle; // default solid
  extend?: LineExtend; // trend lines / arrows / channels
  locked?: boolean; // selectable but not movable
  hidden?: boolean;
  text?: string; // text drawings
  fontSize?: number; // text drawings, px
}

export type Tool = "cursor" | DrawingType;

export interface PaneLayout {
  id: string; // "main" or an indicator id
  top: number;
  height: number;
}

/** What the engine reports to the UI for the legend after every crosshair move / data change. */
export interface LegendState {
  bar: Bar | null;
  prevClose: number | null;
  panes: PaneLayout[];
  plotWidth: number;
  values: Record<string, Array<{ label: string; color: string; value: number | null }>>;
  scrolledAway: boolean;
}

/** A screener setup drawn over the price pane: not a drawing, can't be edited, never saved. */
export interface TradePlanOverlay {
  entry: number;
  stop: number;
  target: number | null;
  /** Signal bar time; the zone starts here and runs to the right edge. */
  time: number;
  label: string;
  /** Entry waits for a break above this price (buy-stop) rather than filling at the close. */
  buyStop?: boolean;
}
