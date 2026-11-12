import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { hubClient, type HubClient } from "@/server/providers/hub";

// Scan universes. The F&O list is the Market Data Hub's (GET /v1/universe/fno,
// from the newest NSE F&O bhavcopy, so it follows NSE's additions and
// removals), re-read every 12 hours. The index lists, and the F&O list when the
// hub can't answer, are snapshots in data/universe/ (from niftyindices.com's
// ind_nifty{50,200,500}list.csv; index rebalances happen twice a year).

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

const HUB_FNO_TTL_MS = 12 * 60 * 60 * 1000;
const HUB_FNO_RETRY_MS = 10 * 60 * 1000;
const hubFno: { at: number; members: UniverseMember[] | null } = { at: 0, members: null };

/** The hub's F&O list (cached), or null when it can't answer. */
async function fnoFromHub(hub: HubClient): Promise<UniverseMember[] | null> {
  const ttl = hubFno.members ? HUB_FNO_TTL_MS : HUB_FNO_RETRY_MS;
  if (Date.now() - hubFno.at < ttl) return hubFno.members;
  hubFno.at = Date.now();
  try {
    const [answer, industries] = await Promise.all([hub.universe("fno"), getIndustryMap()]);
    const members = (answer.members ?? []).map((member) => {
      const symbol = member.symbol.trim().toUpperCase();
      return { symbol, name: member.name || industries.get(symbol)?.name || symbol, industry: member.industry || industries.get(symbol)?.industry || "" };
    });
    if (members.length >= 50) hubFno.members = members;
    else console.warn(`F&O list from the Market Data Hub has only ${members.length} stocks; using the snapshot.`);
  } catch (error) {
    console.warn("F&O list from the Market Data Hub unavailable; using the snapshot:", (error as Error).message);
  }
  return hubFno.members;
}

export function isUniverseId(value: string): value is UniverseId {
  return UNIVERSES.some((universe) => universe.id === value);
}

export async function getUniverse(id: UniverseId): Promise<UniverseMember[]> {
  const hub = id === "fno" ? hubClient() : null;
  if (hub) {
    const members = await fnoFromHub(hub);
    if (members) return members;
  }
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
