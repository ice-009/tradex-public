// NSE cash-segment tick sizes by price band, as revised from 15 April 2025
// (secondary sources: Fyers and Angel One notices of NSE/CMTR/67133).
//
// NSE assigns each stock's band from its price on a review date, so a stock
// that has moved since can carry a different tick than its current price
// suggests. Every tick divides the next one up (0.01 | 0.05 | 0.1 | 0.5 | 1 | 5),
// so prices for orders are rounded to the tick ONE band coarser than the
// current price's: that price is valid whether the stock's real band is the
// current one or the next — at a cost of at most one tick of precision.

const BANDS: Array<[number, number]> = [
  [250, 0.01],
  [1000, 0.05],
  [5000, 0.1],
  [10000, 0.5],
  [20000, 1],
  [Infinity, 5],
];

/** The tick for a price under the April 2025 bands. */
export function nseTickSize(price: number): number {
  // "Below ₹250", then each band runs up to and including its upper bound (₹1,000, ₹5,000, …).
  if (price < 250) return 0.01;
  return BANDS.slice(1).find(([upTo]) => price <= upTo)?.[1] ?? 5;
}

/** One band coarser than nseTickSize (always a multiple of it) — the tick used for order prices. */
export function safeTickSize(price: number): number {
  const index = BANDS.findIndex(([, tick]) => tick === nseTickSize(price));
  return BANDS[Math.min(BANDS.length - 1, index + 1)][1];
}

/** Round to the safe tick: "down" for a sell stop below, "up" for a buy-stop trigger, else nearest. */
export function roundToTick(price: number, mode: "nearest" | "up" | "down" = "nearest"): number {
  const tick = safeTickSize(price);
  const steps = price / tick;
  const rounded = mode === "up" ? Math.ceil(steps - 1e-9) : mode === "down" ? Math.floor(steps + 1e-9) : Math.round(steps);
  return Number((rounded * tick).toFixed(2));
}
