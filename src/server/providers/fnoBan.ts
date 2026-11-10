import "server-only";

import { parseFnoBan, type FnoBanList } from "@/core/parsers/fnoBan";
import { hubClient, type HubClient } from "@/server/providers/hub";

// Today's F&O ban list from NSE's public archive. Best-effort: refreshed every
// 30 minutes; when NSE can't be reached the screener simply doesn't flag bans
// (and says so), it never blocks. With a Market Data Hub (HUB_URL) the list
// comes from its /v1/fo/ban instead of NSE.

const URL = "https://nsearchives.nseindia.com/content/fo/fo_secban.csv";
const TTL_MS = 30 * 60 * 1000;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  Accept: "text/csv,*/*",
};

export interface FnoBanState extends FnoBanList {
  available: boolean;
  fetchedAt: number;
}

const globalForBan = globalThis as unknown as { fnoBan?: { value: FnoBanState; checkedAt: number; pending: Promise<FnoBanState> | null } };
const state = (globalForBan.fnoBan ??= { value: { available: false, tradeDate: null, symbols: [], fetchedAt: 0 }, checkedAt: 0, pending: null });

async function fromNse(): Promise<FnoBanList> {
  const response = await fetch(URL, { headers: HEADERS, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`NSE ban list ${response.status}`);
  return parseFnoBan(await response.text());
}

async function fromHub(hub: HubClient): Promise<FnoBanList> {
  const answer = await hub.foBan();
  const tradeDate = answer.tradeDate ? Date.parse(`${answer.tradeDate}T00:00:00Z`) : NaN;
  return { tradeDate: Number.isFinite(tradeDate) ? tradeDate : null, symbols: answer.symbols ?? [] };
}

export function getFnoBan(): Promise<FnoBanState> {
  if (Date.now() - state.checkedAt < TTL_MS) return Promise.resolve(state.value);
  state.pending ??= (async () => {
    try {
      const hub = hubClient();
      state.value = { available: true, ...(hub ? await fromHub(hub) : await fromNse()), fetchedAt: Date.now() };
    } catch (error) {
      console.warn("F&O ban list unavailable:", (error as Error).message);
      state.value = { ...state.value, available: state.value.fetchedAt > 0 }; // keep the last good list if there was one
    }
    state.checkedAt = Date.now();
    state.pending = null;
    return state.value;
  })();
  return state.pending;
}
