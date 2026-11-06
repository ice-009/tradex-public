import "server-only";

import type { FoDayRecord, FoLeg } from "@/core/parsers/foBhavcopy";
import { marketDb } from "@/server/data/candleDb";

// Storage for the NSE F&O bhavcopy import (parsing in src/core/parsers/foBhavcopy.ts,
// download in foBhavcopy.ts). Two tables in the local market database
// (.cache/market.db, or MARKET_DB_PATH):
//
//   fo_bhav_days  one row per weekday checked: status "ok" (file read),
//                 "holiday" (NSE has no file) or "mismatch" (NSE served a file
//                 for another date — treated like a holiday), the number of
//                 underlyings, and when it was checked. This is what makes the
//                 backfill resumable: a checked day is never asked for again.
//   fo_futures    one row per trade day + underlying (app ticker, after
//                 renames): near and next month close / settlement / previous
//                 close / volume (contracts) / OI / change in OI (shares), and
//                 OI combined across all listed months with its change (sum
//                 of each month's change).
//
// Point-in-time F&O membership is simply "has a fo_futures row that day".
// Unlike the broker candles next to it, every row here comes from NSE's free
// public archive, so it costs no broker API calls to fill or refill.

export type FoDayStatus = "ok" | "holiday" | "mismatch";

let ready = false;
function db() {
  const database = marketDb();
  if (!ready) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS fo_bhav_days (
        day INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        underlyings INTEGER NOT NULL DEFAULT 0,
        checked_at INTEGER NOT NULL,
        note TEXT
      );
      CREATE TABLE IF NOT EXISTS fo_futures (
        day INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        nse_symbol TEXT NOT NULL,
        expiries INTEGER NOT NULL,
        lot REAL,
        underlying REAL,
        near_expiry INTEGER NOT NULL,
        near_close REAL NOT NULL,
        near_settle REAL NOT NULL,
        near_prev_close REAL NOT NULL,
        near_volume REAL NOT NULL,
        near_oi REAL NOT NULL,
        near_chg_oi REAL NOT NULL,
        next_expiry INTEGER,
        next_close REAL,
        next_settle REAL,
        next_prev_close REAL,
        next_volume REAL,
        next_oi REAL,
        next_chg_oi REAL,
        oi REAL NOT NULL,
        chg_oi REAL NOT NULL,
        PRIMARY KEY (day, symbol)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS fo_futures_symbol ON fo_futures (symbol, day);
    `);
    ready = true;
  }
  return database;
}

interface Row {
  day: number;
  symbol: string;
  nse_symbol: string;
  expiries: number;
  lot: number | null;
  underlying: number | null;
  near_expiry: number;
  near_close: number;
  near_settle: number;
  near_prev_close: number;
  near_volume: number;
  near_oi: number;
  near_chg_oi: number;
  next_expiry: number | null;
  next_close: number | null;
  next_settle: number | null;
  next_prev_close: number | null;
  next_volume: number | null;
  next_oi: number | null;
  next_chg_oi: number | null;
  oi: number;
  chg_oi: number;
}

const toRecord = (row: Row): FoDayRecord => ({
  day: row.day,
  symbol: row.symbol,
  nseSymbol: row.nse_symbol,
  expiries: row.expiries,
  lot: row.lot,
  underlying: row.underlying,
  near: { expiry: row.near_expiry, close: row.near_close, settle: row.near_settle, prevClose: row.near_prev_close, volume: row.near_volume, oi: row.near_oi, chgOi: row.near_chg_oi },
  next:
    row.next_expiry === null
      ? null
      : {
          expiry: row.next_expiry,
          close: row.next_close ?? 0,
          settle: row.next_settle ?? 0,
          prevClose: row.next_prev_close ?? 0,
          volume: row.next_volume ?? 0,
          oi: row.next_oi ?? 0,
          chgOi: row.next_chg_oi ?? 0,
        },
  oi: row.oi,
  chgOi: row.chg_oi,
});

const legParams = (prefix: "near" | "next", leg: FoLeg | null) => ({
  [`${prefix}_expiry`]: leg?.expiry ?? null,
  [`${prefix}_close`]: leg?.close ?? null,
  [`${prefix}_settle`]: leg?.settle ?? null,
  [`${prefix}_prev_close`]: leg?.prevClose ?? null,
  [`${prefix}_volume`]: leg?.volume ?? null,
  [`${prefix}_oi`]: leg?.oi ?? null,
  [`${prefix}_chg_oi`]: leg?.chgOi ?? null,
});

/** Replace one trade day's records and mark the day "ok". */
export function writeFoDay(day: number, records: FoDayRecord[], checkedAt: number) {
  const database = db();
  const insert = database.prepare(
    `INSERT INTO fo_futures (day, symbol, nse_symbol, expiries, lot, underlying,
       near_expiry, near_close, near_settle, near_prev_close, near_volume, near_oi, near_chg_oi,
       next_expiry, next_close, next_settle, next_prev_close, next_volume, next_oi, next_chg_oi, oi, chg_oi)
     VALUES (@day, @symbol, @nse_symbol, @expiries, @lot, @underlying,
       @near_expiry, @near_close, @near_settle, @near_prev_close, @near_volume, @near_oi, @near_chg_oi,
       @next_expiry, @next_close, @next_settle, @next_prev_close, @next_volume, @next_oi, @next_chg_oi, @oi, @chg_oi)`,
  );
  database.transaction(() => {
    database.prepare("DELETE FROM fo_futures WHERE day = ?").run(day);
    for (const record of records) {
      insert.run({
        day,
        symbol: record.symbol,
        nse_symbol: record.nseSymbol,
        expiries: record.expiries,
        lot: record.lot,
        underlying: record.underlying,
        ...legParams("near", record.near),
        ...legParams("next", record.next),
        oi: record.oi,
        chg_oi: record.chgOi,
      });
    }
    markDay(day, "ok", checkedAt, null, records.length);
  })();
}

/** Record a day with no usable file (holiday, or NSE served another date's file). */
export function markFoDay(day: number, status: Exclude<FoDayStatus, "ok">, checkedAt: number, note: string | null = null) {
  const database = db();
  database.transaction(() => {
    database.prepare("DELETE FROM fo_futures WHERE day = ?").run(day);
    markDay(day, status, checkedAt, note, 0);
  })();
}

function markDay(day: number, status: FoDayStatus, checkedAt: number, note: string | null, underlyings: number) {
  db()
    .prepare(
      `INSERT INTO fo_bhav_days (day, status, underlyings, checked_at, note) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET status = excluded.status, underlyings = excluded.underlyings, checked_at = excluded.checked_at, note = excluded.note`,
    )
    .run(day, status, underlyings, checkedAt, note);
}

/** Every day already checked from `from` on, with its status. */
export function checkedFoDays(from = Number.MIN_SAFE_INTEGER): Map<number, FoDayStatus> {
  const rows = db().prepare("SELECT day, status FROM fo_bhav_days WHERE day >= ?").all(from) as Array<{ day: number; status: FoDayStatus }>;
  return new Map(rows.map((row) => [row.day, row.status]));
}

/** Trade days stored ("ok"), their range, and how many weekdays were checked in all. */
export function foCoverage(from = Number.MIN_SAFE_INTEGER): { days: number; checked: number; first: number | null; last: number | null; rows: number } {
  const days = db()
    .prepare("SELECT COUNT(*) AS checked, SUM(status = 'ok') AS days, MIN(CASE WHEN status = 'ok' THEN day END) AS first, MAX(CASE WHEN status = 'ok' THEN day END) AS last FROM fo_bhav_days WHERE day >= ?")
    .get(from) as { checked: number; days: number | null; first: number | null; last: number | null };
  const rows = db().prepare("SELECT COUNT(*) AS rows FROM fo_futures WHERE day >= ?").get(from) as { rows: number };
  return { days: days.days ?? 0, checked: days.checked, first: days.first, last: days.last, rows: rows.rows };
}

/** Stock-futures underlyings per stored trade day (point-in-time F&O membership). */
export function foMembership(from = Number.MIN_SAFE_INTEGER, to = Number.MAX_SAFE_INTEGER): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  const days = db().prepare("SELECT day FROM fo_bhav_days WHERE status = 'ok' AND day BETWEEN ? AND ?").all(from, to) as Array<{ day: number }>;
  for (const { day } of days) out.set(day, new Set());
  const rows = db().prepare("SELECT day, symbol FROM fo_futures WHERE day BETWEEN ? AND ?").all(from, to) as Array<{ day: number; symbol: string }>;
  for (const row of rows) out.get(row.day)?.add(row.symbol);
  return out;
}

/** The newest stored trade day and its records (null when nothing is stored). */
export function latestFoDay(): { day: number; records: FoDayRecord[] } | null {
  const row = db().prepare("SELECT MAX(day) AS day FROM fo_bhav_days WHERE status = 'ok'").get() as { day: number | null };
  if (row.day === null) return null;
  return { day: row.day, records: readFoDay(row.day) };
}

export function readFoDay(day: number): FoDayRecord[] {
  return (db().prepare("SELECT * FROM fo_futures WHERE day = ? ORDER BY symbol").all(day) as Row[]).map(toRecord);
}

/** One underlying's stored days from `from` on, oldest first. */
export function readFoSymbol(symbol: string, from = Number.MIN_SAFE_INTEGER): FoDayRecord[] {
  return (db().prepare("SELECT * FROM fo_futures WHERE symbol = ? AND day >= ? ORDER BY day").all(symbol, from) as Row[]).map(toRecord);
}
