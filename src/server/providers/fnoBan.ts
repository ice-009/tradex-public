import "server-only";

import { parseFnoBan, type FnoBanList } from "@/core/parsers/fnoBan";

// Today's F&O ban list from NSE's public archive. Best-effort: refreshed every
// 30 minutes; when NSE can't be reached the screener simply doesn't flag bans
// (and says so), it never blocks.

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

export function getFnoBan(): Promise<FnoBanState> {
  if (Date.now() - state.checkedAt < TTL_MS) return Promise.resolve(state.value);
  state.pending ??= (async () => {
    try {
      const response = await fetch(URL, { headers: HEADERS, cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`NSE ban list ${response.status}`);
      state.value = { available: true, ...parseFnoBan(await response.text()), fetchedAt: Date.now() };
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
