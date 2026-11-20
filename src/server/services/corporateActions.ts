import "server-only";

import { corporateActionMarker, type CorporateActionMarker } from "@/core/market/corporateActions";
import { toHubSymbol } from "@/server/data/sources/hub";
import { hubClient } from "@/server/providers/hub";

// Split/bonus markers for a chart: the hub's adjustment factors for a stock
// (GET /v1/adjustments, market-data-hub#20), kept an hour per symbol. A hub
// that doesn't have the endpoint yet (or fails) just gives no markers.

const FRESH_MS = 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; ttl: number; markers: CorporateActionMarker[] }>();

/** Markers for ex-dates on or after `from` (epoch ms); [] when there are none or the hub can't say. */
export async function corporateActionMarkers(symbol: string, from: number, now = Date.now()): Promise<CorporateActionMarker[]> {
  const ticker = toHubSymbol(symbol);
  const client = hubClient();
  if (!ticker || !client) return [];
  let entry = cache.get(ticker);
  if (!entry || now - entry.at > entry.ttl) {
    try {
      const answer = await client.adjustments(ticker);
      entry = { at: now, ttl: FRESH_MS, markers: answer.factors.map((factor) => corporateActionMarker({ time: factor.day, date: factor.date, factor: factor.factor, source: factor.source, action: factor.action })) };
    } catch {
      entry = { at: now, ttl: RETRY_MS, markers: [] };
    }
    cache.set(ticker, entry);
  }
  return entry.markers.filter((marker) => marker.time >= from);
}
