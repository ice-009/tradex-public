import { DAY_MS } from "@/core/market/session";
import { spliceBenchmark } from "@/core/market/longHistory";
import type { IndexCatalog } from "@/core/screener/sectorIndex";
import type { DailyBar } from "@/core/types";

// One daily series per sector reaching back decades, for research (the Signal
// Lab's sector signals, issue #30). Pure.
//
// NSE's index file (the hub's index history) starts in February 2012. Before
// that the only sector history is the hub's synthetic equal-weight basket of
// TODAY's members of the industry (EW-IT…): survivorship-biased, so anything
// measured on it before 2012 is optimistic and is reported apart.
//
// Each industry gets the first of its NSE indices whose history starts with
// the index file (within INDEX_ERA_SLACK_DAYS of the catalogue's earliest
// index) — an index added later (NIFTY Capital Goods, 2026) would change what
// the series measures part-way through, so it isn't used — with the basket
// spliced in front of it (scaled to meet it on the index's first session).
// Industries with no such index use the basket throughout: synthetic on every
// day. `syntheticUntil` says up to which session a series is the basket.

export const RS_BENCHMARK = "NIFTY500";
export const RS_BENCHMARK_STAND_IN = "EW-NIFTY500";

/** An index counts as covering the index era when its history starts this close to the earliest index's. */
export const INDEX_ERA_SLACK_DAYS = 45;

export interface SectorSourcePlan {
  industry: string;
  /** The NSE index used from its first session (null: none covers the index era). */
  index: string | null;
  /** The synthetic basket used before it (or throughout). */
  basket: string | null;
}

/** Which index and basket make each industry's long series. */
export function longSectorSources(catalog: IndexCatalog): SectorSourcePlan[] {
  if (!catalog.available) return [];
  const bySymbol = new Map(catalog.indices.map((entry) => [entry.symbol, entry]));
  const real = catalog.indices.filter((entry) => !entry.synthetic && entry.firstDay !== null);
  const eraStart = real.length ? Math.min(...real.map((entry) => entry.firstDay!)) : null;
  const covers = (symbol: string) => {
    const entry = bySymbol.get(symbol);
    return Boolean(entry && !entry.synthetic && entry.firstDay !== null && eraStart !== null && entry.firstDay - eraStart <= INDEX_ERA_SLACK_DAYS * DAY_MS);
  };
  return catalog.sectors.map((sector) => {
    const basket = bySymbol.get(sector.basket);
    return {
      industry: sector.industry,
      index: sector.indices.find(covers) ?? null,
      basket: basket && basket.firstDay !== null ? sector.basket : null,
    };
  });
}

export interface LongSectorSeries {
  bars: DailyBar[];
  /** Last session taken from the synthetic basket (null: none). */
  syntheticUntil: number | null;
  /** What it's made of, for notes: "NIFTYIT (EW-IT before 2012-02-21)". */
  label: string;
}

const isoDay = (day: number) => new Date(day).toISOString().slice(0, 10);

/** The index with the basket spliced in front of it; the basket alone when there's no index. */
export function spliceSector(plan: Pick<SectorSourcePlan, "index" | "basket">, bars: (symbol: string) => readonly DailyBar[] | undefined): LongSectorSeries | null {
  const index = plan.index ? (bars(plan.index) ?? []) : [];
  const basket = plan.basket ? (bars(plan.basket) ?? []) : [];
  if (!index.length && !basket.length) return null;
  const spliced = spliceBenchmark(index, basket);
  const label = !index.length
    ? `${plan.basket} (synthetic)`
    : spliced.standInUntil !== null
      ? `${plan.index} (${plan.basket}, synthetic, before ${isoDay(index[0].t)})`
      : `${plan.index}`;
  return { bars: spliced.bars, syntheticUntil: spliced.standInUntil, label };
}
