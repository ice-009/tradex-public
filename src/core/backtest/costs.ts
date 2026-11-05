import { nseTickSize } from "@/core/market/ticks";

// Trading costs for NSE stock futures (NRML, carried overnight), one round trip
// = one buy order + one sell order. All rates are fractions of traded value
// (price × quantity) unless noted. Defaults as of November 2026:
//
// - Brokerage: flat ₹20 per executed order, or 0.03% if lower — the common
//   discount-broker rate for futures (Zerodha, Upstox, Fyers, Dhan). Zerodha
//   charges ₹40 on some low-margin intraday F&O orders from 1 Apr 2026, which
//   doesn't apply to overnight (NRML) futures.
// - STT: 0.05% on the SELL side of futures, up from 0.02% from 1 Apr 2026
//   (Union Budget 2026-27; it was 0.0125% → 0.02% on 1 Oct 2024).
// - Exchange transaction charges: ₹183 per crore = 0.00183% on both sides —
//   NSE's total for equity futures (transaction charge + IPFT contribution).
//   NSE's circular of 27 Feb 2026 (effective 1 Mar 2026) moved money between
//   the two parts with "no net change in overall outflow".
// - SEBI turnover fee: ₹10 per crore = 0.0001% on both sides.
// - Stamp duty: 0.002% on the BUY side of futures (₹200 per crore), under the
//   Indian Stamp Act amendments in force since 1 Jul 2020.
// - GST: 18% on brokerage + exchange transaction charges + SEBI fee (not on
//   STT or stamp duty).
// - Slippage: not a charge but the gap between the modelled price and your
//   fill. Applied against you on both legs, as a % of price or in ticks.
//
// Sources (secondary; check your broker's contract note for exact figures):
// Zerodha charges (zerodha.com/charges), Business Today / MediaNama on Zerodha's
// April 2026 changes, onetradejournal.com "STT hike 2026 impact", NSE circular
// "Revision in transaction charges" 27 Feb 2026 (via rhnvrm.github.io/stock-market-circulars).

export interface CostModel {
  /** Flat brokerage per executed order, ₹. */
  brokeragePerOrder: number;
  /** Brokerage cap as a fraction of order value (0.0003 = 0.03%); the lower of the two applies. 0 = always flat. */
  brokeragePct: number;
  /** STT on the sell leg, fraction of value. */
  sttSell: number;
  /** Exchange transaction charges (incl. IPFT), each leg, fraction of value. */
  exchange: number;
  /** SEBI turnover fee, each leg, fraction of value. */
  sebi: number;
  /** Stamp duty on the buy leg, fraction of value. */
  stampBuy: number;
  /** GST on brokerage + exchange + SEBI fee. */
  gst: number;
  /** Slippage per leg, against you: a % of price ("pct", 0.05 = 0.05%) or a number of NSE ticks ("ticks"). */
  slippage: { mode: "pct" | "ticks"; value: number };
}

export type CostPresetId = "futures-2026" | "futures-high-slippage" | "none";

export const COST_PRESETS: Record<CostPresetId, { label: string; note: string; model: CostModel }> = {
  "futures-2026": {
    label: "Stock futures, 2026 rates",
    note: "₹20/order brokerage, STT 0.05% sell, NSE ₹183/cr, SEBI ₹10/cr, stamp 0.002% buy, GST 18%, slippage 0.05% a leg.",
    model: {
      brokeragePerOrder: 20,
      brokeragePct: 0.0003,
      sttSell: 0.0005,
      exchange: 0.0000183,
      sebi: 0.000001,
      stampBuy: 0.00002,
      gst: 0.18,
      slippage: { mode: "pct", value: 0.05 },
    },
  },
  "futures-high-slippage": {
    label: "Stock futures, cautious fills",
    note: "Same charges, slippage 0.15% a leg — closer to stop orders filled in a fast market or thinner contracts.",
    model: {
      brokeragePerOrder: 20,
      brokeragePct: 0.0003,
      sttSell: 0.0005,
      exchange: 0.0000183,
      sebi: 0.000001,
      stampBuy: 0.00002,
      gst: 0.18,
      slippage: { mode: "pct", value: 0.15 },
    },
  },
  none: {
    label: "No costs (gross)",
    note: "No charges and no slippage — useful only to see how much the costs take.",
    model: { brokeragePerOrder: 0, brokeragePct: 0, sttSell: 0, exchange: 0, sebi: 0, stampBuy: 0, gst: 0, slippage: { mode: "pct", value: 0 } },
  },
};

export interface CostBreakdown {
  brokerage: number;
  stt: number;
  exchange: number;
  sebi: number;
  stamp: number;
  gst: number;
  /** Charges only (everything above); slippage is in the fill prices. */
  total: number;
}

export const emptyCosts = (): CostBreakdown => ({ brokerage: 0, stt: 0, exchange: 0, sebi: 0, stamp: 0, gst: 0, total: 0 });

/** Charges on one order (one leg). */
export function legCosts(side: "buy" | "sell", price: number, qty: number, model: CostModel): CostBreakdown {
  const value = Math.abs(price * qty);
  if (!(value > 0)) return emptyCosts();
  const brokerage = model.brokeragePct > 0 ? Math.min(model.brokeragePerOrder, value * model.brokeragePct) : model.brokeragePerOrder;
  const stt = side === "sell" ? value * model.sttSell : 0;
  const exchange = value * model.exchange;
  const sebi = value * model.sebi;
  const stamp = side === "buy" ? value * model.stampBuy : 0;
  const gst = (brokerage + exchange + sebi) * model.gst;
  return { brokerage, stt, exchange, sebi, stamp, gst, total: brokerage + stt + exchange + sebi + stamp + gst };
}

export function addCosts(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    brokerage: a.brokerage + b.brokerage,
    stt: a.stt + b.stt,
    exchange: a.exchange + b.exchange,
    sebi: a.sebi + b.sebi,
    stamp: a.stamp + b.stamp,
    gst: a.gst + b.gst,
    total: a.total + b.total,
  };
}

/** Charges for a buy-then-sell round trip. */
export function roundTripCosts(entry: number, exit: number, qty: number, model: CostModel): CostBreakdown {
  return addCosts(legCosts("buy", entry, qty, model), legCosts("sell", exit, qty, model));
}

/** The price you actually get: worse than `price` by the slippage (higher on a buy, lower on a sell). */
export function slipped(side: "buy" | "sell", price: number, model: CostModel): number {
  const { mode, value } = model.slippage;
  if (!(value > 0)) return price;
  const amount = mode === "ticks" ? nseTickSize(price) * value : (price * value) / 100;
  return side === "buy" ? price + amount : price - amount;
}
