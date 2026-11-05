import "server-only";

import { screenerStore } from "@/server/providers/dailyStore";
import type { DataSource } from "@/server/data/types";

// End-of-day store: the daily bars the screener keeps on disk (a broker
// backfill, extended every evening from NSE's bhavcopy). No API calls, so it's
// the fallback when the broker is down or out of budget: real daily candles
// (about a year) and the last close as a delayed quote.

export const eodSource: DataSource = {
  id: "eod",
  label: "NSE end-of-day",
  kind: "eod",

  unavailable: async () => null,

  history: {
    supports: (interval) => interval === "1d",
    cacheable: false,
    async fetch(request) {
      await screenerStore.hasData([request.symbol]);
      const candles = screenerStore
        .getBars(request.symbol)
        .filter((bar) => bar.t >= request.from)
        .map((bar) => ({ date: new Date(bar.t).toISOString(), open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v }));
      return { candles, complete: true };
    },
  },

  quotes: {
    delayed: true,
    async fetch(symbols) {
      await screenerStore.hasData(symbols);
      return symbols.flatMap((symbol) => {
        const bars = screenerStore.getBars(symbol);
        const last = bars.at(-1);
        const prev = bars.at(-2);
        if (!last || !prev) return [];
        const ch = last.c - prev.c;
        return [{ symbol, ltp: last.c, ch, chp: (ch / prev.c) * 100, open: last.o, high: last.h, low: last.l, prevClose: prev.c, volume: last.v }];
      });
    },
  },
};
