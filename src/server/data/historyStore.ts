import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mergeTail, planHistoryFetch, type StoredHistory } from "@/core/market/history";
import type { PricePoint } from "@/contracts/api";
import type { HistoryResult as Download } from "@/server/data/types";

// Candle history kept on disk per source + symbol + interval (.cache/history),
// so data that was fetched before costs one small "tail" request instead of
// re-downloading years of candles — and nothing at all while it's fresh. Used
// by the data engine for sources whose downloads cost API calls.

const DIR = path.join(process.cwd(), ".cache", "history");
/** Bump to discard stored files written by an older (buggy) version. v2: partial downloads were saved as complete. */
const VERSION = "v2";


interface Entry extends StoredHistory<PricePoint> {
  syncedAt: number;
}

const globalForHistory = globalThis as unknown as { historyStore?: { entries: Map<string, Entry>; inflight: Map<string, Promise<PricePoint[]>> } };
const store = (globalForHistory.historyStore ??= { entries: new Map(), inflight: new Map() });

const fileOf = (key: string) => path.join(DIR, `${VERSION}-${encodeURIComponent(key)}.json`);

async function readEntry(key: string): Promise<Entry | null> {
  const memory = store.entries.get(key);
  if (memory) return memory;
  try {
    const entry = JSON.parse(await readFile(fileOf(key), "utf8")) as Entry;
    if (!Array.isArray(entry.candles)) return null;
    store.entries.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

async function saveEntry(key: string, entry: Entry) {
  store.entries.set(key, entry);
  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(fileOf(key), JSON.stringify(entry));
  } catch (error) {
    console.warn("Couldn't save candle history", key, (error as Error).message);
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
  const pending = store.inflight.get(key);
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
        if (tail.complete) await saveEntry(key, { coveredFrom: stored.coveredFrom, candles: merged, syncedAt: Date.now() });
        return merged;
      }
      console.info(`History for ${key} was adjusted (split/bonus?) — downloading it again.`);
    }
    const { candles, complete } = await params.download(from);
    if (candles.length) {
      // Stopped early: record only what we have, so the next request downloads the rest.
      const coveredFrom = complete ? from : Date.parse(candles[0].date);
      await saveEntry(key, { coveredFrom, candles, syncedAt: Date.now() });
    }
    return candles;
  })().finally(() => store.inflight.delete(key));

  store.inflight.set(key, job);
  return job.then((candles) => candles.filter((candle) => Date.parse(candle.date) >= from));
}
