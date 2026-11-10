// Candle aggregation (pure).

export interface DatedCandle {
  /** ISO date string. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Daily candles → weekly (Monday-start) or monthly candles, oldest first. */
export function aggregateDaily<T extends DatedCandle>(series: T[], unit: "weeks" | "months"): DatedCandle[] {
  const ordered = [...series].sort((left, right) => Date.parse(left.date) - Date.parse(right.date));
  const buckets = new Map<string, T[]>();
  for (const point of ordered) {
    const date = new Date(point.date);
    const daysSinceMonday = (date.getUTCDay() + 6) % 7;
    const bucket =
      unit === "months"
        ? `${date.getUTCFullYear()}-${date.getUTCMonth()}`
        : String(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday));
    const existing = buckets.get(bucket) ?? [];
    existing.push(point);
    buckets.set(bucket, existing);
  }
  return [...buckets.values()].map((points) => ({
    date: points[0].date,
    open: points[0].open,
    high: Math.max(...points.map((point) => point.high)),
    low: Math.min(...points.map((point) => point.low)),
    close: points[points.length - 1].close,
    volume: points.reduce((sum, point) => sum + point.volume, 0),
  }));
}

const MINUTE_MS = 60_000;
const IST_OFFSET_MS = 5.5 * 60 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SESSION_OPEN_MIN = 9 * 60 + 15;

/**
 * Intraday candles → `minutes`-long candles aligned to the 09:15 IST session
 * open (e.g. 15-minute → 30-minute at 09:15, 09:45 …; 1-hour → 2-hour at 09:15,
 * 11:15, 13:15, 15:15), oldest first. Each bucket is stamped with its start.
 */
export function resampleIntraday<T extends DatedCandle>(series: T[], minutes: number): DatedCandle[] {
  const size = minutes * MINUTE_MS;
  const buckets = new Map<number, DatedCandle>();
  const ordered = [...series].sort((left, right) => Date.parse(left.date) - Date.parse(right.date));
  for (const point of ordered) {
    const t = Date.parse(point.date);
    const sinceIstMidnight = (((t + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
    const open = t - sinceIstMidnight + SESSION_OPEN_MIN * MINUTE_MS;
    const start = open + Math.floor((t - open) / size) * size;
    const bucket = buckets.get(start);
    if (!bucket) {
      buckets.set(start, { date: new Date(start).toISOString(), open: point.open, high: point.high, low: point.low, close: point.close, volume: point.volume });
      continue;
    }
    bucket.high = Math.max(bucket.high, point.high);
    bucket.low = Math.min(bucket.low, point.low);
    bucket.close = point.close;
    bucket.volume += point.volume;
  }
  return [...buckets.values()];
}
