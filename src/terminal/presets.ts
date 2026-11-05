import type { ChartInterval } from "@/core/market/intervals";
import type { ChartType, ScaleMode } from "@/chart/types";
import type { IndicatorConfig } from "@/core/types";
import { INDICATORS, createIndicatorConfig } from "@/core/indicators/indicators";
import type { LayoutId } from "./store";

// Built-in layout presets, one per trading style. Every parameter below is a
// published default or a value named by the cited source — not a tuned guess.
// Full write-up (who it's for, how to read each chart): research/presets.md.
//
// Cells without a `symbol` take the user's current active symbol, so a preset
// turns any stock into a multi-timeframe view. Index presets pin NIFTY/BANKNIFTY.

export interface PresetIndicator {
  type: string;
  params?: Record<string, number>;
  colors?: Record<string, string>;
}

export interface PresetCell {
  interval: ChartInterval;
  symbol?: string;
  chartType?: ChartType;
  scaleMode?: ScaleMode;
  showVolume?: boolean;
  indicators: PresetIndicator[];
}

export type PresetGroup = "Swing" | "BTST";

export interface LayoutPreset {
  id: string;
  name: string;
  group: PresetGroup;
  /** One line: who it's for, timeframes, why these indicators. */
  description: string;
  /** How to read it — shown on hover. */
  rationale: string;
  layout: LayoutId;
  cells: PresetCell[];
  sources: string[];
  /** Step-by-step "how to read this layout", chart by chart — shown after applying. */
  steps?: string[];
  /** In-app lesson to offer alongside the steps. */
  guide?: "smc";
}

// Two layouts for stock-futures trades held at least overnight: BTST (1–3 sessions) and swing
// (15–20 sessions). No intraday layout — positions are carried in NRML, not MIS.
// Rule for every chart: each indicator has ONE job, and no two indicators do the same job.
// Chart patterns + support/resistance are drawn automatically on every chart (the Patterns
// toggle), so none of these layouts adds separate level or channel indicators.
export const PRESET_GROUPS: PresetGroup[] = ["Swing", "BTST"];

const C = {
  blue: "#2962ff",
  amber: "#f5b544",
  purple: "#c77dff",
};

const ema = (length: number, color: string): PresetIndicator => ({ type: "ema", params: { length }, colors: { ma: color } });
const sma = (length: number, color: string): PresetIndicator => ({ type: "sma", params: { length }, colors: { ma: color } });
const VWAP: PresetIndicator = { type: "vwap" };
const PDHL: PresetIndicator = { type: "pdhl" };
const RSI14: PresetIndicator = { type: "rsi", params: { length: 14 } };

const S = {
  varsityMA: "https://zerodha.com/varsity/chapter/moving-averages/",
  varsityRSI: "https://zerodha.com/varsity/chapter/indicators-part-1/",
  varsityFinale: "https://zerodha.com/varsity/chapter/finale-helping-get-started/",
  weinstein: "https://www.luxalgo.com/library/concept/weinstein-stage-analysis.md",
  minervini: "https://www.chartmill.com/documentation/stock-screener/technical-analysis-trading-strategies/496-Mark-Minervini-Trend-Template-A-Step-by-Step-Guide-for-Beginners",
  csVWAP: "https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/volume-weighted-average-price-vwap",
  nseClose: "https://upstox.com/learning-center/demat-account/difference-between-ltp-and-closing-price/article-1565/",
};

export const PRESETS: LayoutPreset[] = [
  {
    id: "swing",
    name: "Swing · 15–20 days",
    group: "Swing",
    description: "Daily chart to time the trade (20 EMA, 50 SMA, RSI 14, volume) beside a weekly chart that decides whether to trade at all (30-week MA).",
    rationale:
      "Weekly: Weinstein's stage analysis — buy only in stage 2, price above a RISING 30-week average (≈150-day). Daily: the 50 SMA is the Minervini/O'Neil trend line (stay long above it); the 20 EMA is where 2–4 week pullbacks find support and where the trail stop sits; RSI 14 holding 40–80 confirms an up-trend regime (Varsity). Volume confirms breakouts.",
    layout: "2v",
    cells: [
      { interval: "1d", indicators: [ema(20, C.blue), sma(50, C.amber), RSI14] },
      { interval: "1w", indicators: [sma(30, C.purple), sma(10, C.blue)] },
    ],
    sources: [S.weinstein, S.minervini, S.varsityMA, S.varsityRSI, S.varsityFinale],
    steps: [
      "Weekly (right): is the price above the purple 30-week MA, and is that line rising? If not, skip the stock — Weinstein's stage 2 is the only buy stage.",
      "Daily: close above the amber 50 SMA, and the 50 SMA pointing up? That's the trend you're trading.",
      "Entry: a pullback to the blue 20 EMA that turns up, or a pattern breakout (drawn automatically) on volume above its average.",
      "RSI 14 should hold 40–80; a break below 40 in an up-trend is the warning.",
      "Stop under the pattern / pullback low; trail it under the 20 EMA (or the chandelier stop on the setup card) as the trade works.",
    ],
  },
  {
    id: "btst",
    name: "BTST · overnight",
    group: "BTST",
    description: "For a stock-futures position carried overnight: big daily chart for the setup (20 EMA + volume), the stock's 15m for closing strength (VWAP, previous day's high/low), and NIFTY 15m for the market.",
    rationale:
      "A BTST is a bet that today's strength carries into tomorrow's open. The daily chart shows the setup and whether volume backs it; the 15m shows WHO is in control into the close (above VWAP = buyers) and whether the stock took out yesterday's high; NIFTY's VWAP stops you buying a strong stock into a weak market overnight. NSE's close is the VWAP of the last 30 minutes, so decide 3:00–3:25.",
    layout: "3",
    cells: [
      { interval: "1d", indicators: [ema(20, C.blue)] },
      { interval: "15m", indicators: [VWAP, PDHL] },
      { interval: "15m", symbol: "NIFTY", indicators: [VWAP] },
    ],
    sources: [S.varsityMA, S.csVWAP, S.nseClose, S.varsityFinale],
    steps: [
      "Daily (left): up-day closing near its high, above the blue 20 EMA, on volume clearly above its average (the volume bars).",
      "Stock 15m: price above VWAP for most of the afternoon, and above yesterday's high (PDH) into 3 PM.",
      "NIFTY 15m: above its own VWAP. If the market is weak into the close, skip — gaps punish overnight holds.",
      "Decide between 3:00 and 3:25 PM (NSE's close is the 3:00–3:30 VWAP). Buy the future as NRML; stop under the day's low; exit next session (or hold while the plan works).",
    ],
  },
];

export const PRESET_MAP: Record<string, LayoutPreset> = Object.fromEntries(PRESETS.map((preset) => [preset.id, preset]));

/**
 * Build an indicator config from a preset spec: start from the indicator's own
 * defaults and overlay only params/colors it actually defines. Unknown types
 * (e.g. an indicator not shipped in this build) are skipped, not fatal.
 */
export function buildIndicator(spec: PresetIndicator): IndicatorConfig | null {
  if (!INDICATORS[spec.type]) return null;
  const base = createIndicatorConfig(spec.type);
  const params = { ...base.params };
  for (const [key, value] of Object.entries(spec.params ?? {})) {
    if (key in params && Number.isFinite(value)) params[key] = value;
  }
  const colors = { ...base.colors };
  for (const [key, value] of Object.entries(spec.colors ?? {})) {
    if (key in colors) colors[key] = value;
  }
  return { ...base, params, colors };
}

export function buildIndicators(specs: PresetIndicator[]): IndicatorConfig[] {
  return specs.map(buildIndicator).filter((config): config is IndicatorConfig => config !== null);
}

export function sourceHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
