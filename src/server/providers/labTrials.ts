import "server-only";

import type { Trial } from "@/core/lab/trials";
import { marketDb } from "@/server/data/candleDb";

// Storage for the Signal Lab's trial record (rules in src/core/lab/trials.ts):
// one row per Lab run of a variant at a horizon, in the local market database
// (.cache/market.db, or MARKET_DB_PATH), next to the BTST live record.
//
// Why here and not Prisma: Prisma (prisma/schema.prisma) holds per-user data —
// accounts, the trade journal. The trial record is research data about the
// shared dataset, the same for every user, like the BTST live record; and like
// it, it can't be rebuilt — the count of what was tried is only as complete as
// the server's memory of it. Keeping it in market.db means whatever persists the
// candle database persists this too, with no `db:setup` step.
//
//   lab_trials   id, idea_id, variant_key, horizon, run_at, params (JSON),
//                period_from, period_to, periods_per_year, sharpe, t, skew, kurt,
//                spread_mean, t_stat, stamp_hash
//                unique (idea_id, variant_key, horizon, stamp_hash): an identical run is stored once

let ready = false;
function db() {
  const database = marketDb();
  if (!ready) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS lab_trials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idea_id TEXT NOT NULL,
        variant_key TEXT NOT NULL,
        horizon INTEGER NOT NULL,
        run_at INTEGER NOT NULL,
        params TEXT NOT NULL,
        period_from INTEGER,
        period_to INTEGER NOT NULL,
        periods_per_year REAL,
        sharpe REAL NOT NULL,
        t INTEGER NOT NULL,
        skew REAL NOT NULL,
        kurt REAL NOT NULL,
        spread_mean REAL,
        t_stat REAL,
        stamp_hash TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS lab_trials_run ON lab_trials (idea_id, variant_key, horizon, stamp_hash);
      CREATE INDEX IF NOT EXISTS lab_trials_idea ON lab_trials (idea_id, run_at);
    `);
    ready = true;
  }
  return database;
}

interface Row {
  idea_id: string;
  variant_key: string;
  horizon: number;
  run_at: number;
  params: string;
  period_from: number | null;
  period_to: number;
  periods_per_year: number | null;
  sharpe: number;
  t: number;
  skew: number;
  kurt: number;
  spread_mean: number | null;
  t_stat: number | null;
  stamp_hash: string;
}

const parseParams = (text: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const toTrial = (row: Row): Trial => ({
  ideaId: row.idea_id,
  variantKey: row.variant_key,
  params: parseParams(row.params),
  period: { from: row.period_from, to: row.period_to },
  horizon: row.horizon,
  ...(row.periods_per_year === null ? {} : { periodsPerYear: row.periods_per_year }),
  sharpe: row.sharpe,
  T: row.t,
  skew: row.skew,
  kurt: row.kurt,
  spreadMean: row.spread_mean,
  tStat: row.t_stat,
  stampHash: row.stamp_hash,
  runAt: row.run_at,
});

const finiteOrNull = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Save trials (already validated) in one transaction; a run already stored (same stamp hash) is skipped. Returns how many were new. */
export function writeTrials(trials: readonly Trial[]): number {
  if (!trials.length) return 0;
  const database = db();
  const insert = database.prepare(
    `INSERT OR IGNORE INTO lab_trials (idea_id, variant_key, horizon, run_at, params, period_from, period_to, periods_per_year, sharpe, t, skew, kurt, spread_mean, t_stat, stamp_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let added = 0;
  database.transaction(() => {
    for (const trial of trials) {
      const result = insert.run(
        trial.ideaId,
        trial.variantKey,
        trial.horizon,
        trial.runAt,
        JSON.stringify(trial.params),
        trial.period.from,
        trial.period.to,
        finiteOrNull(trial.periodsPerYear),
        trial.sharpe,
        trial.T,
        trial.skew,
        trial.kurt,
        finiteOrNull(trial.spreadMean),
        finiteOrNull(trial.tStat),
        trial.stampHash,
      );
      added += result.changes;
    }
  })();
  return added;
}

/** Every run recorded for an idea, oldest first. */
export function readTrials(ideaId: string): Trial[] {
  return (db().prepare("SELECT * FROM lab_trials WHERE idea_id = ? ORDER BY run_at, id").all(ideaId) as Row[]).map(toTrial);
}
