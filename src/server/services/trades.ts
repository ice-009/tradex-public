import "server-only";

import type { TradeCloseRequest, TradeCreateRequest, TradeDto, TradesResponse, TradeUpdateRequest } from "@/contracts/api";
import { COST_PRESETS } from "@/core/backtest/costs";
import { istDayKey } from "@/core/market/session";
import { EXIT_REASONS, journalSummary, plannedExitPrice, type ExitReason } from "@/core/plan/journal";
import { trackTrade, type TradeTrack } from "@/core/plan/tracker";
import { SCREEN_MAP } from "@/core/screener/screens";
import { prisma } from "@/server/db/prisma";
import { screenerStore } from "@/server/providers/dailyStore";

// The trade journal: trades you took from the daily plan, per signed-in user
// (Prisma model `Trade`). Open trades are tracked against the screener's
// stored daily bars (no API calls); the browser re-checks them on live prices.

/** A request the journal can't accept (shown to the user as is). */
export class TradeInputError extends Error {}

type Row = Awaited<ReturnType<typeof prisma.trade.findFirstOrThrow>>;

const toDto = (row: Row): TradeDto => ({
  id: row.id,
  symbol: row.symbol,
  screenId: row.screenId,
  side: "long",
  plannedEntry: row.plannedEntry,
  stop: row.stop,
  target: row.target,
  exitRule: row.exitRule,
  holdSessions: row.holdSessions,
  entryPrice: row.entryPrice,
  entryAt: row.entryAt.getTime(),
  entryDay: istDayKey(row.entryAt.getTime()),
  lots: row.lots,
  lotSize: row.lotSize,
  quantity: row.quantity,
  status: row.status === "closed" ? "closed" : "open",
  exitPrice: row.exitPrice,
  exitAt: row.exitAt?.getTime() ?? null,
  exitReason: (row.exitReason as ExitReason | null) ?? null,
  plannedExit: row.plannedExit,
  notes: row.notes,
  createdAt: row.createdAt.getTime(),
});

async function userId(email: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new TradeInputError("Sign in again: your account wasn't found.");
  return user.id;
}

const price = (value: unknown, label: string): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TradeInputError(`${label} must be a positive price.`);
  return Math.round(n * 100) / 100;
};
const optionalPrice = (value: unknown, label: string): number | null => (value === null || value === undefined || value === "" ? null : price(value, label));
const whole = (value: unknown, label: string, max: number): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new TradeInputError(`${label} must be a whole number from 1 to ${max}.`);
  return n;
};
const time = (value: unknown): Date => {
  if (value === undefined || value === null || value === "") return new Date();
  const n = Number(value);
  if (!Number.isFinite(n) || n < Date.UTC(2000, 0, 1) || n > Date.now() + 24 * 60 * 60 * 1000) throw new TradeInputError("That date isn't valid.");
  return new Date(n);
};
const text = (value: unknown, max = 2000): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const EXIT_RULE = /^(next-open|stop-target|time|trail-low:\d{1,2})$/;

export async function listTrades(email: string, now = Date.now()): Promise<TradesResponse> {
  const rows = await prisma.trade.findMany({ where: { userId: await userId(email) }, orderBy: { entryAt: "desc" } });
  const trades = rows.map(toDto);
  const open = trades.filter((trade) => trade.status === "open");
  await screenerStore.hasData([...new Set(trades.map((trade) => trade.symbol))]);
  const tracks: Record<string, TradeTrack> = {};
  for (const trade of open) tracks[trade.id] = trackTrade(trade, screenerStore.getBars(trade.symbol), now);
  // A trade closed during the session has no stored open/close to compare with yet: fill it in once the bar is stored.
  for (const trade of trades) {
    if (trade.status !== "closed" || trade.plannedExit !== null || trade.exitAt === null || !trade.exitReason) continue;
    const day = istDayKey(trade.exitAt);
    trade.plannedExit = plannedExitPrice(trade.exitReason, trade, screenerStore.getBars(trade.symbol).find((bar) => bar.t === day) ?? null);
  }
  const closed = trades.flatMap((trade) =>
    trade.status === "closed" && trade.exitPrice !== null
      ? [{ screenId: trade.screenId, plannedEntry: trade.plannedEntry, stop: trade.stop, entryPrice: trade.entryPrice, exitPrice: trade.exitPrice, plannedExit: trade.plannedExit, quantity: trade.quantity }]
      : [],
  );
  return { trades, tracks, journal: journalSummary(closed, COST_PRESETS["futures-2026"].model) };
}

export async function createTrade(email: string, body: unknown): Promise<TradeDto> {
  const raw = (body ?? {}) as Partial<Record<keyof TradeCreateRequest, unknown>>;
  const symbol = String(raw.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9&_-]{1,30}$/.test(symbol)) throw new TradeInputError("Pick a stock.");
  const screenId = String(raw.screenId ?? "");
  if (!SCREEN_MAP[screenId]) throw new TradeInputError("Unknown setup.");
  const plannedEntry = price(raw.plannedEntry, "Planned entry");
  const stop = price(raw.stop, "Stop");
  if (stop >= plannedEntry) throw new TradeInputError("The stop must be below the entry (long trades only for now).");
  const target = optionalPrice(raw.target, "Target");
  const exitRule = String(raw.exitRule ?? "");
  if (!EXIT_RULE.test(exitRule)) throw new TradeInputError("Unknown exit rule.");
  const lots = whole(raw.lots, "Lots", 1000);
  const lotSize = whole(raw.lotSize, "Lot size", 1_000_000);
  const row = await prisma.trade.create({
    data: {
      userId: await userId(email),
      symbol,
      screenId,
      side: "long",
      plannedEntry,
      stop,
      target,
      exitRule,
      holdSessions: whole(raw.holdSessions, "Holding period", 250),
      entryPrice: price(raw.entryPrice, "Fill price"),
      entryAt: time(raw.entryAt),
      lots,
      lotSize,
      quantity: lots * lotSize,
      notes: text(raw.notes),
    },
  });
  return toDto(row);
}

async function owned(email: string, id: string): Promise<Row> {
  const row = await prisma.trade.findFirst({ where: { id, userId: await userId(email) } });
  if (!row) throw new TradeInputError("That trade wasn't found.");
  return row;
}

export async function updateTrade(email: string, id: string, body: unknown): Promise<TradeDto> {
  const row = await owned(email, id);
  const raw = (body ?? {}) as Partial<Record<keyof TradeUpdateRequest, unknown>>;
  const data: Record<string, unknown> = {};
  if (raw.entryPrice !== undefined) data.entryPrice = price(raw.entryPrice, "Fill price");
  if (raw.entryAt !== undefined) data.entryAt = time(raw.entryAt);
  if (raw.lots !== undefined) {
    data.lots = whole(raw.lots, "Lots", 1000);
    data.quantity = (data.lots as number) * row.lotSize;
  }
  if (raw.stop !== undefined) data.stop = price(raw.stop, "Stop");
  if (raw.target !== undefined) data.target = optionalPrice(raw.target, "Target");
  if (raw.notes !== undefined) data.notes = text(raw.notes);
  if (((data.stop as number | undefined) ?? row.stop) >= row.plannedEntry) throw new TradeInputError("The stop must be below the planned entry.");
  return toDto(await prisma.trade.update({ where: { id: row.id }, data }));
}

export async function closeTrade(email: string, id: string, body: unknown): Promise<TradeDto> {
  const row = await owned(email, id);
  if (row.status === "closed") throw new TradeInputError("That trade is already closed.");
  const raw = (body ?? {}) as Partial<Record<keyof TradeCloseRequest, unknown>>;
  const reason = String(raw.reason ?? "manual") as ExitReason;
  if (!EXIT_REASONS.some((entry) => entry.id === reason)) throw new TradeInputError("Unknown exit reason.");
  const exitAt = time(raw.exitAt);
  if (exitAt < row.entryAt) throw new TradeInputError("The exit can't be before the entry.");
  // The plan's own exit price for slippage: the stop / target, or that session's stored open / close.
  await screenerStore.hasData([row.symbol]);
  const day = istDayKey(exitAt.getTime());
  const bar = screenerStore.getBars(row.symbol).find((entry) => entry.t === day) ?? null;
  const notes = text(raw.notes);
  return toDto(
    await prisma.trade.update({
      where: { id: row.id },
      data: {
        status: "closed",
        exitPrice: price(raw.exitPrice, "Exit price"),
        exitAt,
        exitReason: reason,
        plannedExit: plannedExitPrice(reason, row, bar),
        ...(notes ? { notes: row.notes ? `${row.notes}\n${notes}` : notes } : {}),
      },
    }),
  );
}

export async function deleteTrade(email: string, id: string): Promise<void> {
  const row = await owned(email, id);
  await prisma.trade.delete({ where: { id: row.id } });
}
