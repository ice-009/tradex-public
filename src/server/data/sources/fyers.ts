import "server-only";

import { prisma } from "@/server/db/prisma";
import { getFyersAccessToken } from "@/server/providers/fyers/auth";
import { BudgetExhaustedError, fyersPlan } from "@/server/providers/fyers/budget";
import { downloadFyersHistory, fetchFyersQuotes, fyersHistoryCacheKey, fyersHistoryWindowDays, getFyersTokenFailureReason } from "@/server/providers/fyers/client";
import { fyersStream, type LiveTick } from "@/server/providers/fyers/stream";
import { SourceSkip, type DataSource } from "@/server/data/types";

// Fyers (broker): intraday + daily history, batch quotes and a live socket.
// Every call is charged to the Fyers request budget (providers/fyers/budget.ts);
// when today's budget is spent the engine moves on to the next source.

/** The deployment's TOTP login, else the signed-in user's own Fyers login. */
async function token(email?: string | null): Promise<string | null> {
  const shared = await getFyersAccessToken();
  if (shared) return shared;
  if (!email) return null;
  const user = await prisma.user.findUnique({ where: { email }, select: { brokerAccessToken: true } });
  return user?.brokerAccessToken ?? null;
}

/** Budget exhaustion isn't a fault: pass to the next source without resting Fyers. */
async function budgeted<T>(job: () => Promise<T>): Promise<T> {
  try {
    return await job();
  } catch (error) {
    if (error instanceof BudgetExhaustedError) throw new SourceSkip(error.message);
    throw error;
  }
}

export const fyersSource: DataSource = {
  id: "fyers",
  label: "Fyers",
  kind: "broker",

  async unavailable(context) {
    const current = await token(context?.email);
    if (!current) return "not connected (add the FYERS_* settings to .env, or connect your account)";
    return getFyersTokenFailureReason(current) ?? null;
  },

  history: {
    supports: () => true,
    windowDays: (interval) => fyersHistoryWindowDays(interval),
    cacheable: true,
    cacheKey: (symbol, interval) => fyersHistoryCacheKey(symbol, interval),
    async fetch(request) {
      const current = await token(request.email);
      if (!current) throw new SourceSkip("not connected");
      return budgeted(() => downloadFyersHistory(request.symbol, request.interval, request.from, current));
    },
  },

  quotes: {
    delayed: false,
    async fetch(symbols) {
      const current = await token();
      if (!current) throw new SourceSkip("not connected");
      return budgeted(() => fetchFyersQuotes(symbols, current));
    },
  },

  stream: {
    get maxSymbols() {
      return fyersPlan().limits.socketSymbols;
    },
    start: () => fyersStream().ensureStarted(),
    isConnected: () => fyersStream().isConnected(),
    subscribe: (symbols) => fyersStream().subscribe(symbols),
    restart: (reason) => fyersStream().restart(reason),
    unsubscribe: (symbols) => fyersStream().unsubscribe(symbols),
    onTick(listener) {
      const forward = (tick: LiveTick) =>
        listener({
          symbol: tick.symbol,
          ltp: tick.ltp,
          ch: tick.ch,
          chp: tick.chp,
          volume: tick.volume,
          open: tick.open,
          high: tick.high,
          low: tick.low,
          prevClose: tick.prevClose,
          ltt: tick.ltt,
          ts: tick.ts,
        });
      fyersStream().addListener(forward);
      return () => fyersStream().removeListener(forward);
    },
  },
};
