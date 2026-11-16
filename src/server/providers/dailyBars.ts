import { mergeDailyBars } from "@/core/market/history";
import { DAY_MS, istDayKey, istParts } from "@/core/market/session";
import type { DailyBar } from "@/core/types";
import type { HubCandlesBatch } from "@/server/providers/hub/client";

// Daily bars for the screener, backtests and the plan's evidence, filled from
// the Market Data Hub's GET /v1/candles/batch — one request for a whole
// universe (300 symbols per request), up to 5 years back, with NSE delivery %.
//
//  - First read of a symbol: its full 5 years. Later: only the last week (the
//    overlap replaces provisional bars with final ones and fills delivery %).
//  - A stored close that moved (a split or bonus: the hub re-downloads adjusted
//    history) triggers a full re-read of that symbol.
//  - Symbols the hub doesn't hold in full yet come back in `queued`: it fetches
//    them in the background. What it has is used meanwhile (not saved to disk),
//    progress says "the hub is downloading N symbols", and the store asks again
//    in 30 seconds.
//  - Kept in memory and on disk (one file per symbol with the range it covers),
//    so a restart reads the hub only for what's new.
//
// No server-only import: the hub and the disk are injected so it can be tested.

/** How far back the store keeps daily bars (the hub serves ~5 years). */
export const DEEP_HISTORY_DAYS = 5 * 365 - 3;
/** Each update re-reads this many days before the last stored bar. */
const OVERLAP_DAYS = 7;
/** A series starting later than the 5-year target by more than this is read in full once (older, shorter caches). */
const COVERAGE_SLACK_DAYS = 30;
const SPLIT_TOLERANCE = 0.015;
/** Re-sync after this long even when nothing new was asked for. */
const STALE_AFTER_MS = 15 * 60 * 1000;
/** While the hub is downloading symbols (or after an error), ask again this soon. */
export const RETRY_AFTER_MS = 30 * 1000;

export interface SyncProgress {
  phase: "idle" | "history" | "done" | "error";
  done: number;
  total: number;
  message: string;
  finishedAt: number | null;
  /** Symbols the hub is still downloading (asked again shortly). */
  queued: number;
}

export interface StoredSeries {
  /** Oldest day the stored bars are complete from (null: unknown, e.g. an older cache file). */
  coveredFrom: number | null;
  bars: DailyBar[];
}

export interface DailyBarDeps {
  /** GET /v1/candles/batch for `symbols` from `from`; throws when there's no hub or it can't answer. */
  batch(symbols: string[], from: number): Promise<HubCandlesBatch>;
  read(symbol: string): Promise<StoredSeries | null>;
  write(symbol: string, series: StoredSeries): Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export class DailyBarStore {
  private readonly bars = new Map<string, DailyBar[]>();
  private readonly coveredFrom = new Map<string, number | null>();
  /** In-flight or finished disk reads, so concurrent callers wait for the same read. */
  private readonly diskLoads = new Map<string, Promise<void>>();
  /** Symbols to read in full next time (incomplete at the hub, or adjusted). */
  private readonly incomplete = new Set<string>();
  /** Symbols a sync has asked the hub for. */
  private readonly seen = new Set<string>();
  private queued = new Set<string>();
  private unknown = new Set<string>();
  private syncing: Promise<void> | null = null;
  private lastSyncAt = 0;
  private retryAt = 0;
  progress: SyncProgress = { phase: "idle", done: 0, total: 0, message: "", finishedAt: null, queued: 0 };

  constructor(protected readonly deps: DailyBarDeps) {}

  protected now() {
    return this.deps.now?.() ?? Date.now();
  }

  getBars(symbol: string): DailyBar[] {
    return this.bars.get(symbol) ?? [];
  }

  isSyncing() {
    return this.syncing !== null;
  }

  /** Symbols the hub is still downloading. */
  queuedSymbols(): string[] {
    return [...this.queued];
  }

  /** Symbols the hub doesn't know. */
  unknownSymbols(): string[] {
    return [...this.unknown];
  }

  /** True when every symbol has bars in memory or on disk (possibly a little stale). Never asks the hub. */
  async hasData(symbols: string[]) {
    await Promise.all(symbols.map((symbol) => this.loadFromDisk(symbol)));
    return symbols.every((symbol) => (this.bars.get(symbol)?.length ?? 0) > 0);
  }

  /**
   * Start a sync in the background when needed (symbols not asked for yet, data
   * older than 15 minutes, or a retry due); returns at once. Poll `progress`.
   */
  ensureFresh(symbols: string[]) {
    if (this.syncing) return;
    const now = this.now();
    const unseen = symbols.some((symbol) => !this.seen.has(symbol));
    const due = now - this.lastSyncAt >= STALE_AFTER_MS || (this.retryAt > 0 && now >= this.retryAt);
    if (!unseen && !due) return;
    void this.sync(symbols);
  }

  /** Bring `symbols` up to date from the hub (shared when one is already running). */
  sync(symbols: string[]): Promise<void> {
    this.syncing ??= this.run(symbols)
      .catch((error: Error) => {
        this.retryAt = this.now() + RETRY_AFTER_MS;
        this.progress = { ...this.progress, phase: "error", message: error.message, finishedAt: this.now() };
        this.deps.log?.(`Daily bars from the Market Data Hub failed: ${error.message}`);
      })
      .finally(() => {
        this.syncing = null;
      });
    return this.syncing;
  }

  private async run(symbols: string[]) {
    const unique = [...new Set(symbols)];
    await Promise.all(unique.map((symbol) => this.loadFromDisk(symbol)));
    unique.forEach((symbol) => this.seen.add(symbol));
    const { day: today, minutes } = istParts(this.now());
    // Today's daily bar is still forming until well after the 15:30 close; the live overlay covers it.
    const storeToday = minutes >= 16 * 60;
    const target = today - DEEP_HISTORY_DAYS * DAY_MS;
    const full = unique.filter((symbol) => this.needsFull(symbol, target));
    const tail = unique.filter((symbol) => !full.includes(symbol));
    this.progress = { phase: "history", done: 0, total: unique.length, message: "Reading daily bars from the Market Data Hub", finishedAt: null, queued: this.queued.size };

    const queued = new Set<string>();
    const unknown = new Set<string>();
    const dirty = new Set<string>();
    const hub = { warning: null as string | null };
    const note = (answer: HubCandlesBatch) => {
      answer.queued.forEach((symbol) => queued.add(symbol));
      answer.unknown.forEach((symbol) => unknown.add(symbol));
      // The hub's broker can't be used: nothing missing gets queued, so ask again later.
      if (answer.warning) hub.warning = answer.warning;
    };
    const toBars = (answer: HubCandlesBatch, symbol: string) =>
      (answer.series[symbol]?.candles ?? [])
        .map((candle) => ({ t: istDayKey(candle.t), o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v, dp: candle.dp ?? undefined }))
        .filter((bar) => (storeToday || bar.t < today) && bar.o > 0 && bar.c > 0)
        .sort((a, b) => a.t - b.t);
    /** Replace whole series from a full read; only a complete one counts as covering the 5 years. */
    const replace = (answer: HubCandlesBatch, names: string[]) => {
      for (const symbol of names) {
        const bars = toBars(answer, symbol);
        const series = answer.series[symbol];
        // Complete, or (16:00–18:00 IST) only today's bar missing until NSE's evening file: not queued,
        // and the stored range reaches back to the target. Either way the 5 years are held.
        const complete = Boolean(series) && !answer.queued.includes(symbol) && (series.complete || Boolean(series.coverage && series.coverage.from <= target + COVERAGE_SLACK_DAYS * DAY_MS));
        // A partial answer (still downloading) never replaces a longer series already held.
        if (bars.length && (complete || bars.length >= this.getBars(symbol).length)) this.bars.set(symbol, bars);
        if (complete && bars.length) {
          this.incomplete.delete(symbol);
          this.coveredFrom.set(symbol, target);
          dirty.add(symbol);
        } else if (!answer.unknown.includes(symbol)) {
          this.incomplete.add(symbol);
        }
      }
    };

    if (full.length) {
      const answer = await this.deps.batch(full, target);
      note(answer);
      replace(answer, full);
      this.progress = { ...this.progress, done: full.length };
    }

    if (tail.length) {
      const from = Math.min(...tail.map((symbol) => this.bars.get(symbol)!.at(-1)!.t)) - OVERLAP_DAYS * DAY_MS;
      const answer = await this.deps.batch(tail, from);
      note(answer);
      const adjusted: string[] = [];
      for (const symbol of tail) {
        const fresh = toBars(answer, symbol);
        const merged = mergeDailyBars(this.getBars(symbol), fresh, SPLIT_TOLERANCE);
        if (!merged) adjusted.push(symbol);
        else if (merged.changed) {
          this.bars.set(symbol, merged.bars);
          dirty.add(symbol);
        }
      }
      if (adjusted.length) {
        // A stored close moved: the hub has re-downloaded adjusted history (split, bonus).
        this.deps.log?.(`Daily bars adjusted at the hub (split/bonus?): reading ${adjusted.join(", ")} again.`);
        const answer = await this.deps.batch(adjusted, target);
        note(answer);
        replace(answer, adjusted);
      }
    }

    await Promise.all([...dirty].filter((symbol) => !this.incomplete.has(symbol)).map((symbol) => this.deps.write(symbol, { coveredFrom: this.coveredFrom.get(symbol) ?? null, bars: this.getBars(symbol) })));
    this.queued = queued;
    this.unknown = unknown;
    this.lastSyncAt = this.now();
    const missing = unique.filter((symbol) => this.incomplete.has(symbol) && !queued.has(symbol)).length;
    this.retryAt = queued.size ? this.lastSyncAt + RETRY_AFTER_MS : hub.warning && missing ? this.lastSyncAt + 5 * 60_000 : 0;
    const last = Math.max(0, ...unique.map((symbol) => this.bars.get(symbol)?.at(-1)?.t ?? 0));
    const notes = [
      queued.size ? `the hub is downloading ${plural(queued.size, "symbol")}; asking again in ${RETRY_AFTER_MS / 1000} s` : "",
      hub.warning && missing ? `${plural(missing, "symbol")} incomplete: ${hub.warning}` : "",
      unknown.size ? `${plural(unknown.size, "symbol")} unknown to the hub (${[...unknown].slice(0, 5).join(", ")}${unknown.size > 5 ? "…" : ""})` : "",
    ].filter(Boolean);
    this.progress = {
      phase: "done",
      done: unique.length,
      total: unique.length,
      message: `${last ? `Daily bars through ${new Date(last).toISOString().slice(0, 10)}` : "No daily bars yet"} (Market Data Hub)${notes.length ? ` · ${notes.join(" · ")}` : ""}`,
      finishedAt: this.lastSyncAt,
      queued: queued.size,
    };
  }

  private needsFull(symbol: string, target: number): boolean {
    if (!this.bars.get(symbol)?.length || this.incomplete.has(symbol)) return true;
    const covered = this.coveredFrom.get(symbol);
    return covered === null || covered === undefined || covered > target + COVERAGE_SLACK_DAYS * DAY_MS;
  }

  private loadFromDisk(symbol: string): Promise<void> {
    if (this.bars.has(symbol)) return Promise.resolve();
    let pending = this.diskLoads.get(symbol);
    if (!pending) {
      pending = this.deps
        .read(symbol)
        .then((stored) => {
          if (!stored?.bars.length || this.bars.has(symbol)) return; // nothing saved, or a sync landed first
          this.bars.set(symbol, stored.bars);
          this.coveredFrom.set(symbol, stored.coveredFrom);
        })
        .catch(() => undefined);
      this.diskLoads.set(symbol, pending);
    }
    return pending;
  }
}
