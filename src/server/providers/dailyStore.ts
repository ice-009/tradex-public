import "server-only";

import { DAY_MS, isWeekday, istDayKey, istParts } from "@/core/market/session";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SESSION_CLOSE_MIN } from "@/core/market/session";
import { sweepIntervalMs } from "@/core/ratelimit/budget";
import { asPriority, budgetFor, planLimits } from "@/server/providers/marketBudget";
import { dataEngine, marketStream } from "@/server/data";
import { hubClient, type HubClient } from "@/server/providers/hub";
import { mergeDailyBars } from "@/core/market/history";
import { parseBhav, type BhavRow } from "@/core/parsers/bhavcopy";
import type { DailyBar } from "@/core/types";

export type { DailyBar };

// Disk-backed daily bars for the screener.
//
// Fyers Standard allows 50 data calls a minute and 5,000 a day, so re-downloading a year of history for
// 500 stocks on every scan is out of the question. Instead:
//   1. Backfill each symbol ONCE from Fyers (one ≤360-day request).
//   2. Extend every symbol forward from NSE's daily bhavcopy
//      (sec_bhavdata_full_DDMMYYYY.csv) — one file covers the whole market and
//      also carries delivery % (DELIV_PER), which Fyers doesn't provide.
//   3. Detect corporate actions: NSE publishes PREV_CLOSE adjusted on ex-dates,
//      so a mismatch with our stored close means split/bonus → re-backfill.
//   4. During/after market hours, overlay today's bar from Fyers batch quotes
//      (50 symbols per request) until that day's bhavcopy is published (~6 PM).
//
// With a Market Data Hub (HUB_URL), steps 1–3 are the hub's job: it keeps every
// symbol's daily bars, extended from the bhavcopy each evening with delivery %
// and re-downloaded after a split. The store then only asks the hub for each
// symbol's newest bars (`syncFromHub`) — no NSE downloads, no broker calls.

export interface SyncProgress {
  phase: "idle" | "nse" | "history" | "done" | "error";
  done: number;
  total: number;
  message: string;
  finishedAt: number | null;
}

const CACHE_DIR = path.join(process.cwd(), ".cache", "screener");
const DAILY_DIR = path.join(CACHE_DIR, "daily");
const BHAV_DIR = path.join(CACHE_DIR, "bhav");
/** First download per symbol: one ≤ 360-day request, so a new universe is ready in minutes. */
const BACKFILL_DAYS = 360;
/** How far back the market-data database can extend the screener's daily history (5 years). */
const DEEP_HISTORY_DAYS = 5 * 365 - 3;
const BHAV_LOOKBACK_DAYS = 45; // ≥ 25 sessions for a 20-day delivery average
const STALE_AFTER_MS = 15 * 60 * 1000;
// Every history call is background priority in the request budget, so on Fyers
// Standard (50/min, 5,000/day) a first-time backfill runs at ~20 calls a minute
// (≈11 minutes for the F&O list) and charts still load meanwhile.
const FYERS_CONCURRENCY = 2;
const BACKFILL_ATTEMPTS = 4;
const SPLIT_TOLERANCE = 0.015;
/** Parallel requests to the hub (it allows a key ~10 a second). */
const HUB_CONCURRENCY = 3;
/** Each hub update re-reads this many days before the last stored bar, so corrected bars and delivery % replace provisional ones. */
const HUB_OVERLAP_DAYS = 7;
/** Fastest the screener's live quotes refresh, however much budget is left. */
const MIN_LIVE_PACE_MS = 15 * 1000;

/**
 * How often to refresh live quotes for `count` symbols so that, at "refresh"
 * priority, the budget lasts until the close (≈ 1 min for the F&O list on Fyers
 * Standard, the 15 s floor on Prime). Ticks fill in between.
 */
function livePaceMs(count: number, minutes: number): number {
  const refresh = budgetFor("refresh");
  const interval = sweepIntervalMs({
    requestsPerSweep: Math.ceil(count / planLimits().limits.quoteBatch),
    remainingToday: refresh.remainingToday,
    minutesLeft: Math.max(1, SESSION_CLOSE_MIN - minutes),
    backgroundPerMinute: refresh.perMinute,
    shareOfBackground: 0.4,
    minMs: MIN_LIVE_PACE_MS,
  });
  return interval ?? 10 * 60 * 1000; // budget spent: every 10 minutes, ticks in between
}
const NSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  Accept: "text/csv,*/*",
};

/** Index symbols aren't in the bhavcopy; they refresh straight from Fyers. */
const FYERS_ONLY = new Set(["NIFTY", "BANKNIFTY"]);

function istNow() {
  const { day, minutes } = istParts();
  return { dayKey: day, minutes };
}

/** Fyers stamps daily candles at UTC midnight; normalise anything else onto the IST date. */
const toDayKey = istDayKey;

function bhavFileName(dayKey: number) {
  const date = new Date(dayKey);
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}${mm}${date.getUTCFullYear()}`;
}

function symbolFile(symbol: string) {
  return path.join(DAILY_DIR, `${encodeURIComponent(symbol)}.json`);
}

class ScreenerStore {
  private readonly bars = new Map<string, DailyBar[]>();
  private readonly bhav = new Map<number, Record<string, BhavRow> | null>(); // null = holiday
  /** In-flight or finished disk reads, so concurrent callers all wait for the same read. */
  private readonly diskLoads = new Map<string, Promise<void>>();
  private readonly quoteCache = new Map<string, { at: number; bars: Map<string, DailyBar> }>();
  private syncing: Promise<void> | null = null;
  private syncedSymbols = new Set<string>();
  private lastSyncAt = 0;
  progress: SyncProgress = { phase: "idle", done: 0, total: 0, message: "", finishedAt: null };

  getBars(symbol: string): DailyBar[] {
    return this.bars.get(symbol) ?? [];
  }

  isSyncing() {
    return this.syncing !== null;
  }

  /** True when every symbol has history in memory/disk (possibly a little stale). */
  async hasData(symbols: string[]) {
    await Promise.all(symbols.map((symbol) => this.loadFromDisk(symbol)));
    return symbols.every((symbol) => (this.bars.get(symbol)?.length ?? 0) > 0);
  }

  /**
   * Kick off a sync when needed. Returns immediately; poll `progress`.
   * Stale-but-present data stays usable while the refresh runs.
   */
  ensureFresh(symbols: string[]) {
    if (this.syncing) return;
    const unseen = symbols.some((symbol) => !this.syncedSymbols.has(symbol));
    if (!unseen && Date.now() - this.lastSyncAt < STALE_AFTER_MS) return;
    // Backfill and bhavcopy sync are background work: they never crowd out a chart.
    this.syncing = asPriority("background", () => this.sync(symbols))
      .catch((error: Error) => {
        console.error("Screener sync failed", error);
        this.progress = { ...this.progress, phase: "error", message: error.message, finishedAt: Date.now() };
      })
      .finally(() => {
        this.syncing = null;
      });
  }

  // ---------------------------------------------------------------- sync

  private async sync(symbols: string[]) {
    const hub = hubClient();
    if (hub) return this.syncFromHub(hub, symbols);
    // Screener history must be real broker data (never sample, and EOD is what we're building).
    const engine = dataEngine();
    const brokers = engine.sources.filter((source) => source.kind === "broker" && source.history);
    const reasons = await Promise.all(brokers.map((source) => engine.unavailable(source)));
    if (!brokers.length || reasons.every(Boolean)) {
      throw new Error(`No broker is connected, so the screener has no data source${reasons.length ? ` (${reasons.filter(Boolean).join("; ")})` : ""}.`);
    }

    await mkdir(DAILY_DIR, { recursive: true });
    await mkdir(BHAV_DIR, { recursive: true });
    await Promise.all(symbols.map((symbol) => this.loadFromDisk(symbol)));
    // Older daily history already in the market-data database (from "Download F&O history"):
    // free to use, no API calls.
    const extended = await this.extendFromDatabase(symbols);

    const bhavDays = await this.loadRecentBhav();
    const latestBhavDay = bhavDays[bhavDays.length - 1] ?? 0;
    const { dayKey: today } = istNow();

    // Symbols that need a (re)download from Fyers: no history yet, index
    // symbols that bhav can't extend, or anything bhav couldn't bring up to date.
    const needsBackfill = (symbol: string) => {
      const series = this.bars.get(symbol);
      if (!series?.length) return true;
      const last = series[series.length - 1].t;
      if (FYERS_ONLY.has(symbol)) return last < (latestBhavDay || today - DAY_MS);
      return false;
    };

    let pending = symbols.filter(needsBackfill);
    const dirty = new Set<string>(extended);
    for (let pass = 0; pass < 2; pass += 1) {
      if (pending.length) {
        // Pass 0 (new symbols) may use what the database already holds; pass 1 (adjusted for a split) must re-download.
        await this.backfill(pending, pass === 0 ? "Downloading daily history" : "Re-downloading adjusted history", pass > 0);
        pending.forEach((symbol) => dirty.add(symbol));
      }
      const broken = this.applyBhav(symbols, bhavDays, dirty);
      // After bhav, anything still behind the latest session (series change,
      // suspension, split) gets one fresh Fyers download.
      const behind = symbols.filter((symbol) => {
        if (FYERS_ONLY.has(symbol) || broken.has(symbol)) return false;
        const series = this.bars.get(symbol);
        return Boolean(latestBhavDay && series?.length && series[series.length - 1].t < latestBhavDay && pass === 0);
      });
      pending = [...new Set([...broken, ...behind])];
      if (!pending.length) break;
    }

    this.progress = { phase: "history", done: 0, total: dirty.size, message: "Saving", finishedAt: null };
    await Promise.all([...dirty].map((symbol) => this.saveToDisk(symbol)));

    // Symbols that still have no history are retried on the next request instead of in 15 minutes.
    symbols.filter((symbol) => this.bars.get(symbol)?.length).forEach((symbol) => this.syncedSymbols.add(symbol));
    this.lastSyncAt = Date.now();
    this.progress = {
      phase: "done",
      done: symbols.length,
      total: symbols.length,
      message: latestBhavDay ? `EOD data through ${new Date(latestBhavDay).toISOString().slice(0, 10)}` : "Up to date",
      finishedAt: Date.now(),
    };
  }

  /** Bring every symbol up to date from the Market Data Hub (see the file comment). */
  private async syncFromHub(hub: HubClient, symbols: string[]) {
    await mkdir(DAILY_DIR, { recursive: true });
    await Promise.all(symbols.map((symbol) => this.loadFromDisk(symbol)));
    const dirty = new Set<string>(await this.extendFromDatabase(symbols));
    const { dayKey: today, minutes } = istNow();
    // Today's daily candle is still forming until well after the 15:30 close.
    const storeToday = minutes >= 16 * 60;
    const failed: string[] = [];
    let partial = 0;
    let done = 0;
    this.progress = { phase: "history", done, total: symbols.length, message: "Updating daily bars from the Market Data Hub", finishedAt: null };

    const queue = [...symbols];
    const worker = async () => {
      for (let symbol = queue.shift(); symbol; symbol = queue.shift()) {
        try {
          const result = await this.updateFromHub(hub, symbol, today, storeToday);
          if (result.changed) dirty.add(symbol);
          if (result.partial) partial += 1;
        } catch (error) {
          failed.push(symbol);
          console.warn(`Screener: daily bars for ${symbol} from the Market Data Hub failed:`, (error as Error).message);
        }
        done += 1;
        this.progress = { ...this.progress, done };
      }
    };
    await Promise.all(Array.from({ length: HUB_CONCURRENCY }, worker));

    this.progress = { phase: "history", done: 0, total: dirty.size, message: "Saving", finishedAt: null };
    await Promise.all([...dirty].map((symbol) => this.saveToDisk(symbol)));
    symbols.filter((symbol) => this.bars.get(symbol)?.length).forEach((symbol) => this.syncedSymbols.add(symbol));
    this.lastSyncAt = Date.now();
    const last = Math.max(0, ...symbols.map((symbol) => this.bars.get(symbol)?.at(-1)?.t ?? 0));
    const notes = [failed.length ? `${failed.length} failed` : "", partial ? `${partial} incomplete (hub's broker unavailable)` : ""].filter(Boolean).join(", ");
    this.progress = {
      phase: "done",
      done: symbols.length,
      total: symbols.length,
      message: `${last ? `Daily bars through ${new Date(last).toISOString().slice(0, 10)}` : "Up to date"} (Market Data Hub)${notes ? ` · ${notes}` : ""}`,
      finishedAt: Date.now(),
    };
  }

  /**
   * One symbol's newest daily bars from the hub, merged by session. When a bar we
   * already hold comes back with a different close (a split or bonus: the hub
   * re-downloads adjusted history), the whole series is replaced.
   */
  private async updateFromHub(hub: HubClient, symbol: string, today: number, storeToday: boolean): Promise<{ changed: boolean; partial: boolean }> {
    const read = async (from: number) => {
      const answer = await hub.candles(symbol, "1d", from);
      const bars: DailyBar[] = answer.candles
        .map((candle) => ({ t: toDayKey(candle.t), o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v, dp: candle.dp ?? undefined }))
        .filter((bar) => (storeToday || bar.t < today) && bar.o > 0 && bar.c > 0);
      return { bars, partial: Boolean(answer.partial) };
    };
    const series = this.bars.get(symbol) ?? [];
    if (!series.length) {
      const { bars, partial } = await read(today - BACKFILL_DAYS * DAY_MS);
      if (bars.length) this.bars.set(symbol, bars);
      return { changed: bars.length > 0, partial };
    }

    const { bars: tail, partial } = await read(series[series.length - 1].t - HUB_OVERLAP_DAYS * DAY_MS);
    const merged = mergeDailyBars(series, tail, SPLIT_TOLERANCE);
    if (merged) {
      if (merged.changed) this.bars.set(symbol, merged.bars);
      return { changed: merged.changed, partial };
    }
    // A stored close moved: the hub has re-downloaded adjusted history (split, bonus).
    const fresh = await read(series[0].t);
    if (!fresh.bars.length) return { changed: false, partial: fresh.partial };
    this.bars.set(symbol, fresh.bars);
    return { changed: true, partial: fresh.partial };
  }

  /**
   * Prepend older daily bars from the market-data database to series that start
   * later than it covers (never downloads). Returns the symbols that grew.
   */
  private async extendFromDatabase(symbols: string[]): Promise<string[]> {
    const { dayKey: today } = istNow();
    const target = today - DEEP_HISTORY_DAYS * DAY_MS;
    const grew: string[] = [];
    for (const symbol of symbols) {
      const series = this.bars.get(symbol);
      if (!series?.length || series[0].t <= target + 30 * DAY_MS) continue;
      const answer = await dataEngine().history({ symbol, interval: "1d", from: target, kinds: ["broker"], offline: true });
      const older = answer.candles
        .map((point) => ({ t: toDayKey(point.date), o: point.open, h: point.high, l: point.low, c: point.close, v: point.volume }))
        .filter((bar) => bar.t < series[0].t);
      if (!older.length) continue;
      this.bars.set(symbol, [...older, ...series]);
      grew.push(symbol);
    }
    return grew;
  }

  private async backfill(symbols: string[], label: string, reload: boolean) {
    const { dayKey: today, minutes } = istNow();
    // Today's daily candle is still forming until well after the 15:30 close.
    const storeToday = minutes >= 16 * 60;
    const from = today - BACKFILL_DAYS * DAY_MS;
    let done = 0;
    this.progress = { phase: "history", done, total: symbols.length, message: label, finishedAt: null };

    const queue = [...symbols];
    const worker = async () => {
      for (let symbol = queue.shift(); symbol; symbol = queue.shift()) {
        for (let attempt = 1; attempt <= BACKFILL_ATTEMPTS; attempt += 1) {
          try {
            // Broker only. `reload` (after a split) forces a full download; otherwise
            // history already in the market-data database is used.
            const answer = await dataEngine().history({ symbol, interval: "1d", from, kinds: ["broker"], reload });
            if (!answer.source) throw new Error(answer.skipped.join("; ") || "no broker data");
            const series = answer.candles
              .map((point) => ({ t: toDayKey(point.date), o: point.open, h: point.high, l: point.low, c: point.close, v: point.volume }))
              .filter((bar) => storeToday || bar.t < today);
            if (series.length) this.bars.set(symbol, series);
            break;
          } catch (error) {
            const message = (error as Error).message;
            if (attempt === BACKFILL_ATTEMPTS || !message.includes("429")) {
              console.warn(`Screener backfill failed for ${symbol}:`, message);
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
          }
        }
        done += 1;
        this.progress = { ...this.progress, done };
      }
    };
    await Promise.all(Array.from({ length: FYERS_CONCURRENCY }, worker));
  }

  /** Append bhav sessions after each symbol's last bar and fill delivery %. Returns symbols needing re-backfill. */
  private applyBhav(symbols: string[], bhavDays: number[], dirty: Set<string>) {
    const broken = new Set<string>();
    for (const symbol of symbols) {
      if (FYERS_ONLY.has(symbol)) continue;
      const series = this.bars.get(symbol);
      if (!series?.length) continue;
      const byTime = new Map(series.map((bar, index) => [bar.t, index]));

      for (const day of bhavDays) {
        const row = this.bhav.get(day)?.[symbol];
        if (!row) continue;
        const existing = byTime.get(day);
        if (existing !== undefined) {
          if (row.deliveryPct !== null && series[existing].dp !== row.deliveryPct) {
            series[existing].dp = row.deliveryPct;
            dirty.add(symbol);
          }
          continue;
        }
        const last = series[series.length - 1];
        if (day < last.t) continue;
        if (Math.abs(row.prevClose - last.c) / last.c > SPLIT_TOLERANCE) {
          // NSE's PREV_CLOSE is adjusted on ex-dates: our history predates a corporate action.
          broken.add(symbol);
          break;
        }
        series.push({ t: day, o: row.open, h: row.high, l: row.low, c: row.close, v: row.volume, dp: row.deliveryPct ?? undefined });
        byTime.set(day, series.length - 1);
        dirty.add(symbol);
      }
    }
    return broken;
  }

  private async loadRecentBhav(): Promise<number[]> {
    const { dayKey: today, minutes } = istNow();
    const days: number[] = [];
    for (let day = today - BHAV_LOOKBACK_DAYS * DAY_MS; day <= today; day += DAY_MS) {
      if (isWeekday(day)) days.push(day);
    }
    const missing = days.filter((day) => !this.bhav.has(day));
    this.progress = { phase: "nse", done: 0, total: missing.length, message: "Fetching NSE bhavcopy (EOD + delivery %)", finishedAt: null };

    let done = 0;
    for (const day of missing) {
      // Today's file appears in the evening; don't even ask before 17:30 IST.
      if (day === today && minutes < 17 * 60 + 30) {
        done += 1;
        continue;
      }
      await this.loadBhavDay(day, day === today);
      done += 1;
      this.progress = { ...this.progress, done };
    }
    return days.filter((day) => this.bhav.get(day));
  }

  private async loadBhavDay(day: number, isToday: boolean) {
    const file = path.join(BHAV_DIR, `${bhavFileName(day)}.json`);
    try {
      const cached = JSON.parse(await readFile(file, "utf8")) as Record<string, BhavRow> | null;
      this.bhav.set(day, cached);
      return;
    } catch {
      // not cached yet
    }

    try {
      const response = await fetch(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${bhavFileName(day)}.csv`, {
        headers: NSE_HEADERS,
        cache: "no-store",
      });
      if (response.status === 404) {
        // Holiday (or not yet published, for today — don't remember that).
        if (!isToday) {
          this.bhav.set(day, null);
          await writeFile(file, "null");
        }
        return;
      }
      if (!response.ok) throw new Error(`NSE bhavcopy ${response.status}`);
      const rows = parseBhav(await response.text());
      this.bhav.set(day, rows);
      await writeFile(file, JSON.stringify(rows));
      await new Promise((resolve) => setTimeout(resolve, 250)); // be polite to nsearchives
    } catch (error) {
      console.warn(`NSE bhavcopy ${bhavFileName(day)} unavailable:`, (error as Error).message);
    }
  }

  private loadFromDisk(symbol: string): Promise<void> {
    if (this.bars.has(symbol)) return Promise.resolve();
    let pending = this.diskLoads.get(symbol);
    if (!pending) {
      pending = (async () => {
        try {
          const rows = JSON.parse(await readFile(symbolFile(symbol), "utf8")) as Array<[number, number, number, number, number, number, number | null]>;
          if (this.bars.has(symbol)) return; // a backfill landed first
          this.bars.set(
            symbol,
            rows.map(([t, o, h, l, c, v, dp]) => ({ t, o, h, l, c, v, dp: dp ?? undefined })),
          );
        } catch {
          // no cache yet
        }
      })();
      this.diskLoads.set(symbol, pending);
    }
    return pending;
  }

  private async saveToDisk(symbol: string) {
    const series = this.bars.get(symbol);
    if (!series) return;
    const rows = series.map((bar) => [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v, bar.dp ?? null]);
    await writeFile(symbolFile(symbol), JSON.stringify(rows));
  }

  // ---------------------------------------------------------------- live overlay

  /**
   * Today's forming bar per symbol, for symbols whose stored history doesn't
   * include today yet. Empty outside trading days/hours.
   *
   * Two layers, so screens can change during the day instead of sticking to the
   * morning's picture:
   *   1. Broker quotes for all of them, refreshed at a pace the API budget can
   *      keep up for the rest of the session (≈ 1 min on Fyers Standard,
   *      ≈ 15 s on Prime) — charged as "refresh", not background, so background
   *      work (history downloads) can't starve it.
   *   2. On top, any newer live tick from the market stream (charts, watchlist,
   *      visible screener rows) — instant and free.
   */
  async liveSnapshot(symbols: string[]): Promise<{ bars: Map<string, DailyBar>; quotesAt: number | null; paceMs: number | null; fromTicks: number }> {
    const { dayKey: today, minutes } = istNow();
    const empty = { bars: new Map<string, DailyBar>(), quotesAt: null, paceMs: null, fromTicks: 0 };
    if (!isWeekday(today) || minutes < 9 * 60 + 15) return empty;
    const wanted = symbols.filter((symbol) => {
      const series = this.bars.get(symbol);
      return series?.length && series[series.length - 1].t < today;
    });
    if (!wanted.length) return empty;

    const paceMs = livePaceMs(wanted.length, minutes);
    const key = wanted.join(",");
    let cached = this.quoteCache.get(key);
    if (!cached || Date.now() - cached.at >= paceMs) {
      // Live broker quotes only: an end-of-day close is already the last stored bar.
      const fetchedAt = Date.now();
      const quotes = await asPriority("refresh", () => dataEngine().quotes(wanted, { maxAgeMs: paceMs, kinds: ["broker"] }));
      const bars = new Map<string, DailyBar>();
      for (const quote of quotes) {
        const bar = this.todayBar(quote.symbol, today, quote);
        if (bar) bars.set(quote.symbol, bar);
      }
      // Keep the last good snapshot when this round got nothing (budget pause, broker hiccup).
      if (bars.size || !cached) cached = { at: bars.size ? fetchedAt : (cached?.at ?? 0), bars };
      this.quoteCache.set(key, cached);
    }

    // Newer ticks win: they're what the chart and watchlist already show.
    const bars = new Map(cached.bars);
    let fromTicks = 0;
    for (const tick of marketStream().getLatest(wanted)) {
      if (tick.ts < cached.at) continue;
      const bar = this.todayBar(tick.symbol, today, { open: tick.open, high: tick.high, low: tick.low, ltp: tick.ltp, volume: tick.volume });
      if (bar) {
        bars.set(tick.symbol, bar);
        fromTicks += 1;
      }
    }
    return { bars, quotesAt: cached.at || null, paceMs, fromTicks };
  }

  async getLiveBars(symbols: string[]): Promise<Map<string, DailyBar>> {
    return (await this.liveSnapshot(symbols)).bars;
  }

  /** Today's bar from a quote or tick; null when unusable or when it's really the previous session (exchange holiday). */
  private todayBar(symbol: string, today: number, quote: { open: number; high: number; low: number; ltp: number; volume: number }): DailyBar | null {
    if (!quote.ltp || !quote.open || !quote.high || !quote.low) return null;
    const series = this.bars.get(symbol);
    const last = series?.[series.length - 1];
    if (last && quote.open === last.o && quote.high === last.h && quote.low === last.l) return null;
    return { t: today, o: quote.open, h: quote.high, l: quote.low, c: quote.ltp, v: quote.volume };
  }
}

// Singleton across requests. Unlike fyersStream, a hot reload that changes this
// class replaces the instance (state is cheap to rebuild from the disk cache).
const globalForScreener = globalThis as unknown as { screenerStore?: ScreenerStore };
if (!(globalForScreener.screenerStore instanceof ScreenerStore)) globalForScreener.screenerStore = new ScreenerStore();
export const screenerStore: ScreenerStore = globalForScreener.screenerStore;
