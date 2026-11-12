import "server-only";

import { CHART_INTERVAL_CONFIG } from "@/core/market/intervals";
import { generateSampleIntradaySeries, generateSampleSeries } from "@/server/providers/sampleData";
import type { DataSource } from "@/server/data/types";

// Generated sample candles: the offline / demo fallback, last in line, so
// charts still draw — clearly labelled "Sample data" — when no Market Data Hub
// is configured or it can't be reached. Never real prices, never fetched from
// anywhere, and never used by the screener or backtests (they ask for real
// market data only).

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_MINUTES = 6.25 * 60;
/** The random-walk generator drifts off into nonsense over very long runs. */
const MAX_POINTS = 1500;

export const sampleSource: DataSource = {
  id: "sample",
  label: "Sample data",
  kind: "sample",

  unavailable: async () => null,

  history: {
    supports: () => true,
    cacheable: false,
    async fetch(request) {
      const tradingDays = Math.max(1, Math.round(((Date.now() - request.from) / DAY_MS) * (5 / 7)));
      const config = CHART_INTERVAL_CONFIG[request.interval];
      if (config.unit === "days") return { candles: generateSampleSeries(request.symbol.trim().toUpperCase(), tradingDays), complete: true };
      const minutes = config.unit === "hours" ? config.interval * 60 : config.interval;
      const points = Math.min(Math.floor((tradingDays * SESSION_MINUTES) / minutes), MAX_POINTS);
      return { candles: generateSampleIntradaySeries(request.symbol, minutes, Math.max(points, 40)), complete: true };
    },
  },
};
