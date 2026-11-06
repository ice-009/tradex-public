import "server-only";

import type { LiveEntry, LiveSettlement, LiveTrade } from "@/core/screener/liveRecord";
import { marketDb } from "@/server/data/candleDb";

// Storage for the BTST live record (rules in src/core/screener/liveRecord.ts).
// Two tables in the local market database (.cache/market.db, or MARKET_DB_PATH):
//
//   btst_live       one row per trade day + screen + symbol: first sighting,
//                   entry (last price in the window), stop, and — once the next
//                   session has opened — the settlement
//   btst_live_days  the days the recorder ran inside the window, so a screen
//                   with no matches still shows "live since …: 0 trades"
//
// Unlike the candles next to it, this can't be downloaded again: a forward
// record is only as long as the server has been writing it. SQLite gives each
// screener run's upsert one transaction (no half-written JSON file if the
// process dies mid-save) and survives a restart; keeping it in the same file
// means whatever persists the candle database persists this too.

let ready = false;
function db() {
  const database = marketDb();
  if (!ready) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS btst_live (
        day INTEGER NOT NULL,
        screen_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        first_price REAL NOT NULL,
        entry_at INTEGER NOT NULL,
        entry_price REAL NOT NULL,
        stop REAL NOT NULL,
        exit_day INTEGER,
        exit_price REAL,
        gross_pct REAL,
        net_pct REAL,
        gap_stop INTEGER,
        qty INTEGER,
        cost_preset TEXT,
        PRIMARY KEY (day, screen_id, symbol)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS btst_live_days (
        day INTEGER PRIMARY KEY,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL
      );
    `);
    ready = true;
  }
  return database;
}

interface Row {
  day: number;
  screen_id: string;
  symbol: string;
  first_seen_at: number;
  first_price: number;
  entry_at: number;
  entry_price: number;
  stop: number;
  exit_day: number | null;
  exit_price: number | null;
  gross_pct: number | null;
  net_pct: number | null;
  gap_stop: number | null;
}

const toEntry = (row: Row): LiveEntry => ({
  screenId: row.screen_id,
  symbol: row.symbol,
  day: row.day,
  firstSeenAt: row.first_seen_at,
  firstPrice: row.first_price,
  entryAt: row.entry_at,
  entryPrice: row.entry_price,
  stop: row.stop,
});

const toTrade = (row: Row): LiveTrade => ({
  ...toEntry(row),
  settled:
    row.exit_day === null
      ? null
      : { exitDay: row.exit_day, exitPrice: row.exit_price ?? 0, grossPct: row.gross_pct ?? 0, netPct: row.net_pct ?? 0, gapStop: Boolean(row.gap_stop) },
});

/** Every setup recorded on one trade day. */
export function readDay(day: number): LiveEntry[] {
  return (db().prepare("SELECT * FROM btst_live WHERE day = ?").all(day) as Row[]).map(toEntry);
}

/** Setups from before `day` still waiting for their next open. */
export function readUnsettled(beforeDay: number): LiveEntry[] {
  return (db().prepare("SELECT * FROM btst_live WHERE exit_day IS NULL AND day < ?").all(beforeDay) as Row[]).map(toEntry);
}

/** All trades, oldest first. */
export function readTrades(): LiveTrade[] {
  return (db().prepare("SELECT * FROM btst_live ORDER BY day, entry_at").all() as Row[]).map(toTrade);
}

/** Save one screener run's sightings and note that the recorder watched this day. */
export function writeEntries(day: number, now: number, entries: LiveEntry[]) {
  const database = db();
  const upsert = database.prepare(
    `INSERT INTO btst_live (day, screen_id, symbol, first_seen_at, first_price, entry_at, entry_price, stop)
     VALUES (@day, @screenId, @symbol, @firstSeenAt, @firstPrice, @entryAt, @entryPrice, @stop)
     ON CONFLICT(day, screen_id, symbol) DO UPDATE SET entry_at = excluded.entry_at, entry_price = excluded.entry_price, stop = excluded.stop
     WHERE btst_live.exit_day IS NULL`,
  );
  database.transaction(() => {
    for (const entry of entries) upsert.run(entry);
    database
      .prepare("INSERT INTO btst_live_days (day, first_at, last_at) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET last_at = excluded.last_at")
      .run(day, now, now);
  })();
}

export function writeSettlements(items: Array<{ entry: LiveEntry; settled: LiveSettlement; qty: number; costPreset: string }>) {
  if (!items.length) return;
  const database = db();
  const update = database.prepare(
    `UPDATE btst_live SET exit_day = ?, exit_price = ?, gross_pct = ?, net_pct = ?, gap_stop = ?, qty = ?, cost_preset = ?
     WHERE day = ? AND screen_id = ? AND symbol = ? AND exit_day IS NULL`,
  );
  database.transaction(() => {
    for (const { entry, settled, qty, costPreset } of items) {
      update.run(settled.exitDay, settled.exitPrice, settled.grossPct, settled.netPct, settled.gapStop ? 1 : 0, qty, costPreset, entry.day, entry.screenId, entry.symbol);
    }
  })();
}

/** First day the recorder watched the window, and how many days it has. */
export function watchedDays(): { since: number | null; days: number } {
  const row = db().prepare("SELECT MIN(day) AS since, COUNT(*) AS days FROM btst_live_days").get() as { since: number | null; days: number };
  return { since: row.since, days: row.days };
}
