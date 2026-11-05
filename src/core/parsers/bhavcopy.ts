// NSE full bhavcopy (sec_bhavdata_full_DDMMYYYY.csv) → one row per symbol.
// Pure: no I/O. The download and caching live in src/server/providers/dailyStore.ts.

export interface BhavRow {
  prevClose: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  deliveryPct: number | null;
}

export function parseBhav(csv: string): Record<string, BhavRow> {
  const rows: Record<string, BhavRow> = {};
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const cols = line.split(",").map((col) => col.trim());
    if (cols.length < 15) continue;
    const [symbol, series, , prevClose, open, high, low, , close, , volume, , , , deliveryPct] = cols;
    // EQ is the normal rolling segment; BE (trade-for-trade) keeps the series going if a stock moves there.
    if (series !== "EQ" && !(series === "BE" && !rows[symbol])) continue;
    const delivery = Number(deliveryPct);
    rows[symbol] = {
      prevClose: Number(prevClose),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
      deliveryPct: Number.isFinite(delivery) ? delivery : null,
    };
  }
  return rows;
}

