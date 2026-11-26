import "server-only";

import type { SectorContext, SectorSeriesInput } from "@/core/lab/sectorSignals";
import { hashBars, withDataPart, type DataStamp } from "@/core/repro/stamp";
import { RS_BENCHMARK, RS_BENCHMARK_STAND_IN, longSectorSources, spliceSector } from "@/core/sector/series";
import type { DailyBar } from "@/core/types";
import { asOf, orElse } from "@/server/providers/asOf";
import { sectorLongBars } from "@/server/providers/longStore";
import type { ResearchData } from "./backtest";

// The sector series a Signal Lab sector signal reads (issue #30;
// src/core/lab/sectorSignals.ts): per industry, its NSE sector index with the
// hub's synthetic equal-weight basket spliced in front (src/core/sector/series.ts),
// and NIFTY 500 (its basket before 2012) as the relative-strength benchmark —
// read from the hub over the same span as the stocks' bars. The industry map
// and the index catalogue come through asOf: today's classification (no
// history of it is stored), said in the report's notes. The series' content
// hashes join the run's data stamp, so a replay that reads different sector
// data says so.

export class LabSectorError extends Error {}

export interface LabSectors {
  context: SectorContext;
  /** The research data's stamp with the sector series added. */
  data: DataStamp;
  notes: string[];
}

const isoDay = (day: number) => new Date(day).toISOString().slice(0, 10);

export async function labSectors(research: Pick<ResearchData, "symbols" | "dates" | "data">): Promise<LabSectors> {
  const today = await asOf();
  const catalog = orElse(today.sectors, { available: false, indices: [], sectors: [] });
  const industries = orElse(today.industries, new Map<string, string>());
  if (!catalog.available) throw new LabSectorError("Sector signals need the Market Data Hub's index catalogue (GET /v1/indices), which isn't available.");
  if (!industries.size) throw new LabSectorError("Sector signals need the industry classification (NSE's index lists), which isn't loaded.");
  const from = research.dates[0];
  const to = research.dates.at(-1);
  if (from === undefined || to === undefined) throw new LabSectorError("No sessions to read sector data for.");

  const plans = longSectorSources(catalog);
  const wanted = [...new Set([...plans.flatMap((plan) => [plan.index, plan.basket]), RS_BENCHMARK, RS_BENCHMARK_STAND_IN].filter((symbol): symbol is string => Boolean(symbol)))];
  const set = await sectorLongBars.load(wanted, from, to);
  const bars = (symbol: string) => set.bars.get(symbol)?.filter((bar) => bar.t <= to);

  const series = new Map<string, SectorSeriesInput>();
  for (const plan of plans) {
    const spliced = spliceSector(plan, bars);
    if (spliced) series.set(plan.industry, spliced);
  }
  const benchmark = spliceSector({ index: RS_BENCHMARK, basket: RS_BENCHMARK_STAND_IN }, bars);
  if (!benchmark) throw new LabSectorError("The Market Data Hub has no NIFTY 500 history (nor its basket) for this period.");

  const sectorOf = (symbol: string) => {
    const industry = industries.get(symbol);
    return industry && series.has(industry) ? industry : null;
  };

  // The stamp: which series each industry used, their content, and the industry of every stock ranked.
  const used: Record<string, string> = {};
  for (const symbol of wanted) {
    const read = bars(symbol);
    if (read?.length) used[symbol] = hashBars(read as DailyBar[]);
  }
  const data = withDataPart(research.data, "sectors", {
    sources: plans.map((plan) => [plan.industry, plan.index, plan.basket]),
    bars: used,
    industries: research.symbols.map((symbol) => [symbol, industries.get(symbol) ?? null]),
  });

  const unclassified = research.symbols.filter((symbol) => !sectorOf(symbol));
  const synthetic = [...series].filter(([, entry]) => entry.syntheticUntil !== null);
  const throughout = synthetic.filter(([, entry]) => entry.syntheticUntil! >= to - 10 * 86_400_000);
  const before = synthetic.length - throughout.length;
  const parts = [
    ...(before ? [`for ${before} sector${before === 1 ? "" : "s"} before their NSE index's history (February 2012)`] : []),
    ...(throughout.length ? [`for ${throughout.map(([industry]) => industry).join(", ")} throughout (no NSE index covers 2012 on)`] : []),
  ];
  const notes = [
    `Sectors: ${series.size} industries (NSE's classification as of today — its history isn't stored). Sector series: ${[...series].map(([industry, entry]) => `${industry} = ${entry.label}`).join("; ")}. Relative strength against ${benchmark.label}.`,
    ...(parts.length ? [`Synthetic equal-weight baskets of today's members (survivorship-biased) stand in ${parts.join(" and ")}. Run with synthetic = 0 for NSE index data only.`] : []),
    ...(benchmark.syntheticUntil !== null ? [`NIFTY 500 up to ${isoDay(benchmark.syntheticUntil)} is the hub's equal-weight NIFTY 500 basket (synthetic).`] : []),
    ...(unclassified.length ? [`${unclassified.length} of ${research.symbols.length} stocks have no sector (no industry in today's lists, or an industry no series covers) and are left out: ${unclassified.slice(0, 8).join(", ")}${unclassified.length > 8 ? "…" : ""}.`] : []),
    ...(set.missing.length ? [`The hub had no history for ${set.missing.join(", ")} in this period.`] : []),
  ];
  return { context: { sectorOf, series, benchmark }, data, notes };
}
