import "server-only";

import type { HistoryDbStatus, HistoryKind } from "@/contracts/api";
import { PREFETCH_INDICES, PREFETCH_SPECS, estimateCalls, isCovered, planPrefetch, type PrefetchJob, type PrefetchSpec } from "@/core/market/prefetch";
import { dataEngine } from "@/server/data";
import { dbStats, readSeriesMany } from "@/server/data/candleDb";
import type { DataSource } from "@/server/data/types";
import { SESSION_CLOSE_MIN, SESSION_OPEN_MIN, istParts } from "@/core/market/session";
import { asPriority, budgetFor, fyersPlan } from "@/server/providers/fyers/budget";
import { getUniverse } from "@/server/providers/universe";
import { foBhavStatus } from "@/server/services/foBhavSync";

// "Download F&O history": fills the local market-data database with 5 years of
// daily and 1 year of 15-minute candles for every F&O stock plus the main
// indices, so charts, the screener and backtests read from disk instead of the
// broker. Runs at background priority (charts are always served first), skips
// what's already stored — so it can be stopped and resumed — and pauses when
// today's API budget for background work is used up.

const DAY_MS = 24 * 60 * 60 * 1000;
const CONCURRENCY = 2;

interface Job {
  state: HistoryDbStatus["job"]["state"];
  kinds: HistoryKind[];
  done: number;
  total: number;
  failed: string[];
  current: string | null;
  message: string;
  startedAt: number | null;
  finishedAt: number | null;
  stop: boolean;
}

const globalForPrefetch = globalThis as unknown as { historyPrefetch?: Job };
const job: Job = (globalForPrefetch.historyPrefetch ??= { state: "idle", kinds: [], done: 0, total: 0, failed: [], current: null, message: "", startedAt: null, finishedAt: null, stop: false });

async function universe(): Promise<string[]> {
  const fno = (await getUniverse("fno")).map((member) => member.symbol);
  return [...PREFETCH_INDICES, ...fno.filter((symbol) => !PREFETCH_INDICES.includes(symbol))];
}

/** The broker source whose history is stored (Fyers), or null. */
function broker(): DataSource | null {
  return dataEngine().sources.find((source) => source.kind === "broker" && source.history?.cacheable) ?? null;
}

/** Earliest time a series must reach for `spec` (clamped to the broker's window). */
function target(source: DataSource, spec: PrefetchSpec, now: number) {
  const window = source.history?.windowDays?.(spec.interval) ?? spec.days;
  return now - Math.min(spec.days, window) * DAY_MS;
}

/** Which symbol × spec pairs are already stored far enough back. */
function coverageCheck(source: DataSource, symbols: string[], now: number) {
  const engine = dataEngine();
  const keys = new Map<string, string>();
  for (const spec of Object.values(PREFETCH_SPECS)) for (const symbol of symbols) keys.set(`${symbol}|${spec.kind}`, engine.historyKey(source, symbol, spec.interval));
  const meta = readSeriesMany([...keys.values()]);
  return (symbol: string, spec: PrefetchSpec) => isCovered(meta.get(keys.get(`${symbol}|${spec.kind}`)!)?.coveredFrom, target(source, spec, now));
}

export async function historyDbStatus(): Promise<HistoryDbStatus> {
  const source = broker();
  const symbols = await universe();
  const now = Date.now();
  const covered = source ? coverageCheck(source, symbols, now) : () => false;
  const coverage = Object.values(PREFETCH_SPECS).map((spec) => {
    const missing = planPrefetch(symbols, [spec.kind], covered);
    return { kind: spec.kind, label: spec.label, covered: symbols.length - missing.length, total: symbols.length, missing: missing.length, estimatedCalls: estimateCalls(missing) };
  });
  const unavailable = source ? await dataEngine().unavailable(source) : "no broker source configured";
  const { stop: _stop, ...state } = job;
  void _stop;
  return {
    job: state,
    coverage,
    db: dbStats(),
    backgroundCallsLeft: source ? budgetFor("background").remainingToday : null,
    brokerConnected: !unavailable,
    fo: foBhavStatus(now),
  };
}

export async function startHistoryPrefetch(kinds: HistoryKind[]): Promise<void> {
  if (job.state === "running") return;
  const source = broker();
  const reason = source ? await dataEngine().unavailable(source) : "no broker source configured";
  if (!source || reason) {
    Object.assign(job, { state: "error", message: `Connect a broker first (${reason}).`, finishedAt: Date.now() });
    return;
  }
  const symbols = await universe();
  const jobs = planPrefetch(symbols, kinds, coverageCheck(source, symbols, Date.now()));
  Object.assign(job, { state: "running", kinds, done: 0, total: jobs.length, failed: [], current: null, stop: false, startedAt: Date.now(), finishedAt: null, message: jobs.length ? `Downloading ${jobs.length} series (~${estimateCalls(jobs)} API calls)…` : "Everything is already stored." });
  if (!jobs.length) {
    Object.assign(job, { state: "done", finishedAt: Date.now() });
    return;
  }
  void asPriority("background", () => run(jobs)).catch((error) => Object.assign(job, { state: "error", message: (error as Error).message, finishedAt: Date.now() }));
}

export function stopHistoryPrefetch() {
  if (job.state === "running") job.stop = true;
}

/**
 * During market hours, leave enough of today's budget for live screening: about
 * one quote refresh of the F&O list per minute until the close.
 */
function liveReserve(symbols: number): number {
  const { minutes, weekday } = istParts();
  if (weekday === 0 || weekday === 6 || minutes < SESSION_OPEN_MIN || minutes >= SESSION_CLOSE_MIN) return 0;
  return Math.ceil(symbols / fyersPlan().limits.quoteBatch) * (SESSION_CLOSE_MIN - minutes);
}

async function run(jobs: PrefetchJob[]) {
  const queue = [...jobs];
  let pausedForBudget = false;
  let pausedForMarket = false;
  const reserveFor = new Set(jobs.map((entry) => entry.symbol)).size;
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (job.stop || pausedForBudget || pausedForMarket) return;
      if (budgetFor("background").remainingToday < liveReserve(reserveFor) + next.spec.callsPerSymbol) {
        pausedForMarket = true;
        return;
      }
      job.current = `${next.symbol} · ${next.spec.label}`;
      const from = Date.now() - next.spec.days * DAY_MS;
      const answer = await dataEngine().history({ symbol: next.symbol, interval: next.spec.interval, from, kinds: ["broker"] });
      if (!answer.source) {
        const why = answer.skipped.join("; ");
        if (/budget/i.test(why)) {
          pausedForBudget = true;
          return;
        }
        job.failed.push(next.symbol);
      }
      job.done += 1;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const finishedAt = Date.now();
  if (pausedForMarket) {
    Object.assign(job, { state: "paused", current: null, finishedAt, message: "Paused to keep live screening going during market hours. Start it again after 15:30 — it continues where it stopped." });
  } else if (pausedForBudget) {
    Object.assign(job, { state: "paused", current: null, finishedAt, message: "Today's API budget for background work is used up. Start it again tomorrow — it continues where it stopped." });
  } else if (job.stop) {
    Object.assign(job, { state: "paused", current: null, finishedAt, message: "Stopped. Start again to continue where it left off." });
  } else {
    Object.assign(job, { state: "done", current: null, finishedAt, message: job.failed.length ? `Done — ${job.failed.length} series had no data (${job.failed.slice(0, 5).join(", ")}${job.failed.length > 5 ? "…" : ""}).` : "Done — everything is stored." });
  }
}
