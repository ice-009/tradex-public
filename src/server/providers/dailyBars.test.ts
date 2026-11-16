import { describe, expect, it } from "vitest";
import type { HubCandle, HubCandlesBatch } from "@/server/providers/hub/client";
import { DEEP_HISTORY_DAYS, DailyBarStore, RETRY_AFTER_MS, type StoredSeries } from "./dailyBars";

// The screener's daily bars from the hub's batch candles. A scripted hub and an
// in-memory disk; the clock is fixed at 10:00 IST on Tue 10 Nov 2026.

const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 10, 10);
const NOW = TODAY + 4.5 * 3_600_000; // 10:00 IST
const TARGET = TODAY - DEEP_HISTORY_DAYS * DAY;

const candle = (t: number, c: number, dp: number | null = null): HubCandle => ({ t, o: c, h: c + 1, l: c - 1, c, v: 100, dp });
/** `n` daily candles ending yesterday (weekends included: the store doesn't care). */
const candles = (n: number, close = 100) => Array.from({ length: n }, (_, index) => candle(TODAY - (n - index) * DAY, close));

type Series = HubCandlesBatch["series"][string];
const series = (list: HubCandle[], extra: Partial<Series> = {}): Series => ({ complete: true, coverage: list.length ? { from: list[0].t, to: list.at(-1)!.t + DAY } : null, candles: list, ...extra });

function setup(answers: Array<(symbols: string[], from: number) => Partial<HubCandlesBatch>>) {
  const clock = { now: NOW };
  const disk = new Map<string, StoredSeries>();
  const asked: Array<{ symbols: string[]; from: number }> = [];
  const store = new DailyBarStore({
    now: () => clock.now,
    batch: async (symbols, from) => {
      asked.push({ symbols, from });
      const answer = answers.shift();
      if (!answer) throw new Error("unexpected batch request");
      return { tf: "1d", from, to: clock.now, series: {}, queued: [], unknown: [], ...answer(symbols, from) };
    },
    read: async (symbol) => disk.get(symbol) ?? null,
    write: async (symbol, stored) => void disk.set(symbol, stored),
  });
  return { store, disk, asked, clock };
}

describe("DailyBarStore", () => {
  it("reads 5 years for new symbols in one batch, then only the last week", async () => {
    const { store, disk, asked, clock } = setup([
      () => ({ series: { SBIN: series([...candles(300), candle(TODAY, 105)]), NIFTY: series(candles(300, 24_000)) } }),
      () => ({ series: { SBIN: series([candle(TODAY - DAY, 100, 55.5)]), NIFTY: series([]) } }),
    ]);
    await store.sync(["SBIN", "NIFTY"]);
    expect(asked[0]).toEqual({ symbols: ["SBIN", "NIFTY"], from: TARGET });
    expect(store.getBars("SBIN")).toHaveLength(300); // today's forming bar is left to the live overlay
    expect(disk.get("SBIN")).toMatchObject({ coveredFrom: TARGET });
    expect(store.progress).toMatchObject({ phase: "done", queued: 0 });

    clock.now += 20 * 60_000;
    await store.sync(["SBIN", "NIFTY"]);
    expect(asked[1]).toEqual({ symbols: ["SBIN", "NIFTY"], from: TODAY - DAY - 7 * DAY });
    expect(store.getBars("SBIN").at(-1)).toMatchObject({ t: TODAY - DAY, c: 100, dp: 55.5 });
  });

  it("uses what the hub has while it downloads queued symbols, says so, and asks again in 30 s", async () => {
    const { store, disk, asked, clock } = setup([
      () => ({ series: { SBIN: series(candles(250)), NEWCO: series(candles(20), { complete: false }) }, queued: ["NEWCO"] }),
      () => ({ series: { NEWCO: series(candles(400)) } }),
      () => ({ series: { SBIN: series([]), NEWCO: series([]) } }),
    ]);
    await store.sync(["SBIN", "NEWCO"]);
    expect(store.getBars("NEWCO")).toHaveLength(20);
    expect(disk.has("NEWCO")).toBe(false); // partial: not saved
    expect(store.progress.queued).toBe(1);
    expect(store.progress.message).toMatch(/the hub is downloading 1 symbol/);

    store.ensureFresh(["SBIN", "NEWCO"]); // nothing new and no retry due yet
    expect(asked).toHaveLength(1);
    clock.now += RETRY_AFTER_MS;
    store.ensureFresh(["SBIN", "NEWCO"]);
    await store.sync([]); // wait for the background sync
    expect(asked[1]).toEqual({ symbols: ["NEWCO"], from: TARGET }); // only the incomplete one is read in full
    expect(store.getBars("NEWCO")).toHaveLength(400);
    expect(disk.get("NEWCO")).toMatchObject({ coveredFrom: TARGET });
    expect(store.progress.queued).toBe(0);
  });

  it("re-reads a symbol in full when a stored close moved (split or bonus)", async () => {
    const { store, asked, clock } = setup([
      () => ({ series: { SBIN: series(candles(30, 200)) } }),
      () => ({ series: { SBIN: series([candle(TODAY - 3 * DAY, 100)]) } }),
      () => ({ series: { SBIN: series(candles(30, 100)) } }),
    ]);
    await store.sync(["SBIN"]);
    clock.now += 20 * 60_000;
    await store.sync(["SBIN"]);
    expect(asked.map((entry) => entry.from)).toEqual([TARGET, TODAY - DAY - 7 * DAY, TARGET]);
    expect(store.getBars("SBIN").every((bar) => bar.c === 100)).toBe(true);
  });

  it("counts a stock missing only today's bar before NSE's evening file as complete", async () => {
    const { store, disk } = setup([() => ({ series: { SBIN: series(candles(400), { complete: false, coverage: { from: TARGET, to: TODAY } }) } })]);
    await store.sync(["SBIN"]);
    expect(disk.get("SBIN")).toMatchObject({ coveredFrom: TARGET });
  });

  it("reports the hub's broker warning and unknown symbols, and an unreachable hub as an error", async () => {
    const { store, clock } = setup([
      () => ({ series: { SBIN: series(candles(10), { complete: false, coverage: { from: TODAY - 10 * DAY, to: TODAY } }) }, unknown: ["BADCO"], warning: "Today's broker budget is used up.", reason: "budget" }),
      () => {
        throw new Error("Market Data Hub network error: fetch failed");
      },
    ]);
    await store.sync(["SBIN", "BADCO"]);
    expect(store.progress.message).toMatch(/1 symbol incomplete: Today's broker budget is used up/);
    expect(store.progress.message).toMatch(/1 symbol unknown to the hub \(BADCO\)/);
    clock.now += 20 * 60_000;
    await store.sync(["SBIN", "BADCO"]);
    expect(store.progress).toMatchObject({ phase: "error", message: expect.stringMatching(/network error/) });
    expect(store.getBars("SBIN")).toHaveLength(10); // kept what it had
  });

  it("reads an older cache file without coverage in full once", async () => {
    const { store, disk, asked } = setup([() => ({ series: { SBIN: series(candles(1200)) } })]);
    disk.set("SBIN", { coveredFrom: null, bars: candles(250).map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })) });
    expect(await store.hasData(["SBIN"])).toBe(true);
    await store.sync(["SBIN"]);
    expect(asked[0].from).toBe(TARGET);
    expect(store.getBars("SBIN")).toHaveLength(1200);
  });
});
