import "server-only";

import { aggregateDaily } from "@/core/market/aggregate";
import { CHART_INTERVAL_CONFIG, CHART_RANGE_DAYS, clampRangeForInterval, isChartInterval, isChartRange, type ChartInterval, type ChartRange } from "@/core/market/intervals";
import type { ChartResponse } from "@/contracts/api";
import { dataEngine } from "@/server/data";
import type { BaseInterval } from "@/server/data/types";

// Candle history for a chart, from whichever data source answers first
// (broker → end-of-day store → sample data; see src/server/data).

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getChart(email: string, params: { symbol?: string | null; interval?: string | null; range?: string | null }): Promise<ChartResponse> {
  const symbol = String(params.symbol ?? "TCS").trim().toUpperCase();
  const interval: ChartInterval = isChartInterval(params.interval ?? "") ? (params.interval as ChartInterval) : "15m";
  const range = clampRangeForInterval(interval, isChartRange(params.range ?? "") ? (params.range as ChartRange) : "5d");

  // Weekly and monthly candles are built from daily ones.
  const unit = CHART_INTERVAL_CONFIG[interval].unit;
  const aggregate = unit === "weeks" || unit === "months" ? unit : null;
  const base: BaseInterval = aggregate ? "1d" : (interval as BaseInterval);

  const answer = await dataEngine().history({ symbol, interval: base, from: Date.now() - CHART_RANGE_DAYS[range] * DAY_MS, email });
  const candles = aggregate ? aggregateDaily(answer.candles, aggregate) : answer.candles;
  const first = dataEngine().sources.find((source) => source.history?.supports(base));
  return {
    symbol,
    interval,
    range,
    source: answer.source?.kind ?? "sample",
    sourceId: answer.source?.id ?? null,
    // Explain a fallback: why the sources before the one that answered were passed over.
    sourceReason: answer.source && answer.source.id !== first?.id ? answer.skipped.join(" · ") || null : answer.source ? null : answer.skipped.join(" · ") || "No data source answered.",
    priceSeries: candles,
  };
}
