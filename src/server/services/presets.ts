import "server-only";

import type { PresetList } from "@/contracts/api";
import { getUniverse } from "@/server/providers/universe";

/**
 * Well-known and new-age NSE names (all listed in EQUITY_L.csv as of this
 * snapshot). NSE Ltd itself is not listed, so it isn't here.
 */
const POPULAR = [
  "JIOFIN", "ETERNAL", "SWIGGY", "PAYTM", "NYKAA", "POLICYBZR", "HAL", "BEL", "IRFC",
  "IREDA", "LICI", "TMPV", "TATACAP", "HDBFS", "LGEINDIA",
];

/** Name of the default watchlist: every F&O stock. */
export const FNO_ALL = "F&O stocks (all)";

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/** F&O sector for a member; Financial Services is a quarter of F&O, so the banks are split out. */
function sectorOf(member: { name: string; industry: string }) {
  if (member.industry !== "Financial Services") return member.industry || "Other";
  return /\bbank\b/i.test(member.name) ? "Banks" : "Financials (NBFC, insurance, AMC)";
}

/** Ready-made watchlists: every F&O stock, by sector, a popular list, and Nifty 50. */
export async function getPresetLists(): Promise<PresetList[]> {
  const [fno, nifty50] = await Promise.all([getUniverse("fno"), getUniverse("nifty50")]);
  const sectors = new Map<string, string[]>();
  for (const member of fno) {
    const sector = sectorOf(member);
    sectors.set(sector, [...(sectors.get(sector) ?? []), member.symbol]);
  }
  return [
    { id: "preset-fno-all", name: FNO_ALL, group: "fno-sector", symbols: fno.map((member) => member.symbol).sort() },
    { id: "preset-popular", name: "Popular & new-age", group: "curated", symbols: POPULAR },
    { id: "preset-nifty50", name: "Nifty 50", group: "index", symbols: nifty50.map((member) => member.symbol) },
    ...[...sectors.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([sector, symbols]): PresetList => ({ id: `preset-fno-${slug(sector)}`, name: `F&O · ${sector}`, group: "fno-sector", symbols: symbols.sort() })),
  ];
}
