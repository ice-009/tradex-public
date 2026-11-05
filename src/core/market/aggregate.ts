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
