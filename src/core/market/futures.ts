// NSE stock-futures contracts: naming and expiry.
//
// Fyers symbol format: NSE:{UNDERLYING}{YY}{MMM}FUT (e.g. NSE:SBIN26NOVFUT).
// Monthly stock-derivative expiry has been the LAST TUESDAY of the month since
// September 2025. A holiday can move expiry a day earlier; callers that need to
// be exact should fall back to the next month if a contract stops quoting.

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Last Tuesday of a month (UTC midnight). `month` is 0-based. */
export function lastTuesday(year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const back = (lastDay.getUTCDay() - 2 + 7) % 7;
  return Date.UTC(year, month, lastDay.getUTCDate() - back);
}

/**
 * Near-month futures symbol for an IST day key: this month's contract through its expiry day,
 * next month's after it. `monthsAhead` picks a later contract (1 = next month).
 */
export function nearMonthFuture(symbol: string, day: number, monthsAhead = 0): string {
  const date = new Date(day);
  let year = date.getUTCFullYear();
  let month = date.getUTCMonth();
  if (day > lastTuesday(year, month)) month += 1;
  month += monthsAhead;
  year += Math.floor(month / 12);
  month %= 12;
  return `NSE:${symbol}${String(year).slice(2)}${MONTHS[month]}FUT`;
}

/** Expiry day (last Tuesday) of a futures symbol like NSE:SBIN26NOVFUT, or null if it isn't one. */
export function expiryOf(contract: string): number | null {
  const match = contract.match(/(\d{2})([A-Z]{3})FUT$/);
  if (!match) return null;
  const month = MONTHS.indexOf(match[2]);
  return month < 0 ? null : lastTuesday(2000 + Number(match[1]), month);
}

/** The underlying of a futures symbol (NSE:SBIN26NOVFUT → SBIN). */
export function underlyingOf(contract: string): string {
  return contract.replace(/^NSE:/, "").replace(/\d{2}[A-Z]{3}FUT$/, "");
}

/** Lots that fit a max loss, given the stop distance per share; also what one lot risks. */
export function lotsForRisk(maxLoss: number, riskPerShare: number, lot: number) {
  const perLot = riskPerShare * lot;
  return { lots: perLot > 0 ? Math.floor(maxLoss / perLot) : 0, riskPerLot: perLot };
}
