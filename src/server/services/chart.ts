import "server-only";

import { aggregateDaily } from "@/core/market/aggregate";
import { CHART_INTERVAL_CONFIG, CHART_RANGE_DAYS, clampRangeForInterval, isChartInterval, isChartRange, type ChartInterval, type ChartRange } from "@/core/market/intervals";
import type { ChartResponse } from "@/contracts/api";
import { dataEngine } from "@/server/data";
import type { BaseInterval } from "@/server/data/types";
import { END_OF_DAY_INTRADAY } from "@/server/data/sources/hub";
import { hubEndOfDayNow } from "@/server/providers/hub";
import { corporateActionMarkers } from "@/server/services/corporateActions";

// Candle history for a chart from the Market Data Hub (src/server/data). With
// no hub configured, or the hub unreachable, the chart gets labelled sample
// candles and the reason; a reachable hub that can't serve a symbol gets an
// error instead, never sample candles that look real. A hub without a broker
// (end-of-day data) has no intraday candles: those charts say why instead.
//
// Hub prices are adjusted for splits and bonuses (DEFAULT_ADJUST,
// market-data-hub#20); daily and longer charts also get markers at the
// ex-dates in range, so an adjusted gap-free series still shows where one was.

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getChart(email: string, params: { symbol?: string | null; interval?: string | null; range?: string | null }): Promise<ChartResponse> {
  const symbol = String(params.symbol ?? "TCS").trim().toUpperCase();
  const interval: ChartInterval = isChartInterval(params.interval ?? "") ? (params.interval as ChartInterval) : "15m";
  const range = clampRangeForInterval(interval, isChartRange(params.range ?? "") ? (params.range as ChartRange) : "5d");

  // Weekly and monthly candles are built from daily ones.
  const unit = CHART_INTERVAL_CONFIG[interval].unit;
  const aggregate = unit === "weeks" || unit === "months" ? unit : null;
  const base: BaseInterval = aggregate ? "1d" : (interval as BaseInterval);
  const from = Date.now() - CHART_RANGE_DAYS[range] * DAY_MS;

  const engine = dataEngine();
  const hubs = engine.sources.filter((source) => source.kind === "broker" && source.history);
  const hubReady = async () => (await Promise.all(hubs.map((source) => engine.unavailable(source, email)))).some((reason) => reason === null);
  const [ready, endOfDay] = await Promise.all([hubReady(), hubEndOfDayNow()]);
  if (ready && !hubs.some((source) => source.history!.supports(base))) {
    const error = endOfDay && base !== "1d" ? `${END_OF_DAY_INTRADAY} Pick D, W or M.` : `The Market Data Hub doesn't serve ${interval} candles.`;
    return { symbol, interval, range, source: "broker", sourceId: null, sourceReason: null, error, priceSeries: [] };
  }
  let answer = await engine.history({ symbol, interval: base, from, email, ...(ready ? { kinds: ["broker"] as const } : {}) });
  if (!answer.source && ready) {
    // The hub failed. Unreachable (now resting): fall back to labelled sample data. Reachable: say what went wrong.
    if (await hubReady()) {
      return { symbol, interval, range, source: "broker", sourceId: null, sourceReason: null, error: `Couldn't load ${interval} candles for ${symbol}. ${answer.skipped.join(" · ") || "No data."}`, priceSeries: [] };
    }
    const skipped = answer.skipped;
    answer = await engine.history({ symbol, interval: base, from, email });
    answer = { ...answer, skipped: [...skipped, ...answer.skipped] };
  }
  const candles = aggregate ? aggregateDaily(answer.candles, aggregate) : answer.candles;
  const first = engine.sources.find((source) => source.history?.supports(base));
  const fromHub = answer.source?.id === "hub";
  const corporateActions = fromHub && base === "1d" ? await corporateActionMarkers(symbol, Math.min(from, candles[0] ? Date.parse(candles[0].date) : from)) : [];
  return {
    symbol,
    interval,
    range,
    source: answer.source?.kind ?? "sample",
    sourceId: answer.source?.id ?? null,
    // Explain a fallback: no hub configured, or why it was passed over.
    sourceReason:
      answer.source?.kind === "sample" && !hubs.length
        ? "No Market Data Hub is configured (HUB_URL, HUB_KEY)."
        : answer.source && answer.source.id !== first?.id
          ? answer.skipped.join(" · ") || null
          : answer.source
            ? null
            : answer.skipped.join(" · ") || "No data source answered.",
    priceSeries: candles,
    adjust: fromHub ? "split" : null,
    corporateActions,
  };
}
