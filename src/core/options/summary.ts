import { DAY_MS } from "@/core/market/session";

// Daily option summaries (issue #36), as the Market Data Hub computes them from
// NSE's F&O bhavcopy (market-data-hub#30, GET /v1/options/summary and
// /v1/options/day): one row per underlying per day — open interest, volume,
// put–call ratios, max pain, OI walls, the ATM straddle and implied volatility
// (Black-76) for the near and next expiry, and a constant-30-day ATM IV.
//
// Tradex doesn't recompute any of it. This module turns a day into what the
// Options panel and the screener show (term structure, skew, the move the
// straddle prices, levels against spot) and ranks iv30 against the year up to
// that day. Everything here reads only the days it is given, and the callers
// cut those at the day shown (`throughDay`), so nothing after it gets in.
//
// IVs are decimals (0.179 = 17.9%); OI in shares, volume in contracts; prices
// (spot, forward, strikes, straddle) as traded that day.

/** Row flags (`LOT_ESTIMATED`, `AMERICAN`) and expiry flags (the rest), by name as the hub sends them. */
export type OptionFlag = "FORWARD_PARITY" | "FORWARD_CARRY" | "NO_FORWARD" | "ATM_THEORETICAL" | "FEW_STRIKES" | "AMERICAN" | "LOT_ESTIMATED" | "IV_OUT_OF_RANGE" | "ATM_UNTRADED";

/** One expiry (near or next) of an underlying's options on a day. */
export interface OptionLeg {
  expiry: string;
  expiryDay: number;
  /** Calendar days from the trade day to expiry. */
  days: number;
  forward: number | null;
  atmStrike: number | null;
  /** ATM call + put: roughly the move priced to expiry. */
  straddle: number | null;
  /** straddle / forward × 100. */
  expectedMovePct: number | null;
  atmIv: number | null;
  callIv: number | null;
  putIv: number | null;
  /** Call IV − put IV over strikes where both legs are usable, OI-weighted; only with a futures forward. */
  cpSpread: number | null;
  iv25Put: number | null;
  iv25Call: number | null;
  /** 25-delta put IV − call IV. */
  skew25: number | null;
  maxPain: number | null;
  callWall: number | null;
  callWallOi: number | null;
  putWall: number | null;
  putWallOi: number | null;
  callOi: number;
  putOi: number;
  pcrOi: number | null;
  strikes: number;
  liquidStrikes: number;
  flags: string[];
}

/** One underlying's options on one trade day (the hub's /v1/options/summary day; /v1/options/day rows add `symbol`). */
export interface OptionDay {
  date: string;
  /** Day key: UTC midnight of the IST trade date. */
  day: number;
  /** The name it traded under that day (a renamed stock's old ticker). */
  ticker: string;
  kind: "stock" | "index";
  spot: number | null;
  lot: number | null;
  lotEstimated: boolean;
  expiries: number;
  callOi: number;
  putOi: number;
  callChgOi: number;
  putChgOi: number;
  callVolume: number;
  putVolume: number;
  pcrOi: number | null;
  pcrVolume: number | null;
  optionShares: number | null;
  stockVolume: number | null;
  optionToStock: number | null;
  iv30: number | null;
  /** Share (0–100) of the 365 calendar days up to and including this day whose iv30 was lower (null with under 60). */
  ivPercentile: number | null;
  flags: string[];
  near: OptionLeg | null;
  next: OptionLeg | null;
}

/** The hub's own percentile needs this many iv30 days in its window; the local rank uses the same. */
export const IV_RANK_MIN_DAYS = 60;
/** The window iv30 is ranked over: the 365 calendar days up to and including the day (as the hub's percentile). */
export const IV_RANK_WINDOW_DAYS = 365;
/** Term structure and skew smaller than this (in IV points, 0.005 = half a vol point) are called flat. */
const FLAT_POINTS = 0.005;

/**
 * The days known by the close of `through` (day key), oldest first, one per
 * day. The hub already answers only up to `to`; this is Tradex's own cut, so a
 * hub that sent later days (or a cache of a longer range) can't leak them.
 */
export function throughDay<T extends { day: number }>(days: readonly T[], through: number): T[] {
  const byDay = new Map<number, T>();
  for (const entry of days) if (Number.isFinite(entry.day) && entry.day <= through && !byDay.has(entry.day)) byDay.set(entry.day, entry);
  return [...byDay.values()].sort((a, b) => a.day - b.day);
}

/** iv30 against its own past year: where it sits between the year's low and high, and the share of days it was above. */
export interface IvRank {
  /** (iv30 − low) / (high − low) × 100, 0–100. */
  rank: number;
  /** Share (0–100) of the window's days with a lower iv30 (computed here; matches the hub's ivPercentile). */
  percentile: number;
  iv30: number;
  low: number;
  high: number;
  /** iv30 days in the window (the sample size). */
  days: number;
  /** First and last day of the window that had an iv30. */
  from: number;
  to: number;
}

/**
 * Rank the iv30 of day `at` among the iv30s of the 365 calendar days up to and
 * including it. Null without an iv30 that day or with fewer than 60 days of it
 * in the window. Days after `at` are ignored even if given.
 */
export function ivRank(days: readonly Pick<OptionDay, "day" | "iv30">[], at: number): IvRank | null {
  const start = at - IV_RANK_WINDOW_DAYS * DAY_MS;
  const window = days.filter((entry) => entry.day > start && entry.day <= at && entry.iv30 !== null && Number.isFinite(entry.iv30)) as Array<{ day: number; iv30: number }>;
  const today = window.find((entry) => entry.day === at);
  if (!today || window.length < IV_RANK_MIN_DAYS) return null;
  const values = window.map((entry) => entry.iv30);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const lower = values.filter((value) => value < today.iv30).length;
  return {
    rank: high > low ? Math.round((1000 * (today.iv30 - low)) / (high - low)) / 10 : 50,
    percentile: Math.round((1000 * lower) / values.length) / 10,
    iv30: today.iv30,
    low,
    high,
    days: values.length,
    from: Math.min(...window.map((entry) => entry.day)),
    to: Math.max(...window.map((entry) => entry.day)),
  };
}

export type TermShape = "upward" | "inverted" | "flat";

/** ATM IV by expiry: near, next and the constant 30-day point between them. */
export interface TermStructure {
  near: { expiry: string; days: number; iv: number } | null;
  next: { expiry: string; days: number; iv: number } | null;
  iv30: number | null;
  /** next − near ATM IV (IV points as a decimal); null without both. */
  slope: number | null;
  /** upward: later expiries priced higher (the usual calm state); inverted: near-term fear or an event before the near expiry. */
  shape: TermShape | null;
}

export function termStructure(day: Pick<OptionDay, "near" | "next" | "iv30">): TermStructure {
  const point = (leg: OptionLeg | null) => (leg && leg.atmIv !== null ? { expiry: leg.expiry, days: leg.days, iv: leg.atmIv } : null);
  const near = point(day.near);
  const next = point(day.next);
  const slope = near && next ? next.iv - near.iv : null;
  return { near, next, iv30: day.iv30, slope, shape: slope === null ? null : Math.abs(slope) < FLAT_POINTS ? "flat" : slope > 0 ? "upward" : "inverted" };
}

/** The 25-delta skew of one expiry. */
export interface Skew {
  expiry: string;
  put25: number | null;
  call25: number | null;
  /** put25 − call25: positive when downside protection is richer (the usual state for indices). */
  skew25: number | null;
  /** OI-weighted call − put IV at the same strikes (Cremers & Weinbaum); null with a parity forward. */
  cpSpread: number | null;
  lean: "puts" | "calls" | "flat" | null;
}

/** Skew of the near expiry, or of the next when the near has no 25-delta reading. */
export function skewOf(day: Pick<OptionDay, "near" | "next">): Skew | null {
  const leg = [day.near, day.next].find((entry) => entry && entry.skew25 !== null) ?? day.near ?? day.next;
  if (!leg) return null;
  const skew = leg.skew25 ?? (leg.iv25Put !== null && leg.iv25Call !== null ? leg.iv25Put - leg.iv25Call : null);
  return { expiry: leg.expiry, put25: leg.iv25Put, call25: leg.iv25Call, skew25: skew, cpSpread: leg.cpSpread, lean: skew === null ? null : Math.abs(skew) < FLAT_POINTS ? "flat" : skew > 0 ? "puts" : "calls" };
}

/** The move the near expiry's ATM straddle prices, around its forward. */
export interface ImpliedMove {
  expiry: string;
  days: number;
  straddle: number;
  forward: number;
  /** straddle / forward × 100. */
  pct: number;
  /** forward ∓ straddle: the break-evens of buying the straddle. */
  low: number;
  high: number;
  /** One standard deviation to expiry (straddle ≈ 0.8 σ√T F, so σ√T F ≈ straddle / 0.8). */
  sigmaPct: number;
  /** A leg (or both) had no usable trade: the straddle is partly or wholly modelled (ATM_UNTRADED). */
  modelled: boolean;
}

/** √(2/π): an ATM straddle is worth about this × σ√T × F. */
const STRADDLE_SIGMA = Math.sqrt(2 / Math.PI);

export function impliedMove(leg: OptionLeg | null): ImpliedMove | null {
  if (!leg || leg.straddle === null || leg.forward === null || !(leg.forward > 0) || !(leg.straddle > 0)) return null;
  const pct = (100 * leg.straddle) / leg.forward;
  return {
    expiry: leg.expiry,
    days: leg.days,
    straddle: leg.straddle,
    forward: leg.forward,
    pct,
    low: leg.forward - leg.straddle,
    high: leg.forward + leg.straddle,
    sigmaPct: pct / STRADDLE_SIGMA,
    modelled: leg.flags.includes("ATM_UNTRADED"),
  };
}

/** A strike against the spot price that day. */
export interface Level {
  strike: number;
  /** (strike − spot) / spot × 100; null without a spot. */
  fromSpotPct: number | null;
  /** OI at the strike (walls only), shares. */
  oi: number | null;
}

/** Max pain and the OI walls of one expiry. */
export interface Levels {
  expiry: string;
  maxPain: Level | null;
  callWall: Level | null;
  putWall: Level | null;
}

export function levelsOf(leg: OptionLeg | null, spot: number | null): Levels | null {
  if (!leg) return null;
  const level = (strike: number | null, oi: number | null): Level | null => (strike === null ? null : { strike, fromSpotPct: spot && spot > 0 ? (100 * (strike - spot)) / spot : null, oi });
  return { expiry: leg.expiry, maxPain: level(leg.maxPain, null), callWall: level(leg.callWall, leg.callWallOi), putWall: level(leg.putWall, leg.putWallOi) };
}

/** What each hub flag means for the numbers shown. */
export const FLAG_NOTES: Record<OptionFlag, string> = {
  FORWARD_PARITY: "No same-expiry future: the forward is read from put–call parity (weekly index expiries), so the call–put IV spread isn't shown.",
  FORWARD_CARRY: "No future or parity pair: the forward is another expiry's (or the spot) carried at the risk-free rate.",
  NO_FORWARD: "No forward could be found: no IV, straddle or delta for this expiry.",
  ATM_THEORETICAL: "No traded strike near the money: ATM IV comes from NSE's theoretical settlement prices.",
  FEW_STRIKES: "Fewer than 3 strikes had a usable price: IVs rest on very few trades.",
  AMERICAN: "American-style contracts (NSE's stock options before ~2011), read as European: put IVs run a little high.",
  LOT_ESTIMATED: "Lot size estimated from turnover (the old files have none): within ~1% of NSE's published lots where checked.",
  IV_OUT_OF_RANGE: "ATM IV came out outside 2–300% and was dropped.",
  ATM_UNTRADED: "An ATM leg didn't trade: the straddle is partly or wholly modelled from the other leg or the ATM IV.",
};

const isFlag = (flag: string): flag is OptionFlag => flag in FLAG_NOTES;

/** The notes for a day's flags (row and both expiries), each once, with the expiry it applies to. */
export function flagNotes(day: Pick<OptionDay, "flags" | "near" | "next">): string[] {
  const out: string[] = [];
  for (const flag of new Set(day.flags)) if (isFlag(flag)) out.push(FLAG_NOTES[flag]);
  const near = new Set(day.near?.flags ?? []);
  const next = new Set(day.next?.flags ?? []);
  for (const flag of new Set([...near, ...next])) {
    if (!isFlag(flag)) continue;
    const where = near.has(flag) && next.has(flag) ? "Both expiries" : near.has(flag) ? `Near expiry (${day.near!.expiry})` : `Next expiry (${day.next!.expiry})`;
    out.push(`${where}: ${FLAG_NOTES[flag]}`);
  }
  return out;
}

/** Everything the Options panel shows about one day. */
export interface OptionView {
  term: TermStructure;
  skew: Skew | null;
  move: ImpliedMove | null;
  levels: Levels | null;
  pcr: { oi: number | null; volume: number | null; callChgOi: number; putChgOi: number };
  optionToStock: number | null;
  notes: string[];
}

export function optionView(day: OptionDay): OptionView {
  return {
    term: termStructure(day),
    skew: skewOf(day),
    move: impliedMove(day.near),
    levels: levelsOf(day.near, day.spot),
    pcr: { oi: day.pcrOi, volume: day.pcrVolume, callChgOi: day.callChgOi, putChgOi: day.putChgOi },
    optionToStock: day.optionToStock,
    notes: flagNotes(day),
  };
}

/** One day of the IV history chart. */
export interface OptionPoint {
  day: number;
  iv30: number | null;
  nearIv: number | null;
  nextIv: number | null;
  ivPercentile: number | null;
  pcrOi: number | null;
  spot: number | null;
}

export const optionPoint = (day: OptionDay): OptionPoint => ({
  day: day.day,
  iv30: day.iv30,
  nearIv: day.near?.atmIv ?? null,
  nextIv: day.next?.atmIv ?? null,
  ivPercentile: day.ivPercentile,
  pcrOi: day.pcrOi,
  spot: day.spot,
});

/**
 * The screener's option fact for a stock (information only, never scored):
 * iv30, where it sits in its own past year (the hub's percentile), the move
 * the near straddle prices, and the put–call ratio.
 */
export interface OptionFact {
  day: number;
  iv30: number;
  ivPercentile: number | null;
  movePct: number | null;
  moveDays: number | null;
  pcrOi: number | null;
  skew25: number | null;
}

export function optionFact(day: OptionDay): OptionFact | null {
  if (day.iv30 === null || !Number.isFinite(day.iv30)) return null;
  const move = impliedMove(day.near);
  return { day: day.day, iv30: day.iv30, ivPercentile: day.ivPercentile, movePct: move?.pct ?? null, moveDays: move?.days ?? null, pcrOi: day.pcrOi, skew25: skewOf(day)?.skew25 ?? null };
}

/** "28.4%" for an IV decimal. */
export const ivText = (iv: number | null, digits = 1) => (iv === null || !Number.isFinite(iv) ? "—" : `${(iv * 100).toFixed(digits)}%`);
/** "+2.1 pts" for a difference of IV decimals. */
export const ivPoints = (diff: number | null, digits = 1) => (diff === null || !Number.isFinite(diff) ? "—" : `${diff >= 0 ? "+" : "−"}${Math.abs(diff * 100).toFixed(digits)} pts`);
