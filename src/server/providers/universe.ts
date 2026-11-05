import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

// Scan universes, snapshotted into data/universe/ from niftyindices.com
// (ind_nifty{50,200,500}list.csv) and NSE's F&O lot-size file (fo_mktlots.csv).
// Refresh by re-downloading those files; index rebalances happen twice a year.

export type UniverseId = "nifty50" | "nifty200" | "nifty500" | "fno";

export const UNIVERSES: Array<{ id: UniverseId; label: string }> = [
  { id: "nifty50", label: "Nifty 50" },
  { id: "nifty200", label: "Nifty 200" },
  { id: "fno", label: "F&O stocks" },
  { id: "nifty500", label: "Nifty 500" },
];

export interface UniverseMember {
  symbol: string;
  name: string;
  industry: string;
}

const cache = new Map<UniverseId, UniverseMember[]>();
let industryBySymbol: Map<string, { name: string; industry: string }> | null = null;

const DATA_DIR = path.join(process.cwd(), "data", "universe");

async function loadIndexCsv(file: string): Promise<UniverseMember[]> {
  const text = await readFile(path.join(DATA_DIR, file), "utf8");
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(","))
    .filter((cols) => cols.length >= 3 && cols[2]?.trim())
    .map(([name, industry, symbol]) => ({ symbol: symbol.trim().toUpperCase(), name: name.trim(), industry: industry.trim() }));
}

async function getIndustryMap() {
  if (!industryBySymbol) {
    const members = await loadIndexCsv("nifty500.csv");
    industryBySymbol = new Map(members.map((member) => [member.symbol, { name: member.name, industry: member.industry }]));
  }
  return industryBySymbol;
}

export function isUniverseId(value: string): value is UniverseId {
  return UNIVERSES.some((universe) => universe.id === value);
}

export async function getUniverse(id: UniverseId): Promise<UniverseMember[]> {
  const cached = cache.get(id);
  if (cached) return cached;

  let members: UniverseMember[];
  if (id === "fno") {
    const industries = await getIndustryMap();
    const text = await readFile(path.join(DATA_DIR, "fno.txt"), "utf8");
    members = text
      .split(/\r?\n/)
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean)
      .map((symbol) => ({ symbol, name: industries.get(symbol)?.name ?? symbol, industry: industries.get(symbol)?.industry ?? "" }));
  } else {
    members = await loadIndexCsv(`${id}.csv`);
  }

  cache.set(id, members);
  return members;
}
