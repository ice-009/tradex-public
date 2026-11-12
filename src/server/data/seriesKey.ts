// Names of stored candle series in the market database (./candleDb.ts).
//
// A series is keyed by instrument and resolution in the broker's naming, e.g.
// "NSE:SBIN-EQ:D", "NSE:NIFTY50-INDEX:15" or "NSE:SBIN26NOVFUT:1". The key
// names the instrument, not the source, so the candles earlier versions stored
// stay usable. Pure: no I/O, so it can be imported anywhere without side effects.

import { CHART_INTERVAL_CONFIG, type ChartInterval } from "@/core/market/intervals";

/** App symbols for indices → the broker's instrument names. */
export const INDEX_INSTRUMENTS: Readonly<Record<string, string>> = {
  NIFTY: "NSE:NIFTY50-INDEX",
  BANKNIFTY: "NSE:NIFTYBANK-INDEX",
  FINNIFTY: "NSE:FINNIFTY-INDEX",
  MIDCPNIFTY: "NSE:MIDCPNIFTY-INDEX",
  NIFTYIT: "NSE:NIFTYIT-INDEX",
  INDIAVIX: "NSE:INDIAVIX-INDEX",
  SENSEX: "BSE:SENSEX-INDEX",
};

/** "SBIN" → "NSE:SBIN-EQ", "NIFTY" → "NSE:NIFTY50-INDEX", "SBIN26NOVFUT" → "NSE:SBIN26NOVFUT"; a full exchange symbol passes through. */
export function brokerInstrument(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (normalized.includes(":")) return normalized;
  if (/\d{2}[A-Z]{3}FUT$/.test(normalized)) return `NSE:${normalized}`;
  return INDEX_INSTRUMENTS[normalized] ?? `NSE:${normalized}-EQ`;
}

/** The broker's resolution code: minutes ("15", "60") or "D" for daily (weekly/monthly are built from daily). */
export function resolutionCode(interval: ChartInterval): string {
  const { unit, interval: size } = CHART_INTERVAL_CONFIG[interval];
  if (unit === "minutes") return `${size}`;
  if (unit === "hours") return `${size * 60}`;
  return "D";
}

/** The market database's key for a symbol's candles at `interval`, e.g. "NSE:SBIN-EQ:D". */
export function historySeriesKey(symbol: string, interval: ChartInterval): string {
  return `${brokerInstrument(symbol)}:${resolutionCode(interval)}`;
}
