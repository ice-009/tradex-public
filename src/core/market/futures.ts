// NSE stock-futures contracts: which one to trade, and lot maths. Pure.
//
// Contracts come from the Market Data Hub (GET /v1/fo/contracts): each listed
// month's ticker (e.g. SBIN26NOVFUT) and its real expiry, so holiday-shifted
// expiries and the roll to next month are the hub's job, not guessed here.

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FuturesContract {
  /** The hub's ticker, e.g. "SBIN26NOVFUT". Also the app symbol for charts and quotes. */
  ticker: string;
  /** Expiry as a day key (UTC midnight of the date). */
  expiry: number;
  kind: "near" | "next";
}

/** "2026-11-24" → day key (UTC midnight); null when it isn't a date. */
export function expiryDayKey(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

/**
 * The contract to trade for a plan held about `holdDays` sessions: the near month,
 * unless it expires within the holding period (+1 session of margin), then the next.
 * `rollToNext` says the near month was skipped for that reason.
 */
export function pickContract(contracts: FuturesContract[], today: number, holdDays: number): { near: FuturesContract | null; next: FuturesContract | null; rollToNext: boolean } {
  const live = contracts.filter((contract) => contract.expiry >= today).sort((a, b) => a.expiry - b.expiry);
  const near = live.find((contract) => contract.kind === "near") ?? live[0] ?? null;
  const next = live.find((contract) => near && contract.expiry > near.expiry) ?? null;
  const calendarDays = Math.ceil(holdDays * 1.45) + 1;
  return { near, next, rollToNext: Boolean(near && next && near.expiry - today <= calendarDays * DAY_MS) };
}

/** Lots that fit a max loss, given the stop distance per share; also what one lot risks. */
export function lotsForRisk(maxLoss: number, riskPerShare: number, lot: number) {
  const perLot = riskPerShare * lot;
  return { lots: perLot > 0 ? Math.floor(maxLoss / perLot) : 0, riskPerLot: perLot };
}
