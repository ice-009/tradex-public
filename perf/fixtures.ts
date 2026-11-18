// Deterministic synthetic market data for the performance benchmarks.
//
// Everything is generated from a fixed seed, so every run — on any machine, on
// the PR head and on the merge base — benchmarks exactly the same bars. The
// series are random walks with drifting trends, volatility regimes, gaps and
// volume spikes, so the screens actually fire (a benchmark where no rule ever
// matches would skip most of the work it is meant to measure).

import type { Bar, DailyBar } from "@/core/types";

/** Stocks in the synthetic F&O list (the real list is ~210–220 stocks). */
export const FNO_SYMBOLS = 220;
/** Five years of weekday sessions. */
export const SESSIONS_5Y = 5 * 261;

const DAY = 86_400_000;
const SECTORS = [
  "Financial Services",
  "Information Technology",
  "Oil Gas & Consumable Fuels",
  "Automobile and Auto Components",
  "Fast Moving Consumer Goods",
  "Healthcare",
  "Metals & Mining",
  "Capital Goods",
  "Power",
  "Chemicals",
  "Construction Materials",
  "Consumer Durables",
  "Realty",
  "Telecommunication",
  "Services",
];

/** mulberry32: a tiny, fast, seedable PRNG (uniform in [0, 1)). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal from two uniforms (Box–Muller). */
function gauss(next: () => number) {
  const u = Math.max(next(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

/** `count` weekday sessions (UTC midnight) ending on Friday 30 Oct 2026. */
export function weekdaySessions(count: number): number[] {
  const out: number[] = [];
  let t = Date.UTC(2026, 9, 30);
  while (out.length < count) {
    const weekday = new Date(t).getUTCDay();
    if (weekday !== 0 && weekday !== 6) out.push(t);
    t -= DAY;
  }
  return out.reverse();
}

/** One stock's daily history: a regime-switching random walk with gaps, volume spikes and delivery %. */
export function dailySeries(seed: number, sessions: number[], startPrice = 100 + (seed % 37) * 40): DailyBar[] {
  const next = rng(seed * 7919 + 17);
  const bars: DailyBar[] = [];
  let close = startPrice;
  let drift = 0;
  let vol = 0.015 + next() * 0.015;
  const baseVolume = 2e5 + next() * 5e6;
  for (const t of sessions) {
    if (next() < 0.02) drift = (next() - 0.45) * 0.004; // a new trend now and then
    if (next() < 0.01) vol = 0.01 + next() * 0.03; // and a new volatility regime
    const gap = next() < 0.03 ? gauss(next) * vol * 3 : gauss(next) * vol * 0.3;
    const open = close * (1 + gap);
    const c = Math.max(1, open * (1 + drift + gauss(next) * vol));
    const h = Math.max(open, c) * (1 + Math.abs(gauss(next)) * vol * 0.5);
    const l = Math.min(open, c) * (1 - Math.abs(gauss(next)) * vol * 0.5);
    const spike = next() < 0.04 ? 2 + next() * 4 : 1;
    const v = Math.round(baseVolume * spike * Math.exp(gauss(next) * 0.35));
    bars.push({ t, o: round(open), h: round(h), l: round(l), c: round(c), v, dp: Math.round((20 + next() * 55) * 100) / 100 });
    close = c;
  }
  return bars;
}

const round = (value: number) => Math.round(value * 100) / 100;

export interface Universe {
  symbols: string[];
  bars: Map<string, DailyBar[]>;
  benchmark: DailyBar[];
  members: Map<string, { name: string; industry: string }>;
  /** Today's (in-progress) bar per symbol, as the live screener sees it during market hours. */
  live: Map<string, DailyBar>;
}

/** The synthetic F&O list: `symbols` stocks × `sessions` sessions of daily bars, plus a NIFTY benchmark. */
export function fnoUniverse(symbols = FNO_SYMBOLS, sessions = SESSIONS_5Y): Universe {
  const days = weekdaySessions(sessions + 1);
  const stored = days.slice(0, -1);
  const today = days[days.length - 1];
  const list = Array.from({ length: symbols }, (_, i) => `SYM${String(i + 1).padStart(3, "0")}`);
  const bars = new Map<string, DailyBar[]>();
  const live = new Map<string, DailyBar>();
  const members = new Map<string, { name: string; industry: string }>();
  list.forEach((symbol, i) => {
    // A few stocks listed partway through the period, like real F&O additions.
    const listedFrom = i % 23 === 0 ? Math.floor(stored.length * 0.4) : 0;
    const history = dailySeries(i + 1, stored.slice(listedFrom));
    bars.set(symbol, history);
    const last = history[history.length - 1];
    const next = rng(i + 99_991);
    const c = round(last.c * (1 + (next() - 0.45) * 0.04));
    live.set(symbol, { t: today, o: last.c, h: Math.max(last.c, c) * 1.004, l: Math.min(last.c, c) * 0.996, c, v: Math.round(last.v * (0.5 + next())) });
    members.set(symbol, { name: `Synthetic ${symbol}`, industry: SECTORS[i % SECTORS.length] });
  });
  return { symbols: list, bars, benchmark: dailySeries(424242, stored, 15000), members, live };
}

/** `count` chart bars: daily (one per weekday) or 5-minute intraday bars in NSE sessions (09:15–15:30 IST). */
export function chartBars(count: number, kind: "daily" | "5m", seed = 7): Bar[] {
  if (kind === "daily") {
    return dailySeries(seed, weekdaySessions(count)).map((bar) => ({ time: bar.t, open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v }));
  }
  const perSession = 75; // 09:15 → 15:30 in 5-minute bars
  const days = weekdaySessions(Math.ceil(count / perSession));
  const next = rng(seed);
  const out: Bar[] = [];
  let close = 2500;
  for (const day of days) {
    const open915 = day + (3 * 60 + 45) * 60_000; // 09:15 IST = 03:45 UTC
    for (let k = 0; k < perSession && out.length < count; k += 1) {
      const open = close * (1 + gauss(next) * 0.0004);
      const c = open * (1 + gauss(next) * 0.0015);
      out.push({
        time: open915 + k * 5 * 60_000,
        open: round(open),
        high: round(Math.max(open, c) * (1 + Math.abs(gauss(next)) * 0.0006)),
        low: round(Math.min(open, c) * (1 - Math.abs(gauss(next)) * 0.0006)),
        close: round(c),
        volume: Math.round(5e4 * Math.exp(gauss(next) * 0.5)),
      });
      close = c;
    }
  }
  return out;
}
