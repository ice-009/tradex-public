import { canonicalJson } from "@/core/repro/canonical";
import { sha256 } from "@/core/repro/sha256";
import { resultHash, type RunStamp } from "@/core/repro/stamp";
import { DEFAULT_PLAN_SETTINGS, buildPlan, rankCandidates, type PlanIdea, type PlanInput, type PlanSettings, type RankedCandidates } from "./builder";
import type { MarketState } from "./evidence";
import type { EntryKind, ExitRule } from "./instructions";

// The sealed daily plan (issue #33): a tamper-evident record of what the plan
// said, written by the server at fixed times and never changed after. Pure.
//
// What is sealed is the plan BEFORE sizing — every candidate the rules rank
// for the day, with its entry, stop, target and exit rule — not anyone's sized
// plan: sizing (capital, risk %, open trades) is a per-user preference that
// lives in the browser, and the proof must not depend on it. A reference book
// (what the default sizing, ₹5 lakh at 1% risk and 5 slots, would take with no
// trades open) is sealed with it, so grading (#34) has a fixed portfolio to
// follow as well as every idea.
//
// The ledger is a hash chain: each entry holds the previous entry's hash, and
// its own hash is SHA-256 over its canonical JSON (src/core/repro). Changing
// any old entry changes its hash, which no longer matches the next entry's
// `prevHash`; removing or inserting one breaks the sequence and the links.
// Only the newest entries can be rewritten without a trace inside the ledger
// itself — which is what publishing each day's hash somewhere outside it
// (`checkAnchors`) closes.

export const LEDGER_SCHEMA = 1;
/** Bump when what is sealed changes. */
export const SEAL_ENGINE = "seal/1";
/** `prevHash` of the first entry. */
export const GENESIS_HASH = "0".repeat(64);

/** "close": in the buy window (3:15 PM IST, live prices); "final": the evening's final daily bars, the plan of record before the next open. */
export type SealKind = "close" | "final";

export interface SealedIdea {
  rank: number;
  symbol: string;
  screenId: string;
  entry: { kind: EntryKind; price: number };
  stop: number;
  target: number | null;
  exitRule: ExitRule;
  holdSessions: number;
  /** The screen's mean net R in this market state (5-year replay). */
  expectedR: number;
  sampleN: number;
  recentR: number | null;
  recentN: number;
  /** Futures lot size used. */
  lot: number;
  /** The price the screens saw (the live bar's last price, or the day's close). */
  close: number;
  score: number;
  alsoMatched: string[];
}

export interface SealedPlan {
  /** The trading day (IST day key). */
  day: number;
  kind: SealKind;
  /** The screens read today's live bar (close seal) rather than stored daily bars only. */
  live: boolean;
  /** Newest daily session in the screens' history (day key). */
  eodDate: number;
  state: MarketState | null;
  /** Screens with a tested edge in this state, best expected R first. */
  eligible: string[];
  /** Every candidate in rank order, before sizing (nobody's trades are left out as "held"). */
  ideas: SealedIdea[];
  /** Matches whose plan no longer held at the price the screens saw. */
  invalid: Array<{ symbol: string; screenId: string; status: string; entry: number; stop: number; close: number }>;
  skipped: { banned: string[]; noLot: string[] };
  /** What the default sizing would take with no trades open: a fixed book for grading, not anyone's plan. */
  reference: { settings: PlanSettings; take: Array<{ symbol: string; lots: number; qty: number; risk: number; notional: number }>; tooBig: string[] };
}

export interface SealInput extends Omit<PlanInput, "open" | "settings"> {
  day: number;
  kind: SealKind;
  live: boolean;
  eodDate: number;
}

const sealedIdea = (idea: PlanIdea, rank: number): SealedIdea => ({
  rank,
  symbol: idea.symbol,
  screenId: idea.screenId,
  entry: { kind: idea.entry.kind, price: idea.entry.price },
  stop: idea.stop,
  target: idea.target,
  exitRule: idea.exitRule,
  holdSessions: idea.holdSessions,
  expectedR: idea.expectedR,
  sampleN: idea.sampleN,
  recentR: idea.recentR,
  recentN: idea.recentN,
  lot: idea.size.lot,
  close: idea.row.close,
  score: idea.row.score,
  alsoMatched: idea.alsoMatched,
});

/** The day's plan as sealed: ranked candidates before sizing, plus the default sizing's reference book. */
export function sealablePlan(input: SealInput): SealedPlan {
  const { day, kind, live, eodDate, ...rest } = input;
  const ranked = rankCandidates({ ...rest, open: [] });
  const book = buildPlan({ ...rest, open: [], settings: DEFAULT_PLAN_SETTINGS });
  return {
    day,
    kind,
    live,
    eodDate,
    state: input.state,
    eligible: ranked.eligible,
    ideas: ranked.candidates.map((idea, i) => sealedIdea(idea, i + 1)),
    invalid: ranked.invalid.map((idea) => ({ symbol: idea.symbol, screenId: idea.screenId, status: idea.status.kind, entry: idea.entry.price, stop: idea.stop, close: idea.row.close })),
    skipped: { banned: ranked.skipped.banned, noLot: ranked.skipped.noLot },
    reference: {
      settings: DEFAULT_PLAN_SETTINGS,
      take: book.ideas.map((idea) => ({ symbol: idea.symbol, lots: idea.size.lots, qty: idea.size.qty, risk: idea.size.risk, notional: idea.size.notional })),
      tooBig: book.unsized.map((idea) => idea.symbol),
    },
  };
}

// ------------------------------------------------------------------ the chain

export interface LedgerEntry {
  schema: typeof LEDGER_SCHEMA;
  /** 1, 2, 3, … with no gaps. */
  seq: number;
  day: number;
  kind: SealKind;
  /** When the server sealed it (epoch ms). */
  sealedAt: number;
  /** The previous entry's hash (GENESIS_HASH for the first). */
  prevHash: string;
  plan: SealedPlan;
  /** What the plan was computed from (kind "plan"); its resultHash is the plan's hash. */
  stamp: RunStamp;
}

export interface LedgerRecord extends LedgerEntry {
  /** SHA-256 of the entry's canonical JSON (every field but this one). */
  hash: string;
}

/** The entry as canonical JSON would read it back (numbers rounded as hashed), so a stored copy hashes the same. */
const normalized = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;

/** Hash of an entry (a record's own `hash` is left out). */
export function entryHash(entry: LedgerEntry | LedgerRecord): string {
  const rest: Partial<LedgerRecord> = { ...entry };
  delete rest.hash;
  return sha256(canonicalJson(rest));
}

/** The next record after `head` (null: the first), linked and hashed. */
export function chainEntry(head: Pick<LedgerRecord, "seq" | "hash"> | null, content: { day: number; kind: SealKind; sealedAt: number; plan: SealedPlan; stamp: RunStamp }): LedgerRecord {
  const entry: LedgerEntry = normalized({
    schema: LEDGER_SCHEMA,
    seq: (head?.seq ?? 0) + 1,
    day: content.day,
    kind: content.kind,
    sealedAt: content.sealedAt,
    prevHash: head?.hash ?? GENESIS_HASH,
    plan: content.plan,
    stamp: content.stamp,
  });
  return { ...entry, hash: entryHash(entry) };
}

export type ProblemKind = "hash" | "link" | "seq" | "result" | "order" | "duplicate" | "schema";

export interface LedgerProblem {
  /** The record's position in the list (0-based) and its seq as stored. */
  index: number;
  seq: number | null;
  kind: ProblemKind;
  message: string;
}

export interface LedgerVerification {
  ok: boolean;
  count: number;
  /** The newest record (what an external anchor should match). */
  head: { seq: number; hash: string; day: number; kind: SealKind } | null;
  problems: LedgerProblem[];
  /** seq of the first record that fails, null when none does. */
  firstBad: number | null;
}

const dayText = (day: number) => (Number.isFinite(day) ? new Date(day).toISOString().slice(0, 10) : "?");
const KIND_ORDER: Record<SealKind, number> = { close: 0, final: 1 };

/**
 * Check a ledger end to end: each record's hash against its content, each
 * link to the record before it, the sequence (no gaps, no repeats), that each
 * stamp's result hash is the plan's, one seal per day and kind, in time order.
 * `after`: the record before the first one given (when verifying a slice).
 */
export function verifyLedger(records: readonly LedgerRecord[], after: Pick<LedgerRecord, "seq" | "hash"> | null = null): LedgerVerification {
  const problems: LedgerProblem[] = [];
  const seen = new Set<string>();
  let prev: { seq: number; hash: string; day: number; kind: SealKind } | null = after ? { seq: after.seq, hash: after.hash, day: -Infinity, kind: "close" } : null;
  records.forEach((record, index) => {
    const seq = typeof record?.seq === "number" ? record.seq : null;
    const add = (kind: ProblemKind, message: string) => problems.push({ index, seq, kind, message });
    const label = `#${seq ?? "?"} (${dayText(record?.day)} ${record?.kind ?? "?"})`;
    if (!record || record.schema !== LEDGER_SCHEMA) add("schema", `${label}: not a ledger entry this version reads.`);
    if (entryHash(record) !== record.hash) add("hash", `${label}: its content doesn't match its hash — it was changed after it was sealed.`);
    const expectedSeq = (prev?.seq ?? 0) + 1;
    if (seq !== expectedSeq) add("seq", `${label}: expected #${expectedSeq} here — ${seq !== null && seq > expectedSeq ? `${seq - expectedSeq} entr${seq - expectedSeq === 1 ? "y is" : "ies are"} missing before it` : "an entry was inserted or repeated"}.`);
    const expectedPrev = prev?.hash ?? GENESIS_HASH;
    if (record.prevHash !== expectedPrev) add("link", `${label}: it doesn't point to the entry before it — an entry before it was removed, inserted or rewritten.`);
    if (record.stamp?.resultHash !== resultHash(record.plan)) add("result", `${label}: the plan doesn't match its run stamp's result hash.`);
    if (record.plan?.day !== record.day || record.plan?.kind !== record.kind) add("result", `${label}: the plan is for another day or kind than the entry.`);
    const key = `${record.day}:${record.kind}`;
    if (seen.has(key)) add("duplicate", `${label}: a second ${record.kind} seal for the same day.`);
    seen.add(key);
    if (prev && Number.isFinite(prev.day) && (record.day < prev.day || (record.day === prev.day && KIND_ORDER[record.kind] < KIND_ORDER[prev.kind]))) add("order", `${label}: sealed out of order (after ${dayText(prev.day)} ${prev.kind}).`);
    prev = { seq: seq ?? expectedSeq, hash: record.hash, day: record.day, kind: record.kind };
  });
  const last = records.at(-1);
  return {
    ok: problems.length === 0,
    count: records.length,
    head: last ? { seq: last.seq, hash: last.hash, day: last.day, kind: last.kind } : null,
    problems,
    firstBad: problems.length ? Math.min(...problems.map((problem) => problem.seq ?? Infinity)) : null,
  };
}

/** A seal's hash as published outside the ledger (one line of the anchor file). */
export interface LedgerAnchor {
  seq: number;
  hash: string;
  day?: number;
  kind?: SealKind;
}

/** Each published hash against the ledger: a rewritten or truncated tail shows here even when the chain itself is consistent. */
export function checkAnchors(records: readonly LedgerRecord[], anchors: readonly LedgerAnchor[]): { ok: boolean; checked: number; problems: string[] } {
  const bySeq = new Map(records.map((record) => [record.seq, record]));
  const problems: string[] = [];
  for (const anchor of anchors) {
    const record = bySeq.get(anchor.seq);
    if (!record) problems.push(`Published #${anchor.seq} (${shortHashOf(anchor.hash)}) is missing from the ledger — it was removed or the ledger was cut short.`);
    else if (record.hash !== anchor.hash) problems.push(`#${anchor.seq}: the ledger's hash ${shortHashOf(record.hash)} isn't the one published (${shortHashOf(anchor.hash)}) — the entry was rewritten.`);
  }
  return { ok: problems.length === 0, checked: anchors.length, problems };
}

const shortHashOf = (hash: string) => String(hash).slice(0, 12);

/** Trading days (from the first seal's day through `through`) with no seal of `kind`: days the server missed. */
export function ledgerGaps(records: readonly Pick<LedgerRecord, "day" | "kind">[], tradingDays: readonly number[], through: number, kind: SealKind): number[] {
  const first = records.length ? Math.min(...records.map((record) => record.day)) : null;
  if (first === null) return [];
  const sealed = new Set(records.filter((record) => record.kind === kind).map((record) => record.day));
  return tradingDays.filter((day) => day >= first && day <= through && !sealed.has(day));
}

// ------------------------------------------------------------------ live vs sealed

export interface SealDrift {
  /** Candidates in the live ranking that weren't sealed. */
  added: Array<{ symbol: string; screenId: string }>;
  /** Sealed candidates the live ranking no longer has, and why. */
  dropped: Array<{ symbol: string; screenId: string; why: string }>;
  /** Same stock, different screen or levels. */
  changed: Array<{ symbol: string; what: string }>;
  stateChanged: boolean;
  same: boolean;
}

const moved = (a: number, b: number) => Math.abs(a - b) > Math.max(0.005, Math.abs(a) * 1e-6);

/**
 * How the live plan differs from the sealed one. `live` is the ranking with no
 * trades open (rankCandidates with `open: []`), so both sides come from the
 * same rules and only the market has moved.
 */
export function compareToSeal(sealed: SealedPlan, live: RankedCandidates & { state: MarketState | null }): SealDrift {
  const now = new Map(live.candidates.map((idea) => [idea.symbol, idea]));
  const then = new Map(sealed.ideas.map((idea) => [idea.symbol, idea]));
  const invalid = new Map(live.invalid.map((idea) => [idea.symbol, idea]));
  const banned = new Set(live.skipped.banned);
  const added = live.candidates.filter((idea) => !then.has(idea.symbol)).map((idea) => ({ symbol: idea.symbol, screenId: idea.screenId }));
  const dropped = sealed.ideas
    .filter((idea) => !now.has(idea.symbol))
    .map((idea) => {
      const stale = invalid.get(idea.symbol);
      const why = stale && stale.status.kind !== "ok" ? stale.status.label : banned.has(idea.symbol) ? "now in the F&O ban" : "no longer matches";
      return { symbol: idea.symbol, screenId: idea.screenId, why };
    });
  const changed: SealDrift["changed"] = [];
  for (const [symbol, idea] of then) {
    const current = now.get(symbol);
    if (!current) continue;
    const what: string[] = [];
    if (current.screenId !== idea.screenId) what.push(`screen ${idea.screenId} → ${current.screenId}`);
    if (moved(current.entry.price, idea.entry.price)) what.push(`entry ${idea.entry.price} → ${current.entry.price}`);
    if (moved(current.stop, idea.stop)) what.push(`stop ${idea.stop} → ${current.stop}`);
    if (what.length) changed.push({ symbol, what: what.join(", ") });
  }
  const stateChanged = sealed.state !== live.state;
  return { added, dropped, changed, stateChanged, same: !added.length && !dropped.length && !changed.length && !stateChanged };
}
