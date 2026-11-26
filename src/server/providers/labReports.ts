import "server-only";

import type { LabReport } from "@/core/lab/engine";
import type { RunStamp } from "@/core/repro/stamp";
import { marketDb } from "@/server/data/candleDb";

// Storage for the Signal Lab's latest report per signal variant, so report
// cards (#23) open without running the Lab again. In the local market database
// (.cache/market.db, or MARKET_DB_PATH) next to the trial record
// (./labTrials.ts) — for the same reasons: research data about the shared
// dataset, the same for every user, persisted with the candle database and with
// no `db:setup` step.
//
//   lab_reports   variant_key (primary key: signal id + canonical params),
//                 signal_id, run_at, stamp_hash, report (JSON), stamp (JSON), costs (JSON)
//
// One row per variant: a newer run replaces the older one (the trial record
// keeps every run; this keeps only what the card shows).

let ready = false;
function db() {
  const database = marketDb();
  if (!ready) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS lab_reports (
        variant_key TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        run_at INTEGER NOT NULL,
        stamp_hash TEXT NOT NULL,
        report TEXT NOT NULL,
        stamp TEXT NOT NULL,
        costs TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lab_reports_signal ON lab_reports (signal_id, run_at);
    `);
    ready = true;
  }
  return database;
}

export interface StoredLabReport {
  variantKey: string;
  signalId: string;
  runAt: number;
  report: LabReport;
  stamp: RunStamp;
  costs: { preset: string; label: string };
}

interface Row {
  variant_key: string;
  signal_id: string;
  run_at: number;
  stamp_hash: string;
  report: string;
  stamp: string;
  costs: string;
}

function parse(row: Row): StoredLabReport | null {
  try {
    return {
      variantKey: row.variant_key,
      signalId: row.signal_id,
      runAt: row.run_at,
      report: JSON.parse(row.report) as LabReport,
      stamp: JSON.parse(row.stamp) as RunStamp,
      costs: JSON.parse(row.costs) as StoredLabReport["costs"],
    };
  } catch {
    return null; // a corrupt row: as if never stored
  }
}

/** Save a variant's latest report (replacing its previous one). */
export function writeReport(entry: StoredLabReport): void {
  db()
    .prepare(
      `INSERT INTO lab_reports (variant_key, signal_id, run_at, stamp_hash, report, stamp, costs) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (variant_key) DO UPDATE SET signal_id = excluded.signal_id, run_at = excluded.run_at, stamp_hash = excluded.stamp_hash,
         report = excluded.report, stamp = excluded.stamp, costs = excluded.costs`,
    )
    .run(entry.variantKey, entry.signalId, entry.runAt, entry.stamp.hash, JSON.stringify(entry.report), JSON.stringify(entry.stamp), JSON.stringify(entry.costs));
}

/** Every stored report of a signal (one per variant), newest first. */
export function readSignalReports(signalId: string): StoredLabReport[] {
  const rows = db().prepare("SELECT * FROM lab_reports WHERE signal_id = ? ORDER BY run_at DESC").all(signalId) as Row[];
  return rows.map(parse).filter((entry): entry is StoredLabReport => entry !== null);
}

/** The newest stored report of each signal, and how many variants each has stored. */
export function readLatestReports(): Array<StoredLabReport & { variants: number }> {
  const rows = db()
    .prepare(
      `SELECT r.*, c.variants FROM lab_reports r
       JOIN (SELECT signal_id, MAX(run_at) AS run_at, COUNT(*) AS variants FROM lab_reports GROUP BY signal_id) c
         ON c.signal_id = r.signal_id AND c.run_at = r.run_at
       ORDER BY r.signal_id, r.variant_key`,
    )
    .all() as Array<Row & { variants: number }>;
  const seen = new Set<string>();
  const out: Array<StoredLabReport & { variants: number }> = [];
  for (const row of rows) {
    if (seen.has(row.signal_id)) continue; // two variants run in the same millisecond: one card
    const entry = parse(row);
    if (!entry) continue;
    seen.add(row.signal_id);
    out.push({ ...entry, variants: row.variants });
  }
  return out;
}
