import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LotsResponse } from "@/contracts/api";
import { parseFyersLots, parseNseLots } from "@/core/parsers/lotSizes";
import { hubClient } from "@/server/providers/hub";

// Stock-futures lot sizes, for sizing in lots.
//
// Primary: NSE's fo_mktlots.csv ("applicable market lot of eligible scrips and
// indices for trading in Equity Derivatives"). Its columns are found by header
// name — a SYMBOL column, then one column per contract month (e.g. NOV-26) —
// not by position. Fallback: Fyers' public symbol master NSE_FO.csv, scanned
// for futures tickers (NSE:SBIN26NOVFUT) with the lot in the "Minimum lot
// size" field. Cached in memory for 12 h and on disk, so a failed download
// falls back to the last good copy. When neither source answers, the order
// ticket asks for the lot size instead of guessing.
//
// With a Market Data Hub (HUB_URL), lots come from the hub's /v1/lots (its own
// copy of the same NSE file) and nothing is downloaded from NSE or Fyers.

const NSE_URL = "https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv";
const FYERS_URL = "https://public.fyers.in/sym_details/NSE_FO.csv";
const TTL_MS = 12 * 60 * 60 * 1000;
const FAIL_TTL_MS = 30 * 60 * 1000;
const CACHE_FILE = path.join(process.cwd(), ".cache", "lots.json");
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  Accept: "text/csv,*/*",
};

export type LotSizes = LotsResponse;

async function download(url: string, parse: (csv: string) => Record<string, number>) {
  const response = await fetch(url, { headers: HEADERS, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  const lots = parse(await response.text());
  if (Object.keys(lots).length < 50) throw new Error(`${url}: only ${Object.keys(lots).length} lot sizes parsed`);
  return lots;
}

const globalForLots = globalThis as unknown as { lotSizes?: { value: LotSizes; checkedAt: number; pending: Promise<LotSizes> | null } };
const state = (globalForLots.lotSizes ??= { value: { lots: {}, source: "none", fetchedAt: 0 }, checkedAt: 0, pending: null });

async function save(value: LotSizes) {
  await mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(value));
  return value;
}

async function refresh(): Promise<LotSizes> {
  const hub = hubClient();
  if (hub) {
    try {
      const answer = await hub.lots();
      if (Object.keys(answer.lots ?? {}).length) return await save({ lots: answer.lots, source: "hub", fetchedAt: answer.fetchedAt || Date.now() });
      console.warn("Lot sizes: the Market Data Hub has none yet");
    } catch (error) {
      console.warn("Lot sizes from the Market Data Hub:", (error as Error).message);
    }
  }
  for (const [source, url, parse] of hub
    ? []
    : ([
        ["nse", NSE_URL, parseNseLots],
        ["fyers", FYERS_URL, parseFyersLots],
      ] as const)) {
    try {
      return await save({ lots: await download(url, parse), source, fetchedAt: Date.now() });
    } catch (error) {
      console.warn("Lot sizes:", (error as Error).message);
    }
  }
  try {
    const disk = JSON.parse(await readFile(CACHE_FILE, "utf8")) as LotSizes;
    return { ...disk, source: "disk" };
  } catch {
    return { lots: {}, source: "none", fetchedAt: 0 };
  }
}

export async function getLotSizes(): Promise<LotSizes> {
  const ttl = state.value.source === "none" ? FAIL_TTL_MS : TTL_MS;
  if (Date.now() - state.checkedAt > ttl && !state.pending) {
    state.pending = refresh()
      .then((value) => {
        state.value = value;
        return value;
      })
      .finally(() => {
        state.checkedAt = Date.now();
        state.pending = null;
      });
  }
  if (state.pending && state.value.source === "none") return state.pending;
  return state.value;
}
