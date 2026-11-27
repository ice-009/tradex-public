import "server-only";

import { execFile } from "node:child_process";
import type { PlanLedgerJob, PlanLedgerResponse, PlanLedgerVerifyResponse } from "@/contracts/api";
import { DAY_MS, istParts } from "@/core/market/session";
import { DEFAULT_PLAN_SETTINGS } from "@/core/plan/builder";
import type { MarketState, ScreenEvidence } from "@/core/plan/evidence";
import { SEAL_ENGINE, chainEntry, checkAnchors, ledgerGaps, sealablePlan, verifyLedger, type LedgerRecord, type SealedPlan } from "@/core/plan/seal";
import { SEAL_WINDOWS, dueSeals, isTradingDay, nextCloseSeal, type DueSeal } from "@/core/plan/sealSchedule";
import { canonicalJson } from "@/core/repro/canonical";
import { hashDataset, makeStamp, withDataPart, type DataStamp, type RunStamp } from "@/core/repro/stamp";
import type { ScreenerRow } from "@/core/screener/screens";
import type { DailyBar } from "@/core/types";
import { asOf, orElse, tradingDays } from "@/server/providers/asOf";
import { screenerStore } from "@/server/providers/dailyStore";
import { hubConfig } from "@/server/providers/hub";
import { appendSeal, countSeals, readAnchors, readBefore, readHead, readLedger, sealKey, sealedKeys, writeAnchor } from "@/server/providers/planLedger";
import { log } from "@/server/log";
import { strategyEvidence } from "./evidence";
import { codeVersion, hubVersion } from "./runStamp";
import { BENCHMARK, runScreener } from "./screener";
import type { PastDay } from "./timeMachine";

// The sealed daily plan (issue #33; rules in src/core/plan/seal.ts, times in
// src/core/plan/sealSchedule.ts). A job in the Next.js server process
// (started by src/instrumentationNode.ts) asks every minute which seals are
// due and makes them:
//
//   close   3:15–3:25 PM IST: the F&O screener on live prices (the same run the
//           browser's plan reads), the plan's evidence table, today's ban list
//           and lots → the ranked plan before sizing, stamped and appended
//   final   from 7:30 PM until the next open, once the store holds the day's
//           final daily bar: the same on stored bars only
//
// It runs only for today, never for a Time Machine day: it takes no day from
// a request and calls the screener and evidence without `past`, and the
// ledger's routes answer "live only" inside the Time Machine (a record made
// after a past day can't be part of what was known on it).
//
// Idempotent: a seal is appended only if the day has none of its kind, inside
// one write transaction (providers/planLedger.ts), so a restart, a second tick
// or a second server on the same file can't seal a day twice. Holidays come
// from the hub's calendar (/v1/calendar through asOf.tradingDays); without it,
// weekends are skipped and the job says the calendar wasn't checked.
//
// Opt-in publishing: with PLAN_LEDGER_PUBLISH_CMD set, each new seal's hash is
// handed to that shell command (SEAL_* environment variables), e.g. a commit
// to a `ledger` branch or a gist (scripts/ledger-anchor.sh). Off by default.

const TICK_MS = 60_000;
/** A close seal that couldn't be made is retried every tick inside its window; a final one this often. */
const FINAL_RETRY_MS = 10 * 60_000;
/** How long the close seal waits for the evidence table (computed in the background on first ask). */
const EVIDENCE_WAIT_MS = 4 * 60_000;
const EVIDENCE_POLL_MS = 3_000;
const PUBLISH_TIMEOUT_MS = 60_000;
const DEFAULT_RANGE_DAYS = 30;
const RECENT_ATTEMPTS = 6;

/** What the job needs from the rest of the server; tests pass their own. */
export interface SealSource {
  /** NSE trading days (day keys), or null when the hub can't say. */
  tradingDays(): Promise<readonly number[] | null>;
  /** The day's plan and its stamp, or why it can't be sealed now. */
  build(due: DueSeal, now: number): Promise<{ plan: SealedPlan; stamp: RunStamp } | { skip: string }>;
  /** Publish a new seal outside the ledger (opt-in); null when publishing is off. */
  publish?: ((record: LedgerRecord) => Promise<{ ok: boolean; note: string }>) | null;
}

type Attempt = PlanLedgerJob["recent"][number];

interface JobState {
  timer: ReturnType<typeof setInterval> | null;
  running: Promise<LedgerRecord[]> | null;
  /** Latest attempt per day+kind. */
  attempts: Map<string, Attempt>;
  calendar: boolean;
}

const globalForLedger = globalThis as unknown as { planLedgerJob?: JobState };
const job: JobState = (globalForLedger.planLedgerJob ??= { timer: null, running: null, attempts: new Map(), calendar: false });

const dayText = (day: number) => new Date(day).toISOString().slice(0, 10);

function disabledReason(): string | null {
  if (process.env.PLAN_LEDGER?.trim().toLowerCase() === "off") return "Sealing is switched off (PLAN_LEDGER=off).";
  if (!hubConfig()) return "No Market Data Hub is configured (HUB_URL / HUB_KEY), so there is no plan to seal.";
  return null;
}

/** Start the sealing job (once per process). Called from instrumentation when the server starts. */
export function startPlanLedgerJob() {
  if (job.timer) return;
  const reason = disabledReason();
  if (reason) {
    log.info("Sealed plan: job not started", { reason });
    return;
  }
  job.timer = setInterval(() => void runDueSeals().catch((error) => log.error("Sealed plan: tick failed", { error })), TICK_MS);
  job.timer.unref?.();
  log.info("Sealed plan: job started", { close: `${SEAL_WINDOWS.close.from}-${SEAL_WINDOWS.close.to}`, final: SEAL_WINDOWS.final.from, publish: Boolean(publishCommand()) });
  void runDueSeals().catch((error) => log.error("Sealed plan: tick failed", { error }));
}

/** Stop the job (tests). */
export function stopPlanLedgerJob() {
  if (job.timer) clearInterval(job.timer);
  job.timer = null;
}

/**
 * One tick: make every seal that is due at `now` and not made yet. Runs one at
 * a time (a tick that comes while one is running joins it). Returns the new records.
 */
export function runDueSeals(now = Date.now(), source: SealSource = liveSource): Promise<LedgerRecord[]> {
  job.running ??= tick(now, source).finally(() => {
    job.running = null;
  });
  return job.running;
}

async function tick(now: number, source: SealSource): Promise<LedgerRecord[]> {
  const list = await source.tradingDays().catch(() => null);
  job.calendar = Boolean(list?.length);
  const calendar = list?.length ? new Set(list) : null;
  const sealed = sealedKeys(istParts(now).day - 15 * DAY_MS);
  const due = dueSeals(now, calendar, (day, kind) => sealed.has(sealKey(day, kind)));
  const made: LedgerRecord[] = [];
  for (const seal of due) {
    const key = sealKey(seal.day, seal.kind);
    const last = job.attempts.get(key);
    if (seal.kind === "final" && last && last.outcome !== "sealed" && now - last.at < FINAL_RETRY_MS) continue;
    const record = await sealOne(seal, now, source);
    if (record) made.push(record);
  }
  return made;
}

function note(attempt: Attempt) {
  const key = sealKey(attempt.day, attempt.kind);
  const before = job.attempts.get(key);
  job.attempts.delete(key);
  job.attempts.set(key, attempt);
  while (job.attempts.size > 20) job.attempts.delete(job.attempts.keys().next().value!);
  // Log a skip once per reason, not every minute.
  if (attempt.outcome === "sealed") log.info("Sealed plan: sealed", { day: dayText(attempt.day), kind: attempt.kind });
  else if (before?.reason !== attempt.reason) (attempt.outcome === "failed" ? log.error : log.info)("Sealed plan: not sealed", { day: dayText(attempt.day), kind: attempt.kind, reason: attempt.reason });
}

async function sealOne(due: DueSeal, now: number, source: SealSource): Promise<LedgerRecord | null> {
  try {
    const built = await source.build(due, now);
    if ("skip" in built) {
      note({ ...due, outcome: "skipped", reason: built.skip, at: now });
      return null;
    }
    const record = appendSeal(due.day, due.kind, (head) => chainEntry(head, { day: due.day, kind: due.kind, sealedAt: now, plan: built.plan, stamp: built.stamp }));
    if (!record) return null;
    note({ ...due, outcome: "sealed", reason: null, at: now });
    // Only when a command is set: an anchor row means "published outside".
    const publish = source.publish === undefined ? (publishCommand() ? publishWithCommand : null) : source.publish;
    if (publish) {
      const result = await publish(record).catch((error: Error) => ({ ok: false, note: error.message }));
      writeAnchor({ seq: record.seq, hash: record.hash, at: Date.now(), ok: result.ok, note: result.note });
      if (!result.ok) log.warn("Sealed plan: publishing the hash failed", { seq: record.seq, note: result.note });
    }
    return record;
  } catch (error) {
    note({ ...due, outcome: "failed", reason: (error as Error).message, at: now });
    return null;
  }
}

// ------------------------------------------------------------------ building the day's plan (live)

type ReadyEvidence = { table: { screens: Record<string, ScreenEvidence>; lastState: MarketState | null }; stamp: RunStamp };

/** The plan's evidence table once it is ready (it is computed in the background on first ask), or why not. */
async function readyEvidence(deadline: number): Promise<ReadyEvidence | { skip: string }> {
  for (;;) {
    const evidence = await strategyEvidence();
    if (evidence.status === "ready") return { table: evidence.table, stamp: evidence.stamp };
    if (evidence.status === "error") return { skip: `The plan's evidence couldn't be computed: ${evidence.error}` };
    if (Date.now() >= deadline) return { skip: "The plan's evidence was still being computed." };
    await new Promise((resolve) => setTimeout(resolve, EVIDENCE_POLL_MS));
  }
}

/** Per-series hashes of the stored bars (the store replaces arrays, never edits them). */
const barHashes = new WeakMap<DailyBar[], string>();
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The live server's source: the F&O screener, the plan's evidence, today's lots and ban list. */
export const liveSource: SealSource = {
  tradingDays: () => tradingDays(),
  async build(due, now) {
    const today = istParts(now).day;
    if (due.kind === "close" && due.day !== today) return { skip: "A close seal is made on its own day only." };
    const evidence = await readyEvidence(now + EVIDENCE_WAIT_MS);
    if ("skip" in evidence) return evidence;
    const live = due.kind === "close";
    // Never `past`: the seal is today's live plan (the Time Machine can't reach it).
    const screener = await runScreener("fno", live, null);
    if (screener.status !== "ready" || !screener.results || !screener.asOf) return { skip: screener.status === "syncing" ? "The screener is still building its history." : `The screener has no data: ${screener.error ?? "unknown error"}` };
    if (live && !screener.asOf.live) return { skip: "No live prices from the Market Data Hub: the screens would be on yesterday's close." };
    if (!live && screener.asOf.eodDate !== due.day) return { skip: `The day's final daily bars aren't stored yet (newest ${dayText(screener.asOf.eodDate)}).` };
    const known = await asOf();
    const lots = { ...orElse(known.lots, {}) };
    const banned = screener.ban?.available ? [...screener.ban.symbols].sort() : [];
    const niftyAbove = screener.regime?.niftyAbove200;
    const state: MarketState | null = niftyAbove === true ? "up" : niftyAbove === false ? "down" : evidence.table.lastState;
    const plan = sealablePlan({ day: due.day, kind: due.kind, live, eodDate: screener.asOf.eodDate, results: screener.results, evidence: evidence.table.screens, state, banned: new Set(banned), lots });
    const data = await planData({ results: screener.results, lots, banned, state, evidence: evidence.stamp, universe: orElse(known.universe("fno"), []).map((member) => member.symbol) });
    const stamp = makeStamp({ kind: "plan", code: codeVersion(SEAL_ENGINE), data, params: { universe: "fno", kind: due.kind, day: due.day, live, reference: DEFAULT_PLAN_SETTINGS }, result: plan, createdAt: now });
    return { plan, stamp };
  },
};

/**
 * The plan's inputs, hashed: the stored daily bars of the F&O list and NIFTY,
 * lots and the list itself (as for any run), plus what the planner read on top
 * — the screener's matches (they carry the live price), the ban list, the
 * market state and the evidence table's own stamp.
 */
async function planData(input: { results: Record<string, ScreenerRow[]>; lots: Record<string, number>; banned: string[]; state: MarketState | null; evidence: RunStamp; universe: string[] }): Promise<DataStamp> {
  const bars = new Map<string, DailyBar[]>();
  for (const symbol of [...new Set([...input.universe, BENCHMARK])].sort()) {
    const series = screenerStore.getBars(symbol);
    if (series.length) bars.set(symbol, series);
  }
  let data = await hashDataset({ bars, benchmark: BENCHMARK, lots: input.lots, universe: input.universe, hub: hubVersion(), cache: barHashes, pause: yieldToEventLoop });
  data = withDataPart(data, "matches", input.results);
  data = withDataPart(data, "ban", input.banned);
  data = withDataPart(data, "state", input.state ?? "unknown");
  data = withDataPart(data, "evidence", { hash: input.evidence.hash, resultHash: input.evidence.resultHash });
  return data;
}

// ------------------------------------------------------------------ publishing (opt-in)

const publishCommand = () => process.env.PLAN_LEDGER_PUBLISH_CMD?.trim() || null;

/** Hand a new seal to PLAN_LEDGER_PUBLISH_CMD (when set), with its hash in SEAL_* environment variables. */
async function publishWithCommand(record: LedgerRecord): Promise<{ ok: boolean; note: string }> {
  const command = publishCommand();
  if (!command) return { ok: false, note: "PLAN_LEDGER_PUBLISH_CMD is not set." };
  const line = canonicalJson({ seq: record.seq, day: dayText(record.day), kind: record.kind, sealedAt: record.sealedAt, hash: record.hash, prevHash: record.prevHash });
  const env = { ...process.env, SEAL_SEQ: String(record.seq), SEAL_DAY: dayText(record.day), SEAL_KIND: record.kind, SEAL_HASH: record.hash, SEAL_PREV_HASH: record.prevHash, SEAL_LINE: line };
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { env, timeout: PUBLISH_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim().slice(-300);
      resolve(error ? { ok: false, note: `${error.message}${output ? `: ${output}` : ""}` } : { ok: true, note: output || "published" });
    });
  });
}

// ------------------------------------------------------------------ reading and verifying

const PAST_ERROR = "The sealed-plan ledger is a live record: it isn't shown in the Time Machine (seals made after the day shown would be from its future).";

function jobView(now: number, calendar: ReadonlySet<number> | null): PlanLedgerJob {
  const reason = disabledReason();
  return {
    enabled: !reason,
    reason,
    calendar: Boolean(calendar),
    nextCloseAt: reason ? null : nextCloseSeal(now, calendar),
    recent: [...job.attempts.values()].reverse().slice(0, RECENT_ATTEMPTS),
    publish: Boolean(publishCommand()),
  };
}

async function calendarSet(): Promise<ReadonlySet<number> | null> {
  const list = await tradingDays().catch(() => null);
  return list?.length ? new Set(list) : null;
}

/** The ledger's records in a range (day keys; default the last 30 days), with what verifies the slice. */
export async function ledgerView(range: { from: number | null; to: number | null }, past: PastDay | null, now = Date.now()): Promise<PlanLedgerResponse> {
  if (past) return { status: "past", error: PAST_ERROR };
  const today = istParts(now).day;
  const from = range.from ?? today - DEFAULT_RANGE_DAYS * DAY_MS;
  const entries = readLedger({ from, to: range.to });
  const before = entries.length ? readBefore(entries[0].seq) : null;
  const head = readHead();
  return {
    status: "ready",
    entries,
    after: before ? { seq: before.seq, hash: before.hash } : null,
    total: countSeals(),
    head: head ? { seq: head.seq, hash: head.hash, day: head.day, kind: head.kind } : null,
    today,
    job: jobView(now, await calendarSet()),
  };
}

/** The whole chain, end to end, and the published hashes against it. */
export async function verifyPlanLedger(past: PastDay | null, now = Date.now()): Promise<PlanLedgerVerifyResponse> {
  if (past) return { status: "past", error: PAST_ERROR };
  const records = readLedger();
  const verification = verifyLedger(records);
  const anchors = checkAnchors(
    records,
    readAnchors().filter((anchor) => anchor.ok),
  );
  const calendar = await calendarSet();
  const { day, minutes } = istParts(now);
  const days = calendar ? [...calendar].sort((a, b) => a - b) : weekdaysSince(records[0]?.day ?? day, day);
  // Today counts once its window has closed.
  const closeThrough = minutes >= SEAL_WINDOWS.close.to ? day : day - DAY_MS;
  const finalThrough = day - DAY_MS;
  return {
    status: "ready",
    verification,
    anchors: { checked: anchors.checked, ok: anchors.ok, problems: anchors.problems },
    gaps: { close: ledgerGaps(records, days, closeThrough, "close"), final: ledgerGaps(records, days, finalThrough, "final"), calendar: Boolean(calendar) },
    checkedAt: now,
  };
}

function weekdaysSince(from: number, to: number): number[] {
  const days: number[] = [];
  for (let day = from; day <= to; day += DAY_MS) if (isTradingDay(day, null)) days.push(day);
  return days;
}
