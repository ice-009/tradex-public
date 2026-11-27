import "server-only";

import type { RiskReturnsResponse } from "@/contracts/api";
import { ARCHIVE_START } from "@/core/backtest/phases";
import { spliceBenchmark } from "@/core/market/longHistory";
import { DAY_MS } from "@/core/market/session";
import { dayLabel } from "@/core/reference/timeMachine";
import { RISK_LOOKBACK, alignedReturns } from "@/core/risk/returns";
import type { DailyBar } from "@/core/types";
import { asOf, orElse } from "@/server/providers/asOf";
import { screenerStore } from "@/server/providers/dailyStore";
import { BENCHMARK_STAND_IN } from "@/server/providers/longBars";
import { BENCHMARK } from "@/server/services/screener";
import { pastBars, storeBarsThrough, storeCovers, type PastDay } from "@/server/services/timeMachine";

// Daily returns for the plan's risk model (issue #40): the open trades' and
// the plan's ideas' last RISK_LOOKBACK sessions, lined up on NIFTY's, from the
// screener's stored daily bars (no hub request when they are stored). In the
// Time Machine, bars up to that day's close only — from the store when it
// reaches back far enough, else the hub's long history read for the day, as
// the screener does (src/server/services/timeMachine.ts).

/** Most stocks in one request (open trades + the ideas the plan shows). */
export const MAX_RISK_SYMBOLS = 40;
/** Calendar days of bars to read for RISK_LOOKBACK sessions, with room for holidays. */
const WINDOW_DAYS = Math.ceil(RISK_LOOKBACK * 1.6) + 20;
const NIFTY_FILE_START = Date.UTC(2012, 1, 1);
/** How long a Time Machine request waits for the hub's bars before answering "syncing" (the browser polls). */
const PAST_WAIT_MS = 1_500;
/** Rounded to 1e-6 (0.0001%) to keep the answer small. */
const round = (value: number | null) => (value === null ? null : Math.round(value * 1e6) / 1e6);

/** Industry per stock from the F&O and Nifty 500 lists (today's classification: NSE's lists don't keep history). */
async function industries(symbols: readonly string[]): Promise<Record<string, string>> {
  const known = await asOf();
  const out: Record<string, string> = {};
  for (const id of ["fno", "nifty500"]) {
    for (const member of orElse(known.universe(id), [])) if (symbols.includes(member.symbol) && !out[member.symbol] && member.industry) out[member.symbol] = member.industry;
  }
  return out;
}

export async function riskReturns(symbols: readonly string[], past: PastDay | null): Promise<RiskReturnsResponse> {
  const list = [...new Set(symbols)].slice(0, MAX_RISK_SYMBOLS);
  if (!list.length) return { status: "ready", sessions: [], benchmark: [], returns: {}, industries: {}, missing: [], notes: [] };
  const notes: string[] = [];
  let barsOf: (symbol: string) => readonly DailyBar[];
  let benchmark: readonly DailyBar[];
  if (!past) {
    const wanted = [...list, BENCHMARK];
    screenerStore.ensureFresh(wanted);
    await screenerStore.hasData(wanted);
    barsOf = (symbol) => screenerStore.getBars(symbol);
    benchmark = screenerStore.getBars(BENCHMARK);
  } else {
    const from = Math.max(ARCHIVE_START, past.day - WINDOW_DAYS * DAY_MS);
    const wanted = [...list, BENCHMARK, ...(from < NIFTY_FILE_START ? [BENCHMARK_STAND_IN] : [])];
    let set;
    if (storeCovers(from)) set = await storeBarsThrough(past.day, wanted);
    else {
      const handle = pastBars(past.day, wanted, from);
      const ready = handle.ready ?? (await Promise.race([handle.promise.catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), PAST_WAIT_MS))]));
      if (!ready) {
        const again = pastBars(past.day, wanted, from);
        return again.error ? { status: "error", error: again.error } : { status: "syncing", progress: again.progress };
      }
      set = ready;
    }
    const spliced = spliceBenchmark(set.bars.get(BENCHMARK) ?? [], set.bars.get(BENCHMARK_STAND_IN) ?? []);
    if (spliced.standInUntil !== null && spliced.standInUntil >= past.day - WINDOW_DAYS * DAY_MS) notes.push(`NIFTY before ${dayLabel(spliced.standInUntil)} is the hub's equal-weight NIFTY 50 basket (NSE's index file starts in 2012).`);
    barsOf = (symbol) => set.bars.get(symbol) ?? [];
    benchmark = spliced.bars;
    notes.push(`Returns up to the close of ${dayLabel(past.day)}.`);
  }
  const through = past?.day;
  const series = alignedReturns(new Map(list.map((symbol) => [symbol, barsOf(symbol)])), benchmark, { lookback: RISK_LOOKBACK, through });
  const missing = list.filter((symbol) => !series.returns[symbol]?.some((value) => value !== null));
  if (!benchmark.length) notes.push("No NIFTY bars: beta to NIFTY can't be measured.");
  return {
    status: "ready",
    sessions: series.sessions,
    benchmark: series.benchmark.map(round),
    returns: Object.fromEntries(Object.entries(series.returns).map(([symbol, values]) => [symbol, values.map(round)])),
    industries: await industries(list),
    missing,
    notes,
  };
}
