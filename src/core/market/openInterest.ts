// Open-interest reading of a stock's futures for one session, from NSE's F&O
// bhavcopy as the Market Data Hub serves it (GET /v1/fo/oi/day). Pure.
//
// The usual "buildup" labels cross the sign of the price change with the sign
// of the change in open interest:
//
//                  OI up            OI down
//   price up       Long buildup     Short covering
//   price down     Short buildup    Long unwinding
//
// Price change is the near-month future's close vs its own previous close (same
// contract, so an expiry roll can't fake a move). OI change is the combined
// change across all listed months (sum of each month's change, so a rollover
// isn't read as unwinding).
//
// INFORMATION ONLY. Tested over Oct 2025 – Nov 2026 on every F&O stock, none of
// the four classes (nor the futures basis) gave a tradeable edge after costs,
// either overnight or close to close. That is why it is shown as a fact next to
// a setup and never feeds the setup score.

/** One month's stock futures on a trade day. */
export interface FoLeg {
  /** Expiry as a day key (UTC midnight of the date). */
  expiry: number;
  close: number;
  settle: number;
  prevClose: number;
  /** Contracts traded. */
  volume: number;
  /** Open interest in shares. */
  oi: number;
  chgOi: number;
}

/** One underlying's stock futures on one trade day. */
export interface FoDayRecord {
  /** Trade day key (UTC midnight of the IST date). */
  day: number;
  /** App ticker (after NSE's renames). */
  symbol: string;
  /** Ticker as NSE wrote it that day. */
  nseSymbol: string;
  /** Listed months (usually 3). */
  expiries: number;
  lot: number | null;
  underlying: number | null;
  near: FoLeg;
  next: FoLeg | null;
  /** Open interest summed over every listed month (shares). */
  oi: number;
  /** Sum of each month's change in OI (shares). */
  chgOi: number;
}

export type OiBuildup = "long-buildup" | "short-buildup" | "short-covering" | "long-unwinding";

export const BUILDUP_LABEL: Record<OiBuildup, string> = {
  "long-buildup": "Long buildup",
  "short-buildup": "Short buildup",
  "short-covering": "Short covering",
  "long-unwinding": "Long unwinding",
};

/** The buildup class from the two signs; null when either is flat (or not a number). */
export function oiBuildup(priceChange: number, oiChange: number): OiBuildup | null {
  if (!Number.isFinite(priceChange) || !Number.isFinite(oiChange) || priceChange === 0 || oiChange === 0) return null;
  if (priceChange > 0) return oiChange > 0 ? "long-buildup" : "short-covering";
  return oiChange > 0 ? "short-buildup" : "long-unwinding";
}

/** Combined OI change as % of the previous session's combined OI (null when there was none). */
export function combinedOiChangePct(record: Pick<FoDayRecord, "oi" | "chgOi">): number | null {
  const previous = record.oi - record.chgOi;
  return previous > 0 ? (record.chgOi / previous) * 100 : null;
}

/** What the screener shows for one F&O stock. */
export interface OiFact {
  /** Session of the F&O data (day key). */
  day: number;
  buildup: OiBuildup | null;
  /** Near-month future's % change on that session. */
  pricePct: number;
  /** Combined OI change %, null when there was no previous OI. */
  oiPct: number | null;
  /** Combined OI and its change, in shares. */
  oi: number;
  chgOi: number;
  /** Near-month future's premium (+) or discount (−) to the underlying, %. */
  basisPct: number | null;
}

export function oiFact(record: FoDayRecord): OiFact {
  const { near } = record;
  return {
    day: record.day,
    buildup: oiBuildup(near.close - near.prevClose, record.chgOi),
    pricePct: near.prevClose > 0 ? (near.close / near.prevClose - 1) * 100 : 0,
    oiPct: combinedOiChangePct(record),
    oi: record.oi,
    chgOi: record.chgOi,
    basisPct: record.underlying && record.underlying > 0 ? (near.close / record.underlying - 1) * 100 : null,
  };
}

const signed = (value: number, digits: number) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;

/** Short tag, e.g. "Long buildup · OI +6%". */
export function oiTag(fact: OiFact): string {
  const oi = fact.oiPct === null ? "OI new" : `OI ${signed(fact.oiPct, Math.abs(fact.oiPct) < 10 ? 1 : 0)}%`;
  return fact.buildup ? `${BUILDUP_LABEL[fact.buildup]} · ${oi}` : oi;
}

/** Shares as "12.3 L" / "1.4 Cr" (Indian units). */
export function sharesShort(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e7) return `${(value / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${(value / 1e5).toFixed(1)} L`;
  return Math.round(value).toLocaleString("en-IN");
}

/** Longer explanation for a tooltip. `dateLabel` is the session, already formatted. */
export function oiTooltip(fact: OiFact, dateLabel: string): string {
  const lines = [
    `Stock futures on ${dateLabel} (NSE F&O bhavcopy, via the Market Data Hub):`,
    `Near-month future ${signed(fact.pricePct, 2)}%, open interest across all months ${fact.oiPct === null ? "new" : `${signed(fact.oiPct, 1)}%`} (${fact.chgOi >= 0 ? "+" : "−"}${sharesShort(Math.abs(fact.chgOi))} to ${sharesShort(fact.oi)} shares).`,
  ];
  if (fact.basisPct !== null) lines.push(`Near-month ${fact.basisPct >= 0 ? "premium" : "discount"} to the stock: ${Math.abs(fact.basisPct).toFixed(2)}%.`);
  lines.push("Information only: OI buildup and basis showed no tested edge on their own (Oct 2025 – Nov 2026 backtests), so they are not part of the score.");
  return lines.join("\n");
}
