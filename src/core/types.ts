// Market data types shared by the calculation engine (src/core), the backend
// and the chart renderer. Pure data — no behaviour.

/** One OHLCV candle. `time` is the bar's open time, epoch ms. */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** One session of stored daily history (compact keys; t = UTC midnight of the IST trading date). */
export interface DailyBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** NSE delivery % (end of day only). */
  dp?: number;
}

/** A configured indicator instance (type + parameters + colours) on a chart. */
export interface IndicatorConfig {
  id: string;
  type: string;
  params: Record<string, number>;
  colors: Record<string, string>;
  hidden?: boolean;
}
