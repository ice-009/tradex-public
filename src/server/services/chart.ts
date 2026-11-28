import "server-only";

import { aggregateDaily } from "@/core/market/aggregate";
import { hasOlderBars, olderWindow } from "@/core/market/olderBars";
import { CHART_INTERVAL_CONFIG, CHART_RANGE_DAYS, clampRangeForInterval, isChartInterval, isChartRange, type ChartInterval, type ChartRange } from "@/core/market/intervals";
import type { ChartResponse } from "@/contracts/api";
import { dataEngine } from "@/server/data";
import type { BaseInterval } from "@/server/data/types";
import { END_OF_DAY_INTRADAY } from "@/server/data/sources/hub";
import { hubEndOfDayNow } from "@/server/providers/hub";
import { corporateActionMarkers } from "@/server/services/corporateActions";
import { barsThrough, dayLabel } from "@/core/reference/timeMachine";
import { dailyCandlesThrough, replayBlock, scalesOn, type PastDay } from "@/server/services/timeMachine";
import { priceScales } from "@/server/providers/asOf";

// Candle history for a chart from the Market Data Hub (src/server/data). With
// no hub configured, or the hub unreachable, the chart gets labelled sample
// candles and the reason; a reachable hub that can't serve a symbol gets an
// error instead, never sample candles that look real. A hub without a broker
// (end-of-day data) has no intraday candles: those charts say why instead.
//
// Hub prices are adjusted for splits and bonuses (DEFAULT_ADJUST,
// market-data-hub#20); daily and longer charts also get markers at the
// ex-dates in range, so an adjusted gap-free series still shows where one was.
//
// The Time Machine (`past`, issue #31): the chart ends at that day's close —
// no later bar, daily or intraday — and its prices are adjusted only for the
// splits and bonuses with an ex-date on or before it (asOf's price scale), so
// a stock shows the price it traded at then. Indicators run on these bars only.

const DAY_MS = 24 * 60 * 60 * 1000;
/** The hub keeps a year of intraday candles (30 days of 1-minute ones). */
const INTRADAY_DAYS = 365;
/** A replay reads intraday bars this far ahead of the day (the browser reveals them a bar at a time). */
const INTRADAY_AHEAD_DAYS = 14;
/** Index symbols: never adjusted, so no split/bonus note for them. */
const INDEX = /^(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY|INDIAVIX|SENSEX)/;

export async function getChart(email: string, params: { symbol?: string | null; interval?: string | null; range?: string | null; from?: string | null; to?: string | null }, past: PastDay | null = null): Promise<ChartResponse> {
  const symbol = String(params.symbol ?? "TCS").trim().toUpperCase();
  const interval: ChartInterval = isChartInterval(params.interval ?? "") ? (params.interval as ChartInterval) : "15m";
  const range = clampRangeForInterval(interval, isChartRange(params.range ?? "") ? (params.range as ChartRange) : "5d");

  // Weekly and monthly candles are built from daily ones.
  const unit = CHART_INTERVAL_CONFIG[interval].unit;
  const aggregate = unit === "weeks" || unit === "months" ? unit : null;
  const base: BaseInterval = aggregate ? "1d" : (interval as BaseInterval);
  // Older bars for a daily-based chart scrolled to its left edge: from..to (epoch ms), back to NSE's first session.
  const older = base === "1d" ? olderWindow(params.from, params.to) : null;
  // A past day's chart ends at its close and reaches back its range from there.
  const end = past ? past.day : Date.now();
  const from = older?.from ?? end - CHART_RANGE_DAYS[range] * DAY_MS;
  if (past && base !== "1d" && Date.now() - past.day > INTRADAY_DAYS * DAY_MS) {
    const error = `The Market Data Hub keeps a year of intraday candles: ${dayLabel(past.day)} is before them. Pick D, W or M.`;
    return { symbol, interval, range, source: "broker", sourceId: null, sourceReason: null, error, priceSeries: [], asOf: { day: past.day, notes: [], priceScale: null } };
  }

  const engine = dataEngine();
  const hubs = engine.sources.filter((source) => source.kind === "broker" && source.history);
  const hubReady = async () => (await Promise.all(hubs.map((source) => engine.unavailable(source, email)))).some((reason) => reason === null);
  const [ready, endOfDay] = await Promise.all([hubReady(), hubEndOfDayNow()]);
  if (ready && !hubs.some((source) => source.history!.supports(base))) {
    const error = endOfDay && base !== "1d" ? `${END_OF_DAY_INTRADAY} Pick D, W or M.` : `The Market Data Hub doesn't serve ${interval} candles.`;
    return { symbol, interval, range, source: "broker", sourceId: null, sourceReason: null, error, priceSeries: [] };
  }
  // A replay (#32) reads ahead of the day, so the browser can reveal the next bars one at a time without asking again:
  // through the replay block (two weeks of intraday bars), never across a split or bonus (the prices stay the day's).
  const cut = past?.replay && !older ? await aheadThrough(symbol, past.day, base === "1d" ? replayBlock(past.day).to : Math.min(replayBlock(past.day).to, past.day + INTRADAY_AHEAD_DAYS * DAY_MS)) : (past?.day ?? null);
  // A past day's daily chart is read up to that day (as the Time Machine's screener and quotes are), not to today:
  // the hub lines up its NSE archive with the broker's prices only when a request reaches into the broker's window.
  const pastDaily = past && cut !== null && ready && base === "1d" && hubs[0] ? { candles: await dailyCandlesThrough(cut, symbol, from), source: { id: hubs[0].id, label: hubs[0].label, kind: hubs[0].kind }, skipped: [] as string[] } : null;
  let answer = pastDaily ?? (await engine.history({ symbol, interval: base, from, email, ...(ready ? { kinds: ["broker"] as const } : {}) }));
  if (!answer.source && ready) {
    // The hub failed. Unreachable (now resting): fall back to labelled sample data. Reachable: say what went wrong.
    if (await hubReady()) {
      return { symbol, interval, range, source: "broker", sourceId: null, sourceReason: null, error: `Couldn't load ${interval} candles for ${symbol}. ${answer.skipped.join(" · ") || "No data."}`, priceSeries: [] };
    }
    const skipped = answer.skipped;
    answer = await engine.history({ symbol, interval: base, from, email });
    answer = { ...answer, skipped: [...skipped, ...answer.skipped] };
  }
  // Time Machine: nothing after the day's close, re-expressed as adjusted then (before weekly/monthly bars are built).
  const through = past ? await asOfCandles(symbol, answer.candles, past, cut ?? past.day) : null;
  const daily = through?.candles ?? answer.candles;
  const all = aggregate ? aggregateDaily(daily, aggregate) : daily;
  // An older chunk is only the bars before what the chart already has.
  const candles = older ? all.filter((candle) => Date.parse(candle.date) < older.to) : all;
  const first = engine.sources.find((source) => source.history?.supports(base));
  const fromHub = answer.source?.id === "hub";
  const markers = fromHub && base === "1d" ? await corporateActionMarkers(symbol, Math.min(from, candles[0] ? Date.parse(candles[0].date) : from)) : [];
  // A past day's chart marks only the splits and bonuses that had happened by then.
  const corporateActions = markers.filter((marker) => (!older || marker.time < older.to) && (!past || marker.time <= (cut ?? past.day)));
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
    // Daily-based hub charts: older bars may exist when these reach back to (about) where they were asked from.
    hasOlder: fromHub && base === "1d" && hasOlderBars(all, from),
    ...(through ? { asOf: through.info } : {}),
  };
}

/**
 * Candles up to a past day's close — or, for a replay, up to `cut` (a later day: the browser reveals them a bar at a
 * time) — with prices adjusted only for the splits and bonuses by the day.
 */
async function asOfCandles(symbol: string, candles: ChartResponse["priceSeries"], past: PastDay, cut: number) {
  const kept = barsThrough(candles, cut, (candle) => Date.parse(candle.date));
  const index = INDEX.test(symbol);
  const { scaleOf, note } = index ? { scaleOf: () => 1, note: null } : await scalesOn(past.day, [symbol]);
  const scale = scaleOf(symbol);
  const scaled = scale === 1 ? kept : kept.map((candle) => ({ ...candle, open: candle.open * scale, high: candle.high * scale, low: candle.low * scale, close: candle.close * scale, volume: candle.volume / scale }));
  const notes = [past.note, note].filter((line): line is string => Boolean(line));
  return { candles: scaled, info: { day: past.day, notes, priceScale: note ? null : scale, ...(cut > past.day ? { aheadThrough: cut } : {}) } };
}

/**
 * The last day up to `to` with the same price scale as `day` (a split or bonus after `day` changes the prices of
 * everything before it): a replay's read-ahead stops before one, so revealed bars are those a later day's own chart shows.
 */
async function aheadThrough(symbol: string, day: number, to: number): Promise<number> {
  if (INDEX.test(symbol) || to <= day) return Math.max(day, to);
  const scaleOn = async (t: number) => {
    const fact = (await priceScales(t, [symbol])).get(symbol);
    return fact?.known ? fact.value : null;
  };
  const base = await scaleOn(day);
  if (base === null) return day;
  if ((await scaleOn(to)) === base) return to;
  // The scale only changes at ex-dates: find the last day before the first one.
  let lo = day;
  let hi = to;
  while (hi - lo > DAY_MS) {
    const mid = lo + Math.floor((hi - lo) / DAY_MS / 2) * DAY_MS;
    if ((await scaleOn(mid)) === base) lo = mid;
    else hi = mid;
  }
  return lo;
}
