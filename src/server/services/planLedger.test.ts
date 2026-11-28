import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAY_MS } from "@/core/market/session";
import { sealablePlan, verifyLedger, type LedgerRecord } from "@/core/plan/seal";
import { istTime, type DueSeal } from "@/core/plan/sealSchedule";
import { makeStamp } from "@/core/repro/stamp";
import type { ScreenerRow } from "@/core/screener/screens";

// The sealing job end to end on a throwaway market database, with a fake
// source in place of the hub: one seal per day and kind however often it runs,
// nothing on a holiday, an append-only table, and a chain that verifies.

const dir = mkdtempSync(path.join(tmpdir(), "tradex-plan-ledger-"));
let service: typeof import("./planLedger");
let store: typeof import("@/server/providers/planLedger");

beforeAll(async () => {
  process.env.MARKET_DB_PATH = path.join(dir, "market.db");
  service = await import("./planLedger");
  store = await import("@/server/providers/planLedger");
});

afterAll(() => {
  (globalThis as { marketDb?: { close(): void } }).marketDb?.close();
  rmSync(dir, { recursive: true, force: true });
});

const WED = Date.UTC(2026, 10, 25);
const THU = WED + DAY_MS;
const FRI = WED + 2 * DAY_MS;
const at = (day: number, hh: number, mm: number) => istTime(day, hh * 60 + mm);
/** Thursday is a holiday. */
const CALENDAR = [WED - DAY_MS, WED, FRI, FRI + 3 * DAY_MS, FRI + 4 * DAY_MS];

const row = (symbol: string, entry: number, stop: number) =>
  ({ symbol, name: symbol, industry: "", date: 0, live: true, close: entry, changePct: 1, volRatio: 2, deliveryPct: null, rsi14: 60, rsRank: 80, score: 50, tags: [], plan: { entry, stop, target: null, exit: "" } }) as unknown as ScreenerRow;
const bucket = { n: 500, days: 300, mean: 0.2, t: 4, first: { n: 300, mean: 0.2 }, last: { n: 200, mean: 0.2 }, splitDate: 0, recent: { n: 100, mean: 0.1 }, costR: 0.05, score: null, eligible: true };

function fakeSource(calls: DueSeal[], skip: (due: DueSeal) => string | null = () => null): import("./planLedger").SealSource {
  return {
    tradingDays: async () => CALENDAR,
    async build(due, now) {
      calls.push(due);
      const reason = skip(due);
      if (reason) return { skip: reason };
      const plan = sealablePlan({
        day: due.day,
        kind: due.kind,
        live: due.kind === "close",
        eodDate: due.day,
        results: { "pos-turtle-adx": [row("AAA", 100, 95)] },
        evidence: { "pos-turtle-adx": { screenId: "pos-turtle-adx", all: bucket, up: bucket, down: bucket, verdict: "any" } },
        state: "up",
        banned: new Set(),
        lots: { AAA: 100 },
      });
      const stamp = makeStamp({ kind: "plan", code: { commit: "test", engine: "seal/1" }, data: { hash: "d", parts: {}, symbols: ["AAA"], benchmark: "NIFTY", from: null, to: due.day, sessions: 1, bars: 1, membership: null, hub: null }, params: { day: due.day }, result: plan, createdAt: now });
      return { plan, stamp };
    },
    publish: null,
  };
}

describe("sealing job", () => {
  it("seals the close once, however many ticks run in the window", async () => {
    const calls: DueSeal[] = [];
    const source = fakeSource(calls);
    const made = await service.runDueSeals(at(WED, 15, 15), source);
    expect(made.map((record) => [record.seq, record.kind])).toEqual([[1, "close"]]);
    // A tick a minute later, and two at once, add nothing.
    expect(await service.runDueSeals(at(WED, 15, 16), source)).toEqual([]);
    const [a, b] = await Promise.all([service.runDueSeals(at(WED, 15, 17), source), service.runDueSeals(at(WED, 15, 17), source)]);
    expect([...a, ...b]).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(store.readLedger().map((record) => record.seq)).toEqual([1]);
  });

  it("refuses a second seal of the same day and kind at the storage level too", () => {
    const head = store.readHead()!;
    expect(store.appendSeal(head.day, head.kind, () => ({ ...head, seq: head.seq + 1 }))).toBeNull();
  });

  it("retries a final seal whose data isn't final, then seals it", async () => {
    const calls: DueSeal[] = [];
    let ready = false;
    const source = fakeSource(calls, () => (ready ? null : "The day's final daily bars aren't stored yet."));
    expect(await service.runDueSeals(at(WED, 19, 30), source)).toEqual([]);
    // Not asked again within ten minutes.
    expect(await service.runDueSeals(at(WED, 19, 35), source)).toEqual([]);
    expect(calls).toHaveLength(1);
    ready = true;
    const made = await service.runDueSeals(at(WED, 19, 41), source);
    expect(made.map((record) => [record.seq, record.day, record.kind])).toEqual([[2, WED, "final"]]);
  });

  it("makes no seal on a holiday", async () => {
    const calls: DueSeal[] = [];
    const source = fakeSource(calls);
    expect(await service.runDueSeals(at(THU, 15, 20), source)).toEqual([]);
    expect(await service.runDueSeals(at(THU, 20, 0), source)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("keeps the chain verifiable, and the table append-only", async () => {
    await service.runDueSeals(at(FRI, 15, 20), fakeSource([]));
    await service.runDueSeals(at(FRI, 19, 45), fakeSource([]));
    const records = store.readLedger();
    expect(records.map((record) => [record.seq, record.kind])).toEqual([
      [1, "close"],
      [2, "final"],
      [3, "close"],
      [4, "final"],
    ]);
    expect(verifyLedger(records).ok).toBe(true);
    const database = (globalThis as unknown as { marketDb: import("better-sqlite3").Database }).marketDb;
    expect(() => database.prepare("UPDATE plan_ledger SET body = '{}' WHERE seq = 2").run()).toThrow(/append-only/);
    expect(() => database.prepare("DELETE FROM plan_ledger WHERE seq = 2").run()).toThrow(/append-only/);
  });

  it("serves the ledger and its verification, and nothing in the Time Machine", async () => {
    const view = await service.ledgerView({ from: WED, to: null }, null, at(FRI, 20, 0));
    expect(view.status).toBe("ready");
    if (view.status !== "ready") return;
    expect(view.entries).toHaveLength(4);
    expect(view.total).toBe(4);
    expect(view.head?.seq).toBe(4);
    const slice = await service.ledgerView({ from: FRI, to: null }, null, at(FRI, 20, 0));
    if (slice.status !== "ready") throw new Error("not ready");
    expect(slice.after?.seq).toBe(2);
    expect(verifyLedger(slice.entries, slice.after).ok).toBe(true);
    const verify = await service.verifyPlanLedger(null, at(FRI, 20, 0));
    expect(verify.status === "ready" && verify.verification.ok).toBe(true);
    const past = { day: WED, requested: WED, snapped: false, note: null } as unknown as import("./timeMachine").PastDay;
    expect((await service.ledgerView({ from: null, to: null }, past)).status).toBe("past");
    expect((await service.verifyPlanLedger(past)).status).toBe("past");
  });

  it("publishes a new seal's hash only when PLAN_LEDGER_PUBLISH_CMD is set, and checks it", async () => {
    const MON = FRI + 3 * DAY_MS;
    const { publish: _off, ...withoutPublish } = fakeSource([]);
    void _off;
    // No command: nothing is published and no anchor is recorded.
    await service.runDueSeals(at(MON, 15, 20), withoutPublish);
    expect(store.readAnchors()).toEqual([]);
    const file = path.join(dir, "ledger.jsonl");
    process.env.PLAN_LEDGER_PUBLISH_CMD = `printf '%s\\n' "$SEAL_LINE" >> '${file}' && echo "$SEAL_SEQ $SEAL_KIND"`;
    try {
      const [record] = await service.runDueSeals(at(MON, 19, 45), withoutPublish);
      const line = JSON.parse(readFileSync(file, "utf8").trim()) as { seq: number; hash: string; day: string; kind: string };
      expect(line).toMatchObject({ seq: record.seq, hash: record.hash, day: "2026-11-30", kind: "final" });
      expect(store.readAnchors()).toMatchObject([{ seq: record.seq, hash: record.hash, ok: true, note: `${record.seq} final` }]);
    } finally {
      delete process.env.PLAN_LEDGER_PUBLISH_CMD;
    }
    const verify = await service.verifyPlanLedger(null, at(MON, 20, 0));
    expect(verify.status === "ready" && verify.anchors).toEqual({ checked: 1, ok: true, problems: [] });
  });

  it("detects a row rewritten behind the app's back", async () => {
    const database = (globalThis as unknown as { marketDb: import("better-sqlite3").Database }).marketDb;
    database.exec("DROP TRIGGER plan_ledger_no_update");
    const record = JSON.parse((database.prepare("SELECT body FROM plan_ledger WHERE seq = 2").get() as { body: string }).body) as LedgerRecord;
    record.plan.ideas[0].stop = 1;
    database.prepare("UPDATE plan_ledger SET body = ? WHERE seq = 2").run(JSON.stringify(record));
    const verify = await service.verifyPlanLedger(null, at(FRI, 20, 0));
    expect(verify.status === "ready" && verify.verification.firstBad).toBe(2);
  });
});
