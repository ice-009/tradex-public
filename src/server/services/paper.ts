import "server-only";

import type { PaperResponse, PaperTakeRequest, PaperTradeDto } from "@/contracts/api";
import { COST_PRESETS, type CostPresetId } from "@/core/backtest/costs";
import { DAY_MS } from "@/core/market/session";
import type { EntryKind } from "@/core/plan/instructions";
import { gradePaper, summarizePaper } from "@/core/plan/paper";
import { dayLabel } from "@/core/reference/timeMachine";
import { SCREEN_MAP } from "@/core/screener/screens";
import type { DailyBar } from "@/core/types";
import { prisma } from "@/server/db/prisma";
import { RequestError } from "@/server/http";
import { replayBars, scaleBars, scalesOn, storeBarsThrough, storeCovers, type PastBars, type PastDay } from "./timeMachine";

// Paper trading in a Time Machine replay (issue #32): plan ideas "paper taken"
// on a past day, in their own store (Prisma PaperSession / PaperTrade), never
// in the real journal (Trade). Only the order is stored — the plan's levels,
// the day, the size. Every ask grades each trade from scratch as of the day
// shown (src/core/plan/paper.ts) on the daily bars up to that day's close,
// read like the screener's (the store inside its 5 years, else the hub's long
// history; a replay's block read when stepping), with prices as adjusted on
// the day the trade was taken: its levels are in those prices, so a split or
// bonus after it doesn't move its fills.

const COST_PRESET: CostPresetId = "futures-2026";
/** Bars read before the first trade's day (holidays, the trailing exit's look-back). */
const LOOK_BACK_DAYS = 45;
const ENTRY_KINDS: readonly EntryKind[] = ["close", "buy-stop", "btst"];
const EXIT_RULE = /^(next-open|stop-target|time|trail-low:\d{1,2})$/;

type Row = Awaited<ReturnType<typeof prisma.paperTrade.findFirstOrThrow>>;

async function userId(email: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new RequestError("Sign in again: your account wasn't found.", 401);
  return user.id;
}

/** The newest open session, started on first use. */
async function currentSession(user: string) {
  const open = await prisma.paperSession.findFirst({ where: { userId: user, closedAt: null }, orderBy: { createdAt: "desc" } });
  return open ?? prisma.paperSession.create({ data: { userId: user } });
}

function needPast(past: PastDay | null): PastDay {
  if (!past) throw new RequestError("Paper trading works in the Time Machine: open a past day (the date in the top bar) and step through it.");
  return past;
}

/** Daily bars up to the day for the trades' stocks, from the first trade's day (with a look-back). */
async function barsFor(past: PastDay, symbols: string[], from: number): Promise<PastBars | null> {
  if (!symbols.length) return null;
  if (storeCovers(from)) return storeBarsThrough(past.day, symbols);
  return replayBars(past, symbols, from).promise;
}

/** The current session graded as of the day shown. */
export async function listPaper(email: string, pastDay: PastDay | null): Promise<PaperResponse> {
  const past = needPast(pastDay);
  const user = await userId(email);
  const session = await currentSession(user);
  const rows = await prisma.paperTrade.findMany({ where: { sessionId: session.id }, orderBy: [{ signalDay: "asc" }, { createdAt: "asc" }] });
  const costs = COST_PRESETS[COST_PRESET];
  const notes: string[] = [];
  const due = rows.filter((row) => row.signalDay.getTime() <= past.day);
  const set = due.length ? await barsFor(past, [...new Set(due.map((row) => row.symbol))], Math.min(...due.map((row) => row.signalDay.getTime())) - LOOK_BACK_DAYS * DAY_MS) : null;
  // Each trade in the prices of the day it was taken.
  const scaled = new Map<string, DailyBar[]>();
  for (const signalDay of new Set(due.map((row) => row.signalDay.getTime()))) {
    const symbols = [...new Set(due.filter((row) => row.signalDay.getTime() === signalDay).map((row) => row.symbol))];
    const { scaleOf, note } = await scalesOn(signalDay, symbols);
    if (note) notes.push(note);
    for (const symbol of symbols) scaled.set(`${symbol}:${signalDay}`, scaleBars(set?.bars.get(symbol) ?? [], scaleOf(symbol)));
  }
  const trades: PaperTradeDto[] = rows.map((row) => {
    const order = toOrder(row);
    const bars = scaled.get(`${row.symbol}:${order.signalDay}`) ?? [];
    return { ...order, id: row.id, expectedR: row.expectedR, lots: row.lots, lotSize: row.lotSize, createdAt: row.createdAt.getTime(), grade: gradePaper(order, bars, past.day, costs.model) };
  });
  if (trades.some((trade) => trade.grade.status === "later")) notes.push(`Trades taken after ${dayLabel(past.day)} are listed but not graded: step forward to their day.`);
  const earlier = await prisma.paperSession.findMany({ where: { userId: user, id: { not: session.id } }, orderBy: { createdAt: "desc" }, take: 10, include: { _count: { select: { trades: true } } } });
  return {
    session: { id: session.id, createdAt: session.createdAt.getTime(), name: session.name },
    day: past.day,
    trades,
    summary: summarizePaper(trades),
    costs: { preset: COST_PRESET, label: costs.label },
    earlier: earlier.map((entry) => ({ id: entry.id, createdAt: entry.createdAt.getTime(), closedAt: entry.closedAt?.getTime() ?? null, trades: entry._count.trades })),
    notes,
  };
}

function toOrder(row: Row) {
  return {
    symbol: row.symbol,
    screenId: row.screenId,
    entryKind: (ENTRY_KINDS.includes(row.entryKind as EntryKind) ? row.entryKind : "close") as EntryKind,
    plannedEntry: row.plannedEntry,
    stop: row.stop,
    target: row.target,
    exitRule: row.exitRule,
    holdSessions: row.holdSessions,
    signalDay: row.signalDay.getTime(),
    quantity: row.quantity,
  };
}

const price = (value: unknown, label: string): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new RequestError(`${label} must be a positive price.`);
  return n;
};
const whole = (value: unknown, label: string, max: number): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new RequestError(`${label} must be a whole number from 1 to ${max}.`);
  return n;
};

/** Paper-take a plan idea on the day shown: it fills (or not) by the plan's entry rule as the replay moves on. */
export async function takePaper(email: string, pastDay: PastDay | null, body: unknown): Promise<{ id: string }> {
  const past = needPast(pastDay);
  const raw = (body ?? {}) as Partial<Record<keyof PaperTakeRequest, unknown>>;
  const symbol = String(raw.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9&_-]{1,30}$/.test(symbol)) throw new RequestError("Pick a stock.");
  const screenId = String(raw.screenId ?? "");
  if (!SCREEN_MAP[screenId]) throw new RequestError("Unknown setup.");
  const entryKind = String(raw.entryKind ?? "") as EntryKind;
  if (!ENTRY_KINDS.includes(entryKind)) throw new RequestError("Unknown entry.");
  const plannedEntry = price(raw.plannedEntry, "Entry");
  const stop = price(raw.stop, "Stop");
  if (stop >= plannedEntry) throw new RequestError("The stop must be below the entry (long trades only for now).");
  const target = raw.target === null || raw.target === undefined || raw.target === "" ? null : price(raw.target, "Target");
  const exitRule = String(raw.exitRule ?? "");
  if (!EXIT_RULE.test(exitRule)) throw new RequestError("Unknown exit rule.");
  const lots = whole(raw.lots, "Lots", 1000);
  const lotSize = whole(raw.lotSize, "Lot size", 1_000_000);
  const expected = Number(raw.expectedR);
  const session = await currentSession(await userId(email));
  const duplicate = await prisma.paperTrade.findFirst({ where: { sessionId: session.id, symbol, screenId, signalDay: new Date(past.day) } });
  if (duplicate) throw new RequestError(`${symbol} is already paper-taken on ${dayLabel(past.day)}.`);
  const row = await prisma.paperTrade.create({
    data: {
      sessionId: session.id,
      symbol,
      screenId,
      entryKind,
      plannedEntry,
      stop,
      target,
      exitRule,
      holdSessions: whole(raw.holdSessions, "Holding period", 250),
      signalDay: new Date(past.day),
      lots,
      lotSize,
      quantity: lots * lotSize,
      expectedR: raw.expectedR === null || raw.expectedR === undefined || !Number.isFinite(expected) ? null : expected,
    },
  });
  return { id: row.id };
}

/** Remove a paper trade from the current session. */
export async function removePaper(email: string, id: string): Promise<void> {
  const user = await userId(email);
  const row = await prisma.paperTrade.findFirst({ where: { id, session: { userId: user } } });
  if (!row) throw new RequestError("That paper trade wasn't found.", 404);
  await prisma.paperTrade.delete({ where: { id: row.id } });
}

/** Start a new paper session (the current one is kept, closed, for its export). */
export async function newPaperSession(email: string): Promise<{ id: string }> {
  const user = await userId(email);
  await prisma.paperSession.updateMany({ where: { userId: user, closedAt: null }, data: { closedAt: new Date() } });
  const session = await prisma.paperSession.create({ data: { userId: user } });
  return { id: session.id };
}
