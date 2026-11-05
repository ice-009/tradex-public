import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SymbolInfo } from "@/contracts/api";

export type { SymbolInfo };


// Indices the chart can open. Keep in sync with KNOWN_INDEX_SYMBOLS in fyers.ts.
const INDICES: SymbolInfo[] = [
  { symbol: "NIFTY", name: "Nifty 50", exchange: "NSE", type: "index" },
  { symbol: "BANKNIFTY", name: "Nifty Bank", exchange: "NSE", type: "index" },
  { symbol: "FINNIFTY", name: "Nifty Financial Services", exchange: "NSE", type: "index" },
  { symbol: "MIDCPNIFTY", name: "Nifty Midcap Select", exchange: "NSE", type: "index" },
  { symbol: "NIFTYIT", name: "Nifty IT", exchange: "NSE", type: "index" },
  { symbol: "INDIAVIX", name: "India VIX", exchange: "NSE", type: "index" },
  { symbol: "SENSEX", name: "S&P BSE Sensex", exchange: "BSE", type: "index" },
];

// Nifty 50 constituents: ranked first among equally good matches ("RELI" → RELIANCE).
const POPULAR = new Set([
  "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK", "BAJAJ-AUTO", "BAJFINANCE", "BAJAJFINSV",
  "BEL", "BHARTIARTL", "CIPLA", "COALINDIA", "DRREDDY", "EICHERMOT", "ETERNAL", "GRASIM", "HCLTECH", "HDFCBANK",
  "HDFCLIFE", "HEROMOTOCO", "HINDALCO", "HINDUNILVR", "ICICIBANK", "INDUSINDBK", "INFY", "ITC", "JIOFIN",
  "JSWSTEEL", "KOTAKBANK", "LT", "M&M", "MARUTI", "NESTLEIND", "NTPC", "ONGC", "POWERGRID", "RELIANCE",
  "SBILIFE", "SBIN", "SHRIRAMFIN", "SUNPHARMA", "TATACONSUM", "TATAMOTORS", "TATASTEEL", "TCS", "TECHM",
  "TITAN", "TRENT", "ULTRACEMCO", "WIPRO",
]);

let universeCache: SymbolInfo[] | null = null;

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let insideQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (insideQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (char === "," && !insideQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

async function loadUniverse() {
  if (universeCache) {
    return universeCache;
  }

  const filePath = path.join(process.cwd(), "data", "EQUITY_L.csv");
  const csvText = await readFile(filePath, "utf8");
  const lines = csvText.split(/\r?\n/).filter(Boolean);
  const seenSymbols = new Set<string>(INDICES.map((index) => index.symbol));
  const universe: SymbolInfo[] = [...INDICES];

  for (const line of lines.slice(1)) {
    const [rawSymbol = "", rawName = "", rawSeries = ""] = parseCsvLine(line);
    const symbol = rawSymbol.trim().toUpperCase();
    const name = rawName.trim();
    const series = rawSeries.trim().toUpperCase();

    if (!symbol || !name || series !== "EQ" || seenSymbols.has(symbol)) {
      continue;
    }

    seenSymbols.add(symbol);
    universe.push({ symbol, name, exchange: "NSE", type: "stock" });
  }

  universeCache = universe;
  return universe;
}

/** Ranked search: exact symbol, then symbol prefix, then name/symbol substring. */
export async function searchSymbols(query: string, limit = 30): Promise<SymbolInfo[]> {
  const universe = await loadUniverse();
  const q = query.trim().toUpperCase();
  if (!q) {
    return universe.slice(0, limit);
  }

  const scored: Array<{ item: SymbolInfo; score: number }> = [];
  for (const item of universe) {
    const name = item.name.toUpperCase();
    let score = -1;
    if (item.symbol === q) score = 0;
    else if (item.symbol.startsWith(q)) score = 1;
    else if (name.startsWith(q)) score = 2;
    else if (item.symbol.includes(q)) score = 3;
    else if (name.includes(q)) score = 4;
    if (score >= 0) scored.push({ item, score });
  }

  return scored
    .sort(
      (left, right) =>
        left.score - right.score ||
        Number(right.item.type === "index" || POPULAR.has(right.item.symbol)) -
          Number(left.item.type === "index" || POPULAR.has(left.item.symbol)) ||
        left.item.symbol.length - right.item.symbol.length,
    )
    .slice(0, limit)
    .map((entry) => entry.item);
}

export async function getSymbolInfo(symbol: string): Promise<SymbolInfo | null> {
  const universe = await loadUniverse();
  const normalized = symbol.trim().toUpperCase();
  return universe.find((item) => item.symbol === normalized) ?? null;
}
