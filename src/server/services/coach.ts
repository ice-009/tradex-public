import "server-only";

import type { CoachResponse } from "@/contracts/api";
import { DAY_MS, IST_OFFSET_MS, istParts } from "@/core/market/session";
import { coachReport, type Candle, type CoachTrade, type TradeBars } from "@/core/plan/coach";
import type { EntryKind } from "@/core/plan/instructions";
import type { DailyBar } from "@/core/types";
import { dataEngine } from "@/server/data";
import { prisma } from "@/server/db/prisma";
import { log } from "@/server/log";
import { priceScales } from "@/server/providers/asOf";
import { screenerStore } from "@/server/providers/dailyStore";
import type { PastDay } from "@/server/services/timeMachine";

// The trade coach (issue #42) on a user's journal: the pure rules are in
// src/core/plan/coach.ts; this gathers what they read.
//
//   Trades   Prisma `Trade` with its `TradeChange` audit (stop and lot edits).
//   Daily    the screener's stored daily bars (providers/dailyStore, as the
//            tracker reads them), re-expressed as traded on each trade's entry
//            day with the split/bonus scale from asOf.
//   Intraday 15-minute candles from the hub (through the data engine, as the
//            chart reads them) for closed trades inside the hub's year of
//            intraday candles; older trades, or a hub without a broker, use
//            daily bounds and say why.
//
// Live only: in the Time Machine the journal is hidden and this answers
// `past`. Kept 10 minutes per user, or until a trade changes.

const INTRADAY_MINUTES = 15;
/** The hub keeps a year of intraday candles (src/server/data/sources/hub.ts hubWindowDays); a little margin at its edge. */
const INTRADAY_DAYS = 360;
const CACHE_MS = 10 * 60_000;
const ENTRY_KINDS = new Set<string>(["close", "buy-stop", "btst"]);

type Row = Awaited<ReturnType<typeof loadRows>>[number];

const cache = new Map<string, { key: string; at: number; answer: CoachResponse }>();

function loadRows(userId: string) {
  return prisma.trade.findMany({ where: { userId }, orderBy: { entryAt: "asc" }, include: { changes: { orderBy: { at: "asc" } } } });
}

const toCoachTrade = (row: Row): CoachTrade => ({
  id: row.id,
  symbol: row.symbol,
  screenId: row.screenId,
  status: row.status === "closed" ? "closed" : "open",
  plannedEntry: row.plannedEntry,
  stop: row.stop,
  target: row.target,
  exitRule: row.exitRule,
  holdSessions: row.holdSessions,
  entryKind: row.entryKind && ENTRY_KINDS.has(row.entryKind) ? (row.entryKind as EntryKind) : null,
  entryPrice: row.entryPrice,
  entryAt: row.entryAt.getTime(),
  entryTimed: row.entryTimed,
  lots: row.lots,
  planLots: row.planLots,
  exitPrice: row.exitPrice,
  exitAt: row.exitAt?.getTime() ?? null,
  audited: row.audited,
  changes: row.changes.flatMap((change) => (change.field === "stop" || change.field === "lots" ? [{ field: change.field, from: change.from, to: change.to, at: change.at.getTime() }] : [])),
});

const scaled = <T extends { o: number; h: number; l: number; c: number }>(bars: readonly T[], scale: number): T[] =>
  scale === 1 ? [...bars] : bars.map((bar) => ({ ...bar, o: bar.o * scale, h: bar.h * scale, l: bar.l * scale, c: bar.c * scale }));

/** IST midnight of a day key, epoch ms. */
const istMidnight = (day: number) => day - IST_OFFSET_MS;

/** 15-minute candles per symbol from the earliest entry asked for; or why there are none. */
async function intradayCandles(email: string, wanted: Map<string, number>): Promise<Map<string, { candles: Candle[] } | { why: string }>> {
  const out = new Map<string, { candles: Candle[] } | { why: string }>();
  const engine = dataEngine();
  const queue = [...wanted.entries()];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [symbol, from] = next;
      try {
        const answer = await engine.history({ symbol, interval: "15m", from, email, kinds: ["broker"] });
        if (answer.source && answer.candles.length) {
          out.set(symbol, { candles: answer.candles.map((point) => ({ t: Date.parse(point.date), o: point.open, h: point.high, l: point.low, c: point.close })) });
        } else {
          out.set(symbol, { why: answer.skipped.length ? `no intraday candles: ${answer.skipped.join(" · ")}` : "the hub serves no intraday candles (no broker connected)" });
        }
      } catch (error) {
        out.set(symbol, { why: `intraday candles failed: ${(error as Error).message}` });
      }
    }
  };
  // A few at a time: each is one hub request (stored at the hub; a year of 15-minute candles is ~6,000 rows).
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  return out;
}

export async function coachFor(email: string, past: PastDay | null, now = Date.now()): Promise<CoachResponse> {
  if (past) return { status: "past", error: "The trade coach reads your journal, a live record: it isn't shown in the Time Machine." };
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return { status: "error", error: "Sign in again: your account wasn't found." };
  const started = performance.now();
  const rows = await loadRows(user.id);
  const key = `${istParts(now).day}|${rows.map((row) => `${row.id}:${row.updatedAt.getTime()}:${row.changes.length}`).join(",")}`;
  const hit = cache.get(user.id);
  if (hit && hit.key === key && now - hit.at < CACHE_MS) return hit.answer;

  const trades = rows.map(toCoachTrade);
  const closed = trades.filter((trade) => trade.status === "closed" && trade.exitAt !== null);
  const symbols = [...new Set(closed.map((trade) => trade.symbol))];

  // Daily bars, as the tracker reads them; a symbol not stored yet is fetched once.
  if (symbols.length && !(await screenerStore.hasData(symbols))) {
    const missing = symbols.filter((symbol) => !screenerStore.getBars(symbol).length);
    await screenerStore.sync(missing).catch((error: Error) => log.warn("Trade coach: daily bars failed", { error: error.message }));
  }

  // Split/bonus scales on each entry and exit day.
  const days = new Map<number, Set<string>>();
  for (const trade of closed) {
    for (const day of [istParts(trade.entryAt).day, istParts(trade.exitAt!).day]) (days.get(day) ?? days.set(day, new Set()).get(day)!).add(trade.symbol);
  }
  const scales = new Map<string, { known: boolean; value: number }>();
  await Promise.all(
    [...days.entries()].map(async ([day, names]) => {
      const answer = await priceScales(day, [...names]).catch(() => new Map());
      for (const symbol of names) {
        const fact = answer.get(symbol);
        scales.set(`${symbol}:${day}`, fact?.known ? { known: true, value: fact.value as number } : { known: false, value: 1 });
      }
    }),
  );

  // Intraday candles for closed trades inside the hub's year.
  const intradayFrom = now - INTRADAY_DAYS * DAY_MS;
  const wanted = new Map<string, number>();
  for (const trade of closed) {
    if (trade.entryAt < intradayFrom) continue;
    const from = istMidnight(istParts(trade.entryAt).day);
    wanted.set(trade.symbol, Math.min(wanted.get(trade.symbol) ?? from, from));
  }
  const intraday = wanted.size ? await intradayCandles(email, wanted) : new Map<string, { candles: Candle[] } | { why: string }>();

  const bars: Record<string, TradeBars> = {};
  for (const trade of closed) {
    const entryDay = istParts(trade.entryAt).day;
    const exitDay = istParts(trade.exitAt!).day;
    const entryScale = scales.get(`${trade.symbol}:${entryDay}`) ?? { known: false, value: 1 };
    const exitScale = scales.get(`${trade.symbol}:${exitDay}`) ?? { known: false, value: 1 };
    const scale = entryScale.value;
    const daily: DailyBar[] = scaled(screenerStore.getBars(trade.symbol), scale);
    const candles = intraday.get(trade.symbol);
    const intradayWhy =
      trade.entryAt < intradayFrom ? "older than the hub's year of intraday candles" : candles && "why" in candles ? candles.why : null;
    bars[trade.id] = {
      daily,
      intraday: candles && "candles" in candles ? { minutes: INTRADAY_MINUTES, candles: scaled(candles.candles, scale) } : null,
      intradayWhy: intradayWhy ?? (entryScale.known ? null : "split/bonus factors couldn't be loaded: prices as adjusted today"),
      splitDuring: entryScale.known && exitScale.known && Math.abs(entryScale.value - exitScale.value) > 1e-9,
    };
  }

  const answer: CoachResponse = { status: "ready", report: coachReport(trades, bars, now), computedAt: now, ms: Math.round(performance.now() - started) };
  cache.set(user.id, { key, at: now, answer });
  return answer;
}
