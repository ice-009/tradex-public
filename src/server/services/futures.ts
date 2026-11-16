import "server-only";

import type { FuturesResponse } from "@/contracts/api";
import { stockFutures } from "@/server/providers/futures";

// A stock's futures contracts for the order ticket (contract, expiry, basis, lots).

export async function getFutures(raw: string): Promise<FuturesResponse> {
  const symbol = raw.trim().toUpperCase();
  if (!/^[A-Z0-9&_-]{1,20}$/.test(symbol)) return { symbol, available: false, lot: null, contracts: [] };
  const futures = await stockFutures(symbol);
  return { symbol, available: Boolean(futures?.contracts.length), lot: futures?.lot ?? null, contracts: futures?.contracts ?? [] };
}
