import { DAY_MS } from "@/core/market/session";
import type { DailyBar } from "@/core/types";

// Sector strength from sector indices. The Market Data Hub serves NSE's
// indices (NIFTY IT, NIFTY Auto…) with daily history from NSE's index file
// (2012 on), and for the years or sectors no real index covers, synthetic
// equal-weight baskets of today's members (EW-IT…): survivorship-biased
// stand-ins, never to be shown as NSE indices. For each industry the screener
// uses the first NSE index whose history reaches back as far as the stocks'
// (so the measure means the same thing across the whole window), else the
// basket — labelled synthetic wherever it is shown. Pure.

export interface IndexEntry {
  symbol: string;
  name: string;
  synthetic: boolean;
  /** First and last stored session (day keys), null when the hub holds none. */
  firstDay: number | null;
  lastDay: number | null;
}

export interface IndexCatalog {
  /** False until the hub has answered (or with a hub that has no GET /v1/indices). */
  available: boolean;
  indices: IndexEntry[];
  sectors: Array<{ industry: string; indices: string[]; basket: string }>;
}

export interface SectorSource {
  symbol: string;
  name: string;
  synthetic: boolean;
}

/** A stored series this stale (days behind the newest in the catalogue) isn't used. */
const STALE_DAYS = 10;

/**
 * Which series measures each industry's strength: the first NSE index with
 * history from `needFrom` (a day key), else the basket when it reaches that far,
 * else whichever of them starts earliest (an NSE index on a tie).
 */
export function sectorSources(catalog: IndexCatalog, industries: Iterable<string>, needFrom: number): Map<string, SectorSource> {
  const out = new Map<string, SectorSource>();
  if (!catalog.available) return out;
  const bySymbol = new Map(catalog.indices.map((entry) => [entry.symbol, entry]));
  const newest = Math.max(0, ...catalog.indices.map((entry) => entry.lastDay ?? 0));
  const usable = (entry: IndexEntry | undefined): entry is IndexEntry & { firstDay: number } => Boolean(entry && entry.firstDay !== null && entry.lastDay !== null && newest - entry.lastDay <= STALE_DAYS * DAY_MS);
  for (const industry of new Set(industries)) {
    const sector = catalog.sectors.find((entry) => entry.industry === industry);
    if (!sector) continue;
    const candidates = [...sector.indices, sector.basket].map((symbol) => bySymbol.get(symbol)).filter(usable);
    if (!candidates.length) continue;
    const pick = candidates.find((entry) => entry.firstDay <= needFrom) ?? [...candidates].sort((a, b) => a.firstDay - b.firstDay || Number(a.synthetic) - Number(b.synthetic))[0];
    out.set(industry, { symbol: pick.symbol, name: pick.name, synthetic: pick.synthetic });
  }
  return out;
}

export interface SectorIndexStat extends SectorSource {
  /** % change over the last 21 and 63 sessions (NaN without enough history). */
  ret21: number;
  ret63: number;
  /** 63-session return minus NIFTY's over the same sessions, in points (NaN when they can't be lined up). */
  vsNifty63: number;
  /** Day key of the newest bar used. */
  asOf: number | null;
}

const change = (bars: DailyBar[], sessions: number) => (bars.length > sessions && bars[bars.length - 1 - sessions].c > 0 ? (bars[bars.length - 1].c / bars[bars.length - 1 - sessions].c - 1) * 100 : Number.NaN);

/** Returns of a sector's series and its strength against NIFTY over the same sessions. */
export function sectorIndexStat(source: SectorSource, bars: DailyBar[], nifty: DailyBar[]): SectorIndexStat {
  const ret21 = change(bars, 21);
  const ret63 = change(bars, 63);
  let vsNifty63 = Number.NaN;
  if (Number.isFinite(ret63)) {
    const byDay = new Map(nifty.map((bar) => [bar.t, bar.c]));
    const end = byDay.get(bars[bars.length - 1].t);
    const start = byDay.get(bars[bars.length - 64].t);
    if (end && start) vsNifty63 = ret63 - (end / start - 1) * 100;
  }
  return { ...source, ret21, ret63, vsNifty63, asOf: bars.at(-1)?.t ?? null };
}

/** Rank (0 weakest – 1 strongest) of each key by value; non-finite values aren't ranked. */
export function strengthRanks(values: Map<string, number>): Map<string, number> {
  const ranked = [...values].filter(([, value]) => Number.isFinite(value)).sort((a, b) => a[1] - b[1]);
  return new Map(ranked.map(([key], index) => [key, ranked.length > 1 ? index / (ranked.length - 1) : 0.5]));
}
