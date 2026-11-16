export type ChartInterval = "1m" | "3m" | "5m" | "10m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d" | "1w" | "1mo";
export type ChartIntervalUnit = "minutes" | "hours" | "days" | "weeks" | "months";
export type ChartRange = "1d" | "5d" | "1mo" | "3mo" | "1y" | "5y" | "10y" | "15y";
export type ChartSource = "broker" | "sample";

interface IntervalConfig {
  unit: ChartIntervalUnit;
  interval: number;
  maxRange: ChartRange;
  defaultRange: ChartRange;
  movingAveragePeriod: number;
}

export const CHART_INTERVAL_CONFIG: Record<ChartInterval, IntervalConfig> = {
  // The Market Data Hub serves 5 years of daily, 1 year of intraday (5m and up)
  // and 30 days of 1-minute history (3m is built from 1m).
  "1m": { unit: "minutes", interval: 1, maxRange: "1mo", defaultRange: "1d", movingAveragePeriod: 20 },
  "3m": { unit: "minutes", interval: 3, maxRange: "1mo", defaultRange: "5d", movingAveragePeriod: 20 },
  "5m": { unit: "minutes", interval: 5, maxRange: "1y", defaultRange: "5d", movingAveragePeriod: 20 },
  "10m": { unit: "minutes", interval: 10, maxRange: "1y", defaultRange: "5d", movingAveragePeriod: 20 },
  "15m": { unit: "minutes", interval: 15, maxRange: "1y", defaultRange: "5d", movingAveragePeriod: 20 },
  "30m": { unit: "minutes", interval: 30, maxRange: "1y", defaultRange: "1mo", movingAveragePeriod: 20 },
  "1h": { unit: "hours", interval: 1, maxRange: "1y", defaultRange: "3mo", movingAveragePeriod: 20 },
  "2h": { unit: "hours", interval: 2, maxRange: "1y", defaultRange: "1y", movingAveragePeriod: 20 },
  "4h": { unit: "hours", interval: 4, maxRange: "1y", defaultRange: "1y", movingAveragePeriod: 20 },
  "1d": { unit: "days", interval: 1, maxRange: "15y", defaultRange: "1y", movingAveragePeriod: 50 },
  "1w": { unit: "weeks", interval: 1, maxRange: "15y", defaultRange: "5y", movingAveragePeriod: 20 },
  "1mo": { unit: "months", interval: 1, maxRange: "15y", defaultRange: "5y", movingAveragePeriod: 12 },
};

export const CHART_RANGE_DAYS: Record<ChartRange, number> = {
  "1d": 1,
  "5d": 5,
  "1mo": 31,
  "3mo": 92,
  "1y": 366,
  "5y": 366 * 5,
  "10y": 366 * 10,
  "15y": 366 * 15,
};

const RANGE_ORDER: ChartRange[] = ["1d", "5d", "1mo", "3mo", "1y", "5y", "10y", "15y"];

export function getAllowedRanges(interval: ChartInterval) {
  const maxRange = CHART_INTERVAL_CONFIG[interval].maxRange;
  return RANGE_ORDER.filter((range) => RANGE_ORDER.indexOf(range) <= RANGE_ORDER.indexOf(maxRange));
}

export function clampRangeForInterval(interval: ChartInterval, range: ChartRange) {
  const allowedRanges = getAllowedRanges(interval);
  if (allowedRanges.includes(range)) {
    return range;
  }
  return allowedRanges[allowedRanges.length - 1];
}

export function getDefaultRangeForInterval(interval: ChartInterval) {
  return CHART_INTERVAL_CONFIG[interval].defaultRange;
}

export function formatDateForApi(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export const CHART_RANGES: ChartRange[] = ["1d", "5d", "1mo", "3mo", "1y", "5y", "10y", "15y"];

export function isChartInterval(value: string): value is ChartInterval {
  return value in CHART_INTERVAL_CONFIG;
}

export function isChartRange(value: string): value is ChartRange {
  return (CHART_RANGES as string[]).includes(value);
}

// ------------------------------------------------------------------ per-interval metadata

export interface IntervalMeta {
  value: ChartInterval;
  label: string; // toolbar label
  title: string; // long name
  ms: number; // nominal bar duration (drawing extrapolation, live bucketing)
  intraday: boolean;
  /** History window requested on load: the hub serves 5y daily, 1y intraday, 30 days of 1m. */
  range: ChartRange;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const INTERVALS: IntervalMeta[] = [
  { value: "1m", label: "1m", title: "1 minute", ms: MINUTE, intraday: true, range: "1mo" },
  { value: "3m", label: "3m", title: "3 minutes", ms: 3 * MINUTE, intraday: true, range: "1mo" },
  { value: "5m", label: "5m", title: "5 minutes", ms: 5 * MINUTE, intraday: true, range: "3mo" },
  { value: "10m", label: "10m", title: "10 minutes", ms: 10 * MINUTE, intraday: true, range: "3mo" },
  { value: "15m", label: "15m", title: "15 minutes", ms: 15 * MINUTE, intraday: true, range: "1y" },
  { value: "30m", label: "30m", title: "30 minutes", ms: 30 * MINUTE, intraday: true, range: "1y" },
  { value: "1h", label: "1h", title: "1 hour", ms: 60 * MINUTE, intraday: true, range: "1y" },
  { value: "2h", label: "2h", title: "2 hours", ms: 120 * MINUTE, intraday: true, range: "1y" },
  { value: "4h", label: "4h", title: "4 hours", ms: 240 * MINUTE, intraday: true, range: "1y" },
  { value: "1d", label: "D", title: "1 day", ms: DAY, intraday: false, range: "5y" },
  { value: "1w", label: "W", title: "1 week", ms: 7 * DAY, intraday: false, range: "5y" },
  { value: "1mo", label: "M", title: "1 month", ms: 30 * DAY, intraday: false, range: "5y" },
];

export const FAVORITE_INTERVALS: ChartInterval[] = ["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1mo"];

export const INTERVAL_META = Object.fromEntries(INTERVALS.map((meta) => [meta.value, meta])) as Record<ChartInterval, IntervalMeta>;
