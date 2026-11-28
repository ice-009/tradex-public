import "server-only";

import { canonicalJson } from "@/core/repro/canonical";
import type { LedgerAnchor, LedgerRecord, SealKind } from "@/core/plan/seal";
import { marketDb } from "@/server/data/candleDb";

// Storage for the sealed-plan ledger (rules in src/core/plan/seal.ts), in the
// local market database (.cache/market.db, or MARKET_DB_PATH) next to the BTST
// live record and the Lab's trial record.
//
// Why here and not Prisma: Prisma holds per-user data (accounts, the trade
// journal). The sealed plan is the same for every user — it is sealed before
// sizing — and, like the BTST live record, it can't be rebuilt: a forward
// record is only as long as the server has been writing it. Whatever persists
// the candle database persists this too, with no `db:setup` step.
//
//   plan_ledger          seq (1, 2, …), day, kind, sealed_at, hash, prev_hash,
//                        body = the record's canonical JSON (the source of truth;
//                        the other columns are for lookups)
//                        unique (day, kind): one seal per day and kind
//                        triggers refuse UPDATE and DELETE: append-only
//   plan_ledger_anchors  where each seal's hash was published outside (opt-in), and whether it worked
//
// The triggers stop the app (or a careless script) from rewriting history;
// they don't stop someone with the file and a SQLite shell. That is what the
// hash chain detects (`verifyLedger`), and publishing each hash outside makes
// even a rewritten tail visible (`checkAnchors`).

let ready = false;
function db() {
  const database = marketDb();
  if (!ready) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS plan_ledger (
        seq INTEGER PRIMARY KEY,
        day INTEGER NOT NULL,
        kind TEXT NOT NULL,
        sealed_at INTEGER NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        prev_hash TEXT NOT NULL,
        body TEXT NOT NULL,
        UNIQUE (day, kind)
      );
      CREATE TRIGGER IF NOT EXISTS plan_ledger_no_update BEFORE UPDATE ON plan_ledger
        BEGIN SELECT RAISE(ABORT, 'plan_ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS plan_ledger_no_delete BEFORE DELETE ON plan_ledger
        BEGIN SELECT RAISE(ABORT, 'plan_ledger is append-only'); END;
      CREATE TABLE IF NOT EXISTS plan_ledger_anchors (
        seq INTEGER NOT NULL,
        hash TEXT NOT NULL,
        at INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        note TEXT NOT NULL,
        PRIMARY KEY (seq, at)
      );
    `);
    ready = true;
  }
  return database;
}

interface Row {
  seq: number;
  body: string;
}

function parse(row: Row): LedgerRecord {
  try {
    return JSON.parse(row.body) as LedgerRecord;
  } catch {
    // An unreadable body still takes its place in the chain, so verification reports it.
    return { seq: row.seq } as LedgerRecord;
  }
}

/** The newest record, or null for an empty ledger. */
export function readHead(): LedgerRecord | null {
  const row = db().prepare("SELECT seq, body FROM plan_ledger ORDER BY seq DESC LIMIT 1").get() as Row | undefined;
  return row ? parse(row) : null;
}

/** Records in seq order; with a range, only those whose day is in it (day keys, inclusive). */
export function readLedger(range: { from?: number | null; to?: number | null } = {}): LedgerRecord[] {
  const rows = db()
    .prepare("SELECT seq, body FROM plan_ledger WHERE day >= ? AND day <= ? ORDER BY seq")
    .all(range.from ?? -8.64e15, range.to ?? 8.64e15) as Row[];
  return rows.map(parse);
}

/** The record just before `seq` (to verify a slice), or null. */
export function readBefore(seq: number): LedgerRecord | null {
  const row = db().prepare("SELECT seq, body FROM plan_ledger WHERE seq < ? ORDER BY seq DESC LIMIT 1").get(seq) as Row | undefined;
  return row ? parse(row) : null;
}

/** Which (day, kind) seals exist from `since` on. */
export function sealedKeys(since: number): Set<string> {
  const rows = db().prepare("SELECT day, kind FROM plan_ledger WHERE day >= ?").all(since) as Array<{ day: number; kind: SealKind }>;
  return new Set(rows.map((row) => `${row.day}:${row.kind}`));
}

export const sealKey = (day: number, kind: SealKind) => `${day}:${kind}`;

export function countSeals(): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM plan_ledger").get() as { n: number }).n;
}

/**
 * Append the next record in one write transaction: `make` gets the current
 * head and returns the record to add. Returns null (and adds nothing) when the
 * day already has a seal of that kind — so two runs, or two server processes
 * sharing the file, seal each day once.
 */
export function appendSeal(day: number, kind: SealKind, make: (head: LedgerRecord | null) => LedgerRecord): LedgerRecord | null {
  const database = db();
  const exists = database.prepare("SELECT 1 FROM plan_ledger WHERE day = ? AND kind = ?");
  const insert = database.prepare("INSERT INTO plan_ledger (seq, day, kind, sealed_at, hash, prev_hash, body) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const run = database.transaction((): LedgerRecord | null => {
    if (exists.get(day, kind)) return null;
    const record = make(readHead());
    if (record.day !== day || record.kind !== kind) throw new Error("The sealed record is for another day or kind.");
    insert.run(record.seq, record.day, record.kind, record.sealedAt, record.hash, record.prevHash, canonicalJson(record));
    return record;
  });
  // IMMEDIATE: take the write lock before reading the head, so no other writer slips in between.
  return run.immediate();
}

export function writeAnchor(anchor: { seq: number; hash: string; at: number; ok: boolean; note: string }) {
  db().prepare("INSERT OR IGNORE INTO plan_ledger_anchors (seq, hash, at, ok, note) VALUES (?, ?, ?, ?, ?)").run(anchor.seq, anchor.hash, anchor.at, anchor.ok ? 1 : 0, anchor.note.slice(0, 500));
}

/** The seals published outside, as the server recorded them (the external copy is what proves anything). */
export function readAnchors(): Array<LedgerAnchor & { at: number; ok: boolean; note: string }> {
  const rows = db().prepare("SELECT seq, hash, at, ok, note FROM plan_ledger_anchors ORDER BY seq, at").all() as Array<{ seq: number; hash: string; at: number; ok: number; note: string }>;
  return rows.map((row) => ({ seq: row.seq, hash: row.hash, at: row.at, ok: row.ok === 1, note: row.note }));
}
