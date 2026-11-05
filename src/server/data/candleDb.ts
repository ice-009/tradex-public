import "server-only";

import Database from "better-sqlite3";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { PricePoint } from "@/contracts/api";

// The local market-data database: every candle the data engine has downloaded,
// per series (source + symbol + interval), in one SQLite file. Charts, the
// screener and the backtester read history from here, so opening a chart costs
// a disk read instead of an API round-trip.
//
//   series   key, covered_from (complete back to this time), synced_at, count, first_t, last_t
//   candles  key, t (epoch ms), o, h, l, c, v      — primary key (key, t)
//
// Other modules may add their own tables through `marketDb()` (src/server/providers/btstRecord.ts).
//
// The file lives in .cache/ (git-ignored). Set MARKET_DB_PATH to put it elsewhere.

export interface SeriesMeta {
  key: string;
  coveredFrom: number;
  syncedAt: number;
  count: number;
  firstT: number | null;
  lastT: number | null;
}

const DB_PATH = process.env.MARKET_DB_PATH || path.join(process.cwd(), ".cache", "market.db");

function open(): Database.Database {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL"); // readers don't block the writer
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS series (
      key TEXT PRIMARY KEY,
      covered_from INTEGER NOT NULL,
      synced_at INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      first_t INTEGER,
      last_t INTEGER
    );
    CREATE TABLE IF NOT EXISTS candles (
      key TEXT NOT NULL,
      t INTEGER NOT NULL,
      o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL,
      PRIMARY KEY (key, t)
    ) WITHOUT ROWID;
  `);
  return db;
}

const globalForDb = globalThis as unknown as { marketDb?: Database.Database };
function db(): Database.Database {
  globalForDb.marketDb ??= open();
  return globalForDb.marketDb;
}

/** The shared connection, for other tables kept in the same file (the BTST live record). */
export const marketDb = db;

interface SeriesRow {
  key: string;
  covered_from: number;
  synced_at: number;
  count: number;
  first_t: number | null;
  last_t: number | null;
}

const toMeta = (row: SeriesRow): SeriesMeta => ({ key: row.key, coveredFrom: row.covered_from, syncedAt: row.synced_at, count: row.count, firstT: row.first_t, lastT: row.last_t });

export function readSeries(key: string): SeriesMeta | null {
  const row = db().prepare("SELECT * FROM series WHERE key = ?").get(key) as SeriesRow | undefined;
  return row ? toMeta(row) : null;
}

/** Metadata for many series at once (missing keys are absent from the map). */
export function readSeriesMany(keys: string[]): Map<string, SeriesMeta> {
  const out = new Map<string, SeriesMeta>();
  const statement = db().prepare("SELECT * FROM series WHERE key = ?");
  for (const key of keys) {
    const row = statement.get(key) as SeriesRow | undefined;
    if (row) out.set(key, toMeta(row));
  }
  return out;
}

/** Candles of a series from `from` (epoch ms) on, oldest first. */
export function readCandles(key: string, from = Number.MIN_SAFE_INTEGER): PricePoint[] {
  const rows = db().prepare("SELECT t, o, h, l, c, v FROM candles WHERE key = ? AND t >= ? ORDER BY t").all(key, from) as Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
  return rows.map((row) => ({ date: new Date(row.t).toISOString(), open: row.o, high: row.h, low: row.l, close: row.c, volume: row.v }));
}

/**
 * Store a series. Candles at or after `replaceFrom` are replaced by `candles`
 * (those before it are kept as they are); anything older than `coveredFrom` is
 * dropped. Pass replaceFrom = -Infinity to replace the whole series.
 */
export function writeSeries(key: string, entry: { coveredFrom: number; syncedAt: number; candles: PricePoint[] }, replaceFrom: number) {
  const database = db();
  const from = Number.isFinite(replaceFrom) ? replaceFrom : Number.MIN_SAFE_INTEGER;
  const insert = database.prepare("INSERT OR REPLACE INTO candles (key, t, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?)");
  database.transaction(() => {
    database.prepare("DELETE FROM candles WHERE key = ? AND (t < ? OR t >= ?)").run(key, entry.coveredFrom, from);
    for (const candle of entry.candles) {
      const t = Date.parse(candle.date);
      if (t >= from && t >= entry.coveredFrom) insert.run(key, t, candle.open, candle.high, candle.low, candle.close, candle.volume ?? 0);
    }
    const summary = database.prepare("SELECT COUNT(*) AS count, MIN(t) AS first_t, MAX(t) AS last_t FROM candles WHERE key = ?").get(key) as { count: number; first_t: number | null; last_t: number | null };
    database
      .prepare(
        `INSERT INTO series (key, covered_from, synced_at, count, first_t, last_t) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET covered_from = excluded.covered_from, synced_at = excluded.synced_at,
           count = excluded.count, first_t = excluded.first_t, last_t = excluded.last_t`,
      )
      .run(key, entry.coveredFrom, entry.syncedAt, summary.count, summary.first_t, summary.last_t);
  })();
}

/** Mark a series as checked just now (nothing new to store). */
export function touchSeries(key: string, syncedAt: number) {
  db().prepare("UPDATE series SET synced_at = ? WHERE key = ?").run(syncedAt, key);
}

export function dbStats() {
  const row = db().prepare("SELECT COUNT(*) AS series, COALESCE(SUM(count), 0) AS candles FROM series").get() as { series: number; candles: number };
  let bytes = 0;
  for (const suffix of ["", "-wal"]) {
    try {
      bytes += statSync(DB_PATH + suffix).size;
    } catch {
      // not there yet
    }
  }
  return { series: row.series, candles: row.candles, bytes, path: path.relative(process.cwd(), DB_PATH) };
}
