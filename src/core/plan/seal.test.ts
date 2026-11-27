import { describe, expect, it } from "vitest";
import { canonicalJson } from "@/core/repro/canonical";
import { makeStamp, type DataStamp } from "@/core/repro/stamp";
import type { ScreenerRow } from "@/core/screener/screens";
import { DEFAULT_PLAN_SETTINGS, rankCandidates, type PlanInput } from "./builder";
import type { EvidenceBucket, ScreenEvidence } from "./evidence";
import { GENESIS_HASH, chainEntry, checkAnchors, compareToSeal, entryHash, ledgerGaps, sealablePlan, verifyLedger, type LedgerRecord, type SealInput } from "./seal";

// The sealed plan (#33): the same inputs always seal to the same hash, the
// sealed plan doesn't depend on anyone's sizing, and the chain catches every
// edit, insertion and deletion.

const bucket = (mean: number, eligible: boolean): EvidenceBucket => ({
  n: 500,
  days: 300,
  mean,
  t: eligible ? 4 : 0.5,
  first: { n: 300, mean },
  last: { n: 200, mean },
  splitDate: 0,
  recent: { n: 100, mean: mean / 2 },
  costR: 0.05,
  score: { top: 0.3, mid: 0.2, bottom: 0.1, t: 0.5, ranks: false },
  eligible,
});
const evidence = (id: string, mean: number, eligible: boolean): ScreenEvidence => ({ screenId: id, all: bucket(mean, eligible), up: bucket(mean, eligible), down: bucket(mean, eligible), verdict: eligible ? "any" : "none" });
const row = (symbol: string, entry: number, stop: number, extra: Partial<ScreenerRow> = {}): ScreenerRow =>
  ({ symbol, name: symbol, industry: "", date: 0, live: true, close: entry, changePct: 1, volRatio: 2, deliveryPct: null, rsi14: 60, rsRank: 80, score: 50, tags: [], plan: { entry, stop, target: null, exit: "" }, ...extra }) as ScreenerRow;

const DAY = Date.UTC(2026, 10, 24);
const EVIDENCE = { "pos-turtle-adx": evidence("pos-turtle-adx", 0.33, true), "btst-closing-strength": evidence("btst-closing-strength", 0.08, true), "swing-nr7": evidence("swing-nr7", -0.2, false) };
const RESULTS = {
  "pos-turtle-adx": [row("CCC", 1000, 950), row("AAA", 200.1234567890123, 190)],
  "btst-closing-strength": [row("BBB", 100, 98), row("BIG", 40_000, 30_000)],
  "swing-nr7": [row("DDD", 100, 98)],
};
const LOTS = { AAA: 100, BBB: 500, CCC: 50, DDD: 100, BIG: 1000 };

const sealInput = (patch: Partial<SealInput> = {}): SealInput => ({ day: DAY, kind: "close", live: true, eodDate: DAY - 86_400_000, results: RESULTS, evidence: EVIDENCE, state: "up", banned: new Set(), lots: LOTS, ...patch });

const DATA: DataStamp = { hash: "d".repeat(64), parts: { bars: "b".repeat(64) }, symbols: ["AAA", "BBB"], benchmark: "NIFTY", from: DAY - 1_000 * 86_400_000, to: DAY, sessions: 1_000, bars: 2_000, membership: null, hub: null };
const stampOf = (plan: unknown, createdAt = 1) => makeStamp({ kind: "plan", code: { commit: "abc", engine: "seal/1" }, data: DATA, params: { day: DAY }, result: plan, createdAt });

function chain(days: number): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = DAY + i * 86_400_000;
    for (const kind of ["close", "final"] as const) {
      const plan = sealablePlan(sealInput({ day, kind }));
      records.push(chainEntry(records.at(-1) ?? null, { day, kind, sealedAt: day + 1, plan, stamp: stampOf(plan) }));
    }
  }
  return records;
}

/** A stored copy: what the ledger's body column holds, read back. */
const stored = (records: LedgerRecord[]) => records.map((record) => JSON.parse(canonicalJson(record)) as LedgerRecord);

describe("sealing a plan", () => {
  it("seals the ranked candidates before sizing, with the default book as a reference", () => {
    const plan = sealablePlan(sealInput());
    expect(plan.ideas.map((idea) => [idea.rank, idea.symbol, idea.screenId])).toEqual([
      [1, "AAA", "pos-turtle-adx"],
      [2, "CCC", "pos-turtle-adx"],
      [3, "BBB", "btst-closing-strength"],
      [4, "BIG", "btst-closing-strength"],
    ]);
    expect(plan.eligible).not.toContain("swing-nr7");
    // ₹5,000 at risk per trade: one lot of BIG risks ₹1 crore.
    expect(plan.reference.settings).toEqual(DEFAULT_PLAN_SETTINGS);
    expect(plan.reference.take.map((take) => take.symbol)).toEqual(["AAA", "CCC", "BBB"]);
    expect(plan.reference.tooBig).toEqual(["BIG"]);
  });

  it("gives the same plan and hash for the same inputs, in any key order", () => {
    const a = sealablePlan(sealInput());
    const reordered = Object.fromEntries(Object.entries(RESULTS).reverse());
    const b = sealablePlan(sealInput({ results: reordered, lots: Object.fromEntries(Object.entries(LOTS).reverse()) }));
    expect(canonicalJson(b)).toBe(canonicalJson(a));
    const first = chainEntry(null, { day: DAY, kind: "close", sealedAt: 5, plan: a, stamp: stampOf(a) });
    const second = chainEntry(null, { day: DAY, kind: "close", sealedAt: 5, plan: b, stamp: stampOf(b) });
    expect(second.hash).toBe(first.hash);
    expect(first.prevHash).toBe(GENESIS_HASH);
    // A different input is a different hash.
    const other = sealablePlan(sealInput({ banned: new Set(["AAA"]) }));
    expect(chainEntry(null, { day: DAY, kind: "close", sealedAt: 5, plan: other, stamp: stampOf(other) }).hash).not.toBe(first.hash);
  });

  it("hashes the same after a round trip through storage (numbers as canonical JSON rounds them)", () => {
    const [record] = chain(1);
    const [copy] = stored([record]);
    expect(entryHash(copy)).toBe(record.hash);
    expect(copy.plan.ideas[0].entry.price).toBe(200.123456789);
  });
});

describe("verifying the ledger", () => {
  it("passes an untouched chain, and a stored copy of it", () => {
    const records = chain(3);
    expect(verifyLedger(records)).toMatchObject({ ok: true, count: 6, firstBad: null, head: { seq: 6, hash: records[5].hash } });
    expect(verifyLedger(stored(records)).ok).toBe(true);
    expect(verifyLedger([]).ok).toBe(true);
  });

  it("verifies a slice from the record before it", () => {
    const records = chain(3);
    expect(verifyLedger(records.slice(2), records[1]).ok).toBe(true);
    expect(verifyLedger(records.slice(2), records[0]).ok).toBe(false);
  });

  it("detects an edited entry", () => {
    const records = stored(chain(3));
    records[2].plan.ideas[0].stop = 1;
    const result = verifyLedger(records);
    expect(result.ok).toBe(false);
    expect(result.firstBad).toBe(3);
    expect(result.problems.map((problem) => problem.kind)).toContain("hash");
  });

  it("detects an edited entry whose hash was recomputed (the next link breaks)", () => {
    const records = stored(chain(3));
    records[2].plan.ideas[0].stop = 1;
    records[2].stamp.resultHash = "x";
    records[2].hash = entryHash(records[2]);
    const kinds = verifyLedger(records).problems.map((problem) => [problem.seq, problem.kind]);
    expect(kinds).toContainEqual([3, "result"]);
    expect(kinds).toContainEqual([4, "link"]);
  });

  it("detects a rewritten history even when every hash and link is redone, against published anchors", () => {
    const records = stored(chain(2));
    const anchors = records.map((record) => ({ seq: record.seq, hash: record.hash }));
    // Rewrite #2 onwards and re-chain them: the chain alone is consistent again…
    const rewritten: LedgerRecord[] = [records[0]];
    for (const record of records.slice(1)) {
      const plan = { ...record.plan, ideas: record.plan.ideas.slice(1) };
      rewritten.push(chainEntry(rewritten.at(-1)!, { day: record.day, kind: record.kind, sealedAt: record.sealedAt, plan, stamp: stampOf(plan) }));
    }
    expect(verifyLedger(rewritten).ok).toBe(true);
    // …but not against the hashes published outside it.
    const check = checkAnchors(rewritten, anchors);
    expect(check.ok).toBe(false);
    expect(check.problems).toHaveLength(3);
    // A ledger cut short loses published entries.
    expect(checkAnchors(records.slice(0, 2), anchors).problems[0]).toMatch(/missing/);
    expect(checkAnchors(records, anchors).ok).toBe(true);
  });

  it("detects an inserted entry", () => {
    const records = chain(2);
    const plan = sealablePlan(sealInput({ day: DAY + 10 * 86_400_000 }));
    const forged = chainEntry(records[1], { day: DAY, kind: "close", sealedAt: 9, plan, stamp: stampOf(plan) });
    const result = verifyLedger([...records.slice(0, 2), forged, ...records.slice(2)]);
    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.kind)).toEqual(expect.arrayContaining(["result", "duplicate", "seq", "link"]));
  });

  it("detects a deleted entry, in the middle and at the start", () => {
    const records = chain(3);
    const middle = verifyLedger([...records.slice(0, 2), ...records.slice(3)]);
    expect(middle.problems.map((problem) => [problem.seq, problem.kind])).toEqual([
      [4, "seq"],
      [4, "link"],
    ]);
    expect(middle.problems[0].message).toMatch(/1 entry is missing/);
    expect(verifyLedger(records.slice(1)).problems.map((problem) => problem.kind)).toEqual(["seq", "link"]);
  });

  it("detects entries swapped out of order", () => {
    const records = chain(2);
    const swapped = [records[0], records[2], records[1], records[3]];
    const kinds = new Set(verifyLedger(swapped).problems.map((problem) => problem.kind));
    expect(kinds).toEqual(new Set(["seq", "link", "order"]));
  });

  it("lists trading days with no seal since the first one", () => {
    const records = chain(2);
    const days = [DAY - 86_400_000, DAY, DAY + 86_400_000, DAY + 2 * 86_400_000, DAY + 3 * 86_400_000];
    expect(ledgerGaps(records, days, DAY + 3 * 86_400_000, "close")).toEqual([DAY + 2 * 86_400_000, DAY + 3 * 86_400_000]);
    expect(ledgerGaps(records, days, DAY + 86_400_000, "final")).toEqual([]);
    expect(ledgerGaps([], days, DAY, "close")).toEqual([]);
  });
});

describe("live plan vs the sealed one", () => {
  it("says what was added, dropped and changed since the seal", () => {
    const sealed = sealablePlan(sealInput());
    const liveInput: Omit<PlanInput, "settings"> = {
      results: { "pos-turtle-adx": [row("CCC", 1010, 950)], "btst-closing-strength": [row("BBB", 100, 98), row("NEW", 100, 97)] },
      evidence: EVIDENCE,
      state: "up",
      banned: new Set(["BIG"]),
      open: [],
      lots: { ...LOTS, NEW: 100 },
      prices: {},
    };
    const live = { ...rankCandidates(liveInput), state: "up" as const };
    const drift = compareToSeal(sealed, live);
    expect(drift.added).toEqual([{ symbol: "NEW", screenId: "btst-closing-strength" }]);
    expect(drift.dropped).toEqual([
      { symbol: "AAA", screenId: "pos-turtle-adx", why: "no longer matches" },
      { symbol: "BIG", screenId: "btst-closing-strength", why: "no longer matches" },
    ]);
    expect(drift.changed).toEqual([{ symbol: "CCC", what: "entry 1000 → 1010" }]);
    expect(drift.same).toBe(false);
    expect(compareToSeal(sealed, { ...rankCandidates({ ...liveInput, results: RESULTS, banned: new Set() }), state: "up" }).same).toBe(true);
  });

  it("says why a sealed idea dropped when its plan no longer holds", () => {
    const sealed = sealablePlan(sealInput());
    // AAA's stop broken at the live price; BIG banned since.
    const live = { ...rankCandidates({ results: RESULTS, evidence: EVIDENCE, state: "up", banned: new Set(["BIG"]), open: [], lots: LOTS, prices: { AAA: 185 } }), state: "down" as const };
    const drift = compareToSeal(sealed, live);
    expect(drift.dropped.find((item) => item.symbol === "AAA")?.why).toMatch(/stop/i);
    expect(drift.dropped.find((item) => item.symbol === "BIG")?.why).toBe("now in the F&O ban");
    expect(drift.stateChanged).toBe(true);
  });
});
