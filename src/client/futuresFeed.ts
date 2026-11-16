import { useEffect, useState } from "react";
import type { FuturesResponse } from "@/contracts/api";
import { api } from "@/client/api";

// A stock's futures contracts (near and next month, as hub tickers) and lot
// size, from /api/futures. Cached per page: contracts change once a month.

const cache = new Map<string, Promise<FuturesResponse | null>>();

function load(symbol: string): Promise<FuturesResponse | null> {
  let pending = cache.get(symbol);
  if (!pending) {
    pending = api.futures(symbol).catch(() => {
      cache.delete(symbol); // let the next ticket try again
      return null;
    });
    cache.set(symbol, pending);
  }
  return pending;
}

/** The stock's futures (null while loading or when the hub couldn't answer). */
export function useFutures(symbol: string): FuturesResponse | null {
  const [state, setState] = useState<{ symbol: string; value: FuturesResponse | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void load(symbol).then((value) => {
      if (!cancelled) setState({ symbol, value });
    });
    return () => {
      cancelled = true;
    };
  }, [symbol]);
  return state?.symbol === symbol ? state.value : null;
}
