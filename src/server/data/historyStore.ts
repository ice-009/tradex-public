import "server-only";

import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { mergeTail, planHistoryFetch, type StoredHistory } from "@/core/market/history";
import type { PricePoint } from "@/contracts/api";
import { readCandles, readSeries, touchSeries, writeSeries } from "@/server/data/candleDb";
import type { HistoryResult as Download } from "@/server/data/types";

// Candle history per source + symbol + interval, kept in the local market-data
// database (./candleDb.ts). Data fetched before costs one small "tail" request
// instead of re-downloading years of candles — and nothing at all while it's
// fresh. Used by the data engine for sources whose downloads cost API calls.

interface Entry extends StoredHistory<PricePoint> {
  syncedAt: number;
}

// Earlier versions kept each series as a JSON file in .cache/history; they're
// imported into the database the first time they're read, then removed.
const LEGACY_DIR = path.join(process.cwd(), ".cache", "history");
const legacyFile = (key: string) => path.join(LEGACY_DIR, `v2-${encodeURIComponent(key)}.json`);

const globalForHistory = globalThis as unknown as { historyInflight?: Map<string, Promise<PricePoint[]>> };
const inflight = (globalForHistory.historyInflight ??= new Map());

async function readEntry(key: string): Promise<Entry | null> {
  const meta = readSeries(key);
  if (meta) return { coveredFrom: meta.coveredFrom, syncedAt: meta.syncedAt, candles: readCandles(key) };
  try {
    const legacy = JSON.parse(await readFile(legacyFile(key), "utf8")) as Entry;
    if (!Array.isArray(legacy.candles) || !legacy.candles.length) return null;
    writeSeries(key, legacy, -Infinity);
    await unlink(legacyFile(key)).catch(() => {});
    return legacy;
  } catch {
    return null;
  }
}

/**
 * Candles from `from` (ms) to now for `key` (e.g. "NSE:SBIN-EQ:15").
 * `download(fromMs)` fetches from that time to now. Within `freshMs` of the last
 * sync nothing is fetched; otherwise only the tail since the newest stored candle
 * (minus `overlapMs`) is downloaded, unless the stored history is too short or
 * was adjusted, in which case it's downloaded in full.
 */
export function getHistory(params: { key: string; from: number; freshMs: number; overlapMs: number; reload?: boolean; download: (fromMs: number) => Promise<Download> }): Promise<PricePoint[]> {
  const { key, from } = params;
  const pending = inflight.get(key);
  if (pending) return pending.then((candles: PricePoint[]) => candles.filter((candle) => Date.parse(candle.date) >= from));

  const job: Promise<PricePoint[]> = (async () => {
    // `reload`: ignore what's stored (e.g. history was adjusted for a split) and download in full.
    const stored = params.reload ? null : await readEntry(key);
    const plan = planHistoryFetch(stored, from, params.overlapMs);
    if (stored && plan.kind === "tail" && Date.now() - stored.syncedAt < params.freshMs) return stored.candles;

    if (stored && plan.kind === "tail") {
      const tail = await params.download(plan.from);
      const merged = mergeTail(stored.candles, tail.candles, stored.coveredFrom);
      if (merged) {
        // An incomplete tail could leave a gap: show it, but don't store it.
        if (tail.complete) {
          if (tail.candles.length) writeSeries(key, { coveredFrom: stored.coveredFrom, candles: merged, syncedAt: Date.now() }, Date.parse(tail.candles[0].date));
          else touchSeries(key, Date.now());
        }
        return merged;
      }
      console.info(`History for ${key} was adjusted (split/bonus?) — downloading it again.`);
    }
    const { candles, complete } = await params.download(from);
    if (candles.length) {
      // Stopped early: record only what we have, so the next request downloads the rest.
      const coveredFrom = complete ? from : Date.parse(candles[0].date);
      writeSeries(key, { coveredFrom, candles, syncedAt: Date.now() }, -Infinity);
    }
    return candles;
  })().finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job.then((candles) => candles.filter((candle) => Date.parse(candle.date) >= from));
}

/** Stored candles for `key` from `from` on, without any download; null when the database doesn't cover `from`. */
export async function peekHistory(key: string, from: number): Promise<PricePoint[] | null> {
  const stored = await readEntry(key);
  if (!stored || stored.coveredFrom > from + 3 * 24 * 60 * 60 * 1000) return null;
  return stored.candles.filter((candle) => Date.parse(candle.date) >= from);
}
