import { historyGaps } from "@/core/market/longHistory";
import { istDayKey } from "@/core/market/session";
import type { DailyBar } from "@/core/types";
import type { HubCandlesBatch } from "@/server/providers/hub/client";

// Daily bars for a period reaching back before the screener's 5-year store
// (src/core/backtest/phases.ts): read from the Market Data Hub's batch candles
// for that run — NSE's archive before the broker's window, the broker's bars
// inside it, one series per company across its ticker renames
// (market-data-hub#22). Nothing is written to disk: the archive's adjusted
// prices are lined up with the broker's level at a seam that moves every day,
// so a stored copy would drift. The newest set is kept in memory, so running
// the same period again with other settings reads nothing.
//
// Each set says what it found: symbols the hub had nothing for, ranges not
// complete at the hub (the archive still downloading), series joined across a
// rename, archive stretches the hub scaled, and sessions missing inside a
// series' own span (`historyGaps`, ice-009/tradex-public#16).
//
// No server-only import: the hub is injected so it can be tested.

/** The hub's equal-weight NIFTY 50 basket: NIFTY's stand-in before NSE's index file (2012). */
export const BENCHMARK_STAND_IN = "EW-NIFTY50";

/** Symbols per hub request: 30 years × 40 stocks is ~300,000 bars, ~25 MB of JSON. */
export const LONG_BATCH_SYMBOLS = 40;

export interface LongBarDeps {
  /** GET /v1/candles/batch (daily, adjusted) for `symbols` from..to (day keys); throws when there's no hub. */
  batch(symbols: string[], from: number, to: number): Promise<HubCandlesBatch>;
  /** Called after each request with symbols done / total. */
  progress?: (done: number, total: number) => void;
}

export interface LongBarSet {
  from: number;
  to: number;
  bars: Map<string, DailyBar[]>;
  /** Symbols the hub had no bars for in the range (unknown, or not listed then). */
  missing: string[];
  /** Symbols whose range isn't complete at the hub (its archive may still be downloading). */
  incomplete: string[];
  /** Symbols read across a ticker rename: symbol → its names, oldest first. */
  renamed: Map<string, string[]>;
  /** Symbols whose archive stretch the hub lined up with the broker's level: symbol → scale. */
  scaled: Map<string, number>;
  /** Sessions (of the union of every series') missing inside a series' own span. */
  gaps: Map<string, number[]>;
}

/** What a long run read, for its warnings. */
export interface LongNotes {
  /** First and last day read (day keys; `from` includes the warm-up). */
  from: number;
  to: number;
  set: LongBarSet;
  /** Last session the benchmark came from NIFTY's stand-in (null: none). */
  standInUntil: number | null;
}

const isoDay = (day: number) => new Date(day).toISOString().slice(0, 10);
const list = (items: string[]) => `${items.slice(0, 5).join(", ")}${items.length > 5 ? "…" : ""}`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A long run's warnings: where its bars came from and what is missing. Pure. */
export function longWarnings(notes: LongNotes, scanned: number): string[] {
  const { set } = notes;
  const out = [`Long period: ${plural(scanned, "stock")}' daily history from ${isoDay(notes.from)} (with warm-up) to ${isoDay(notes.to)} was read from the Market Data Hub for this run — NSE's archive before the broker's 5 years, adjusted for splits and bonuses.`];
  if (notes.standInUntil !== null) out.push(`NIFTY's history up to ${isoDay(notes.standInUntil)} isn't in NSE's index file: the market state and relative strength use the hub's equal-weight NIFTY 50 basket there — a stand-in built from today's members (survivorship bias).`);
  const renamed = [...set.renamed].map(([symbol, names]) => `${names.join(" → ")}${names.at(-1) === symbol ? "" : ` (as ${symbol})`}`);
  if (renamed.length) out.push(`${plural(renamed.length, "stock")} joined across ticker renames: ${list(renamed)}.`);
  if (set.incomplete.length) out.push(`The hub doesn't hold this whole period for ${plural(set.incomplete.length, "symbol")} (${list(set.incomplete)}): its NSE archive may still be downloading.`);
  if (set.gaps.size) out.push(`${plural(set.gaps.size, "stock")} with sessions missing inside their history (${list([...set.gaps].map(([symbol, days]) => `${symbol} ${days.length}`))}): suspensions, or a gap at the hub.`);
  return out;
}

const toBars = (answer: HubCandlesBatch, symbol: string): DailyBar[] =>
  (answer.series[symbol]?.candles ?? [])
    .map((candle) => ({ t: istDayKey(candle.t), o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v, dp: candle.dp ?? undefined }))
    .filter((bar) => bar.o > 0 && bar.c > 0)
    .sort((a, b) => a.t - b.t);

export class LongBars {
  private last: { key: string; set: Promise<LongBarSet> } | null = null;

  constructor(private readonly deps: LongBarDeps) {}

  /** Daily bars of `symbols` from..to (day keys); the same request again is answered from memory. */
  load(symbols: string[], from: number, to: number): Promise<LongBarSet> {
    const unique = [...new Set(symbols)].sort();
    const key = `${from}:${to}:${unique.join(",")}`;
    if (this.last?.key === key) return this.last.set;
    const set = this.read(unique, from, to);
    this.last = { key, set };
    set.catch(() => {
      if (this.last?.key === key) this.last = null;
    });
    return set;
  }

  private async read(symbols: string[], from: number, to: number): Promise<LongBarSet> {
    const set: LongBarSet = { from, to, bars: new Map(), missing: [], incomplete: [], renamed: new Map(), scaled: new Map(), gaps: new Map() };
    for (let start = 0; start < symbols.length; start += LONG_BATCH_SYMBOLS) {
      const part = symbols.slice(start, start + LONG_BATCH_SYMBOLS);
      const answer = await this.deps.batch(part, from, to);
      for (const symbol of part) {
        const series = answer.series[symbol];
        const bars = toBars(answer, symbol);
        if (!bars.length) {
          set.missing.push(symbol);
          continue;
        }
        set.bars.set(symbol, bars);
        if (!series?.complete || answer.queued.includes(symbol)) set.incomplete.push(symbol);
        for (const span of series?.sources ?? []) {
          if ((span.names?.length ?? 0) > 1) set.renamed.set(symbol, span.names!);
          if (span.scale !== undefined && span.scale !== 1) set.scaled.set(symbol, span.scale);
        }
      }
      this.deps.progress?.(Math.min(symbols.length, start + LONG_BATCH_SYMBOLS), symbols.length);
    }
    const calendar = new Set<number>();
    for (const bars of set.bars.values()) for (const bar of bars) calendar.add(bar.t);
    for (const [symbol, bars] of set.bars) {
      const gaps = historyGaps(bars, calendar);
      if (gaps.length) set.gaps.set(symbol, gaps);
    }
    return set;
  }
}
