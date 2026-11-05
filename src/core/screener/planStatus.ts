// Is a screener plan still valid at the live price? The screener scans every
// minute or so with quotes up to a few minutes old, and live prices keep moving
// in between — so a plan made at the scan ("buy at 2,290") can be stale by the
// time you look at it ("now 2,190"). This checks a plan against the live price.
//
// Pure: used by the screener rows and the setup card.

export type PlanStatus =
  | { kind: "ok" }
  /** Price is at or below the plan's stop: the setup is invalid until the next scan. */
  | { kind: "stop-broken"; label: string; detail: string }
  /** A buy-at-close plan whose price has moved well away from the entry since the scan. */
  | { kind: "moved"; label: string; detail: string; pct: number }
  /** A buy-stop plan whose trigger has traded. */
  | { kind: "triggered"; label: string; detail: string }
  /** A buy-stop plan whose trigger is too far above the price to fill next session. */
  | { kind: "far"; label: string; detail: string; pct: number };

export interface PlanLike {
  entry: number;
  stop: number;
}

/** A plan counts as a buy-stop when its entry is above the price at the scan. */
export const isBuyStop = (plan: PlanLike, scanClose: number) => plan.entry > scanClose * 1.0005;

/** Moves bigger than this (and than 0.75 ATR) make a buy-at-close plan stale. */
export const MOVED_PCT = 1.5;
/** A buy-stop more than this many ATRs above the price won't realistically fill next session. */
export const FAR_ATR = 1.5;

const pct = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

/**
 * Status of `plan` (made when the price was `scanClose`) at `price`.
 * `atr` is the stock's 14-day ATR (0 or NaN when unknown).
 */
export function planStatus(plan: PlanLike, scanClose: number, price: number, atr: number): PlanStatus {
  if (!(price > 0) || !(plan.entry > 0)) return { kind: "ok" };
  const range = Number.isFinite(atr) && atr > 0 ? atr : 0;

  if (price <= plan.stop) {
    return { kind: "stop-broken", label: "Below stop", detail: `Now ${price.toFixed(2)}, at or below the plan's stop ${plan.stop.toFixed(2)}: the setup is invalid until the next scan.` };
  }

  if (isBuyStop(plan, scanClose)) {
    if (price >= plan.entry) return { kind: "triggered", label: "Triggered", detail: `Traded through the buy-stop ${plan.entry.toFixed(2)}.` };
    const gap = plan.entry - price;
    const gapPct = (gap / price) * 100;
    if (range > 0 && gap > FAR_ATR * range) {
      return {
        kind: "far",
        label: `${gapPct.toFixed(1)}% to trigger`,
        detail: `The buy-stop ${plan.entry.toFixed(2)} is ${gapPct.toFixed(1)}% (${(gap / range).toFixed(1)} ATR) above the price: unlikely to fill next session. Watch it, don't plan it yet.`,
        pct: gapPct,
      };
    }
    return { kind: "ok" };
  }

  const movePct = ((price - plan.entry) / plan.entry) * 100;
  const threshold = Math.max(MOVED_PCT, range > 0 ? (0.75 * range * 100) / plan.entry : 0);
  if (Math.abs(movePct) > threshold) {
    return {
      kind: "moved",
      label: `${pct(movePct)} since scan`,
      detail:
        movePct < 0
          ? `Entry ${plan.entry.toFixed(2)} was set at the scan; the price has fallen ${Math.abs(movePct).toFixed(1)}% since. Wait for the next scan instead of buying at the old level.`
          : `Entry ${plan.entry.toFixed(2)} was set at the scan; the price has run ${movePct.toFixed(1)}% since. Don't chase: the stop and reward:risk no longer hold.`,
      pct: movePct,
    };
  }
  return { kind: "ok" };
}
