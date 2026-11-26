import { WARMUP_SESSIONS, scanSignals, type SignalScan } from "@/core/backtest/signals";
import { SCREENS, type ScreenDef } from "@/core/screener/screens";
import type { DailyBar } from "@/core/types";
import { MAX_DAILY_MOVE, type LabSignalMeta, type SignalValues } from "./engine";
import { MOMENTUM_SIGNALS } from "./momentumSignals";
import { SCORE_SIGNALS } from "./scoreSignals";

// The Signal Lab's signals: anything that gives one number per stock per day.
// Pure.
//
// ADDING A SIGNAL is one entry in BUILT_IN_SIGNALS below: an id, a name, its
// parameters (with defaults and bounds) and `build`, which returns the value
// of a stock on a session from its bars up to and including that session.
// `perBar` does the bookkeeping; the service, the API, the CLI
// (`npm run lab -- --signal <id>`) and the Lab panel pick it up with no other
// change. Higher values go to the top bucket (Q5): a positive Q5 − Q1 spread
// means "high values did better".
//
// Every screen (src/core/screener/screens.ts) is a signal twice:
//   screen:<id>        1 on a session the screen matched the stock, else 0 —
//                      does a match beat the rest of the list?
//   screen-score:<id>  the screen's score on a match, no value otherwise —
//                      among its matches, does the score pick the better ones?
// They read the screens' signal scan (src/core/backtest/signals.ts: no
// look-ahead), which the service shares with the backtester.

export interface SignalContext {
  /** Trading calendar, oldest first. */
  dates: readonly number[];
  symbols: readonly string[];
  bars: ReadonlyMap<string, readonly DailyBar[]>;
  /** NIFTY (or its stand-in before 2012). */
  benchmark: readonly DailyBar[];
  /** Point-in-time membership, for the screens' cross-sectional ranks. */
  isMember?: (symbol: string, day: number) => boolean;
  /** A scan of every screen over these bars (the backtest's cache); screen signals scan by themselves without one. */
  scan?: SignalScan | null;
  /** Called between sessions of a scan so a server stays responsive. */
  pause?: () => Promise<void>;
  /** A stock's industry (today's NSE classification), for signals with `usesIndustries`; null when unknown. */
  industryOf?: (symbol: string) => string | null;
}

export interface ParamSpec {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  /** Whole numbers only (sessions). */
  integer?: boolean;
}

export type SignalGroup = "built-in" | "screen" | "screen-score";

export interface LabSignal {
  id: string;
  name: string;
  group: SignalGroup;
  kind: "numeric" | "binary";
  summary: string;
  params: ParamSpec[];
  /** Reads the screens' signal scan (the service hands it the backtest's cached one). */
  usesScan?: boolean;
  /** Reads `industryOf` with these parameters (the service then loads the industry map). */
  usesIndustries?: (params: Record<string, number>) => boolean;
  /** Calendar days of history the signal needs before the first formation day, when more than the backtester's warm-up. */
  warmupDays?: (params: Record<string, number>) => number;
  build(ctx: SignalContext, params: Record<string, number>): SignalValues | Promise<SignalValues>;
}

/**
 * A signal computed from each stock's own bars: `compute(bars, i)` is the value
 * at the close of bar i, using bars[0 … i] only. Per-symbol indexes are built on
 * first use.
 */
export function perBar(ctx: SignalContext, compute: (bars: readonly DailyBar[], i: number) => number | null): SignalValues {
  const series = new Map<string, { bars: readonly DailyBar[]; at: Map<number, number> } | null>();
  return (day, symbol) => {
    let entry = series.get(symbol);
    if (entry === undefined) {
      const bars = ctx.bars.get(symbol);
      entry = bars?.length ? { bars, at: new Map(bars.map((bar, i) => [bar.t, i])) } : null;
      series.set(symbol, entry);
    }
    const i = entry?.at.get(day);
    if (!entry || i === undefined) return null;
    const value = compute(entry.bars, i);
    return value === null || !Number.isFinite(value) ? null : value;
  };
}

const sessions = (key: string, label: string, value: number, min: number, max: number): ParamSpec => ({ key, label, default: value, min, max, integer: true });

/** Mean of the `top` largest daily (close-to-close) returns in the `window` sessions ending at bar i; top = 1 is MAX. */
export function topDailyReturns(bars: readonly DailyBar[], i: number, window: number, top: number): number | null {
  if (i < window) return null;
  const k = Math.min(top, window);
  const best: number[] = [];
  for (let j = i - window + 1; j <= i; j += 1) {
    const r = bars[j].c / bars[j - 1].c - 1;
    if (best.length < k) best.push(r);
    else if (r > best[k - 1]) best[k - 1] = r;
    else continue;
    best.sort((a, b) => b - a);
  }
  return best.reduce((sum, r) => sum + r, 0) / k;
}

/**
 * A session's return split at the open: overnight = log(open / previous close),
 * intraday = log(close / open); together the close-to-close log return. NaN
 * where a price is missing or a part moves beyond ±MAX_DAILY_MOVE (an
 * unadjusted open, a bad print).
 */
export function sessionParts(bars: readonly DailyBar[], i: number): { overnight: number; intraday: number } {
  const { o, c } = bars[i];
  const prev = i > 0 ? bars[i - 1].c : NaN;
  if (!(o > 0) || !(c > 0) || !(prev > 0) || Math.abs(o / prev - 1) > MAX_DAILY_MOVE || Math.abs(c / o - 1) > MAX_DAILY_MOVE) return { overnight: NaN, intraday: NaN };
  return { overnight: Math.log(o / prev), intraday: Math.log(c / o) };
}

type SessionPart = "overnight" | "intraday";
interface PartSums {
  /** sum[i] = the part's log returns of bars 1 … i. */
  sum: Float64Array;
  /** bad[i] = sessions 1 … i that couldn't be split. */
  bad: Int32Array;
}
const partCache: Record<SessionPart, WeakMap<readonly DailyBar[], PartSums>> = { overnight: new WeakMap(), intraday: new WeakMap() };

/** Running sums of a stock's overnight or intraday log returns, cached per bar array. */
function partSums(bars: readonly DailyBar[], part: SessionPart): PartSums {
  let entry = partCache[part].get(bars);
  if (!entry) {
    const sum = new Float64Array(bars.length);
    const bad = new Int32Array(bars.length);
    for (let i = 1; i < bars.length; i += 1) {
      const r = sessionParts(bars, i)[part];
      sum[i] = sum[i - 1] + (Number.isFinite(r) ? r : 0);
      bad[i] = bad[i - 1] + (Number.isFinite(r) ? 0 : 1);
    }
    entry = { sum, bad };
    partCache[part].set(bars, entry);
  }
  return entry;
}

/** Sum of the last `lookback` sessions' overnight (or intraday) log returns at bar i; null with too little history or a session in the window that can't be split. */
export function pastPart(bars: readonly DailyBar[], i: number, lookback: number, part: SessionPart): number | null {
  if (i < lookback) return null;
  const { sum, bad } = partSums(bars, part);
  if (bad[i] !== bad[i - lookback]) return null;
  return sum[i] - sum[i - lookback];
}

/** Built-in numeric signals. Add yours here. */
export const BUILT_IN_SIGNALS: LabSignal[] = [
  {
    id: "momentum-12-1",
    name: "Momentum 12−1",
    group: "built-in",
    kind: "numeric",
    summary: "Return from 12 months ago to 1 month ago, skipping the last month (Jegadeesh–Titman; the skip avoids the 1-month reversal). High = strong past winners.",
    params: [sessions("lookback", "Look back (sessions)", 252, 42, 504), sessions("skip", "Skip latest (sessions)", 21, 0, 63)],
    build: (ctx, { lookback, skip }) => perBar(ctx, (bars, i) => (i >= lookback && skip < lookback ? bars[i - skip].c / bars[i - lookback].c - 1 : null)),
  },
  {
    id: "reversal-1m",
    name: "1-month reversal",
    group: "built-in",
    kind: "numeric",
    summary: "Minus the last month's return: high = the biggest recent losers. A positive spread means losers bounce (short-term reversal).",
    params: [sessions("lookback", "Look back (sessions)", 21, 2, 63)],
    build: (ctx, { lookback }) => perBar(ctx, (bars, i) => (i >= lookback ? -(bars[i].c / bars[i - lookback].c - 1) : null)),
  },
  {
    id: "volatility-20d",
    name: "20-day volatility",
    group: "built-in",
    kind: "numeric",
    summary: "Annualised standard deviation of daily log returns over 20 sessions. High = the most volatile; a negative spread is the low-volatility anomaly.",
    params: [sessions("window", "Window (sessions)", 20, 5, 126)],
    build: (ctx, { window }) =>
      perBar(ctx, (bars, i) => {
        if (i < window) return null;
        let sum = 0;
        let sq = 0;
        for (let j = i - window + 1; j <= i; j += 1) {
          const r = Math.log(bars[j].c / bars[j - 1].c);
          sum += r;
          sq += r * r;
        }
        const variance = (sq - (sum * sum) / window) / (window - 1);
        return Math.sqrt(Math.max(0, variance) * 252);
      }),
  },
  {
    id: "max-21d",
    name: "MAX (largest daily gain, 21 sessions)",
    group: "built-in",
    kind: "numeric",
    summary:
      "The largest one-day return of the last 21 sessions (Bali–Cakici–Whitelaw's MAX): lottery-like stocks. With top > 1, the mean of the `top` largest (MAX(5), their robustness check). A negative spread means they underperform: run it reversed to test the long side (issue #26).",
    params: [sessions("window", "Window (sessions)", 21, 5, 63), sessions("top", "Largest days averaged", 1, 1, 10)],
    build: (ctx, { window, top }) => perBar(ctx, (bars, i) => topDailyReturns(bars, i, window, top)),
  },
  {
    id: "overnight-return",
    name: "Past overnight return",
    group: "built-in",
    kind: "numeric",
    summary:
      "Sum of the last N sessions' overnight log returns (previous close → open). High = stocks that gained overnight; a positive spread on close → open forward returns is overnight momentum (Lou, Polk & Skouras 2019; issue #28).",
    params: [sessions("lookback", "Look back (sessions)", 21, 1, 252)],
    build: (ctx, { lookback }) => perBar(ctx, (bars, i) => pastPart(bars, i, lookback, "overnight")),
  },
  {
    id: "intraday-return",
    name: "Past intraday return",
    group: "built-in",
    kind: "numeric",
    summary:
      "Sum of the last N sessions' intraday log returns (open → close). High = stocks that gained in trading hours; on close → open forward returns a positive spread is intraday momentum carrying overnight, a negative one the cross-period reversal (Lou, Polk & Skouras 2019; issue #28).",
    params: [sessions("lookback", "Look back (sessions)", 21, 1, 252)],
    build: (ctx, { lookback }) => perBar(ctx, (bars, i) => pastPart(bars, i, lookback, "intraday")),
  },
];

/** A screen as a signal: its matches (1/0) or its score on a match. */
function screenSignal(screen: ScreenDef, mode: "match" | "score"): LabSignal {
  return {
    id: `${mode === "match" ? "screen" : "screen-score"}:${screen.id}`,
    name: mode === "match" ? screen.name : `${screen.name} (score)`,
    group: mode === "match" ? "screen" : "screen-score",
    kind: mode === "match" ? "binary" : "numeric",
    summary:
      mode === "match"
        ? `1 on a session the screen matched the stock, else 0: the spread is matched stocks minus the rest of the list. ${screen.summary}`
        : `The screen's score on the sessions it matched (no value otherwise): does the score rank its own matches? ${screen.summary}`,
    params: [],
    usesScan: true,
    build: async (ctx) => {
      const scan =
        ctx.scan ??
        (await scanSignals({
          symbols: [...ctx.symbols],
          getBars: (symbol) => (ctx.bars.get(symbol) ?? []) as DailyBar[],
          benchmark: ctx.benchmark as DailyBar[],
          screens: [screen],
          pause: ctx.pause,
          isMember: ctx.isMember,
        }));
      const matched = new Map<number, Map<string, number>>();
      for (const [day, signals] of scan.byDate) {
        for (const signal of signals) {
          if (signal.screenId !== screen.id) continue;
          let row = matched.get(day);
          if (!row) matched.set(day, (row = new Map()));
          row.set(signal.symbol, signal.score);
        }
      }
      return (day, symbol) => {
        // Only sessions the scan judged: enough warm-up, as the backtester requires.
        const i = scan.series.get(symbol)?.index.get(day);
        if (i === undefined || i < WARMUP_SESSIONS - 1) return null;
        const score = matched.get(day)?.get(symbol);
        return mode === "match" ? (score === undefined ? 0 : 1) : (score ?? null);
      };
    },
  };
}

export const LAB_SIGNALS: LabSignal[] = [...BUILT_IN_SIGNALS, ...MOMENTUM_SIGNALS, ...SCORE_SIGNALS, ...SCREENS.map((screen) => screenSignal(screen, "match")), ...SCREENS.map((screen) => screenSignal(screen, "score"))];

const BY_ID = new Map(LAB_SIGNALS.map((signal) => [signal.id, signal]));

export const findSignal = (id: string): LabSignal | null => BY_ID.get(id) ?? null;

/** A signal's parameters from untrusted input: unknown keys dropped, values clamped, defaults filled in. */
export function resolveParams(signal: LabSignal, raw: Record<string, unknown> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of signal.params) {
    const value = Number(raw?.[spec.key]);
    const clamped = Number.isFinite(value) ? Math.min(spec.max, Math.max(spec.min, value)) : spec.default;
    out[spec.key] = spec.integer ? Math.round(clamped) : clamped;
  }
  return out;
}

export const signalMeta = (signal: LabSignal, params: Record<string, number>): LabSignalMeta => ({ id: signal.id, name: signal.name, kind: signal.kind, params });
