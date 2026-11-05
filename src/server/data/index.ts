import "server-only";

import { getHistory } from "@/server/data/historyStore";
import { DataEngine } from "@/server/data/engine";
import { MarketStream } from "@/server/data/stream";
import { eodSource } from "@/server/data/sources/eod";
import { fyersSource } from "@/server/data/sources/fyers";
import { sampleSource } from "@/server/data/sources/sample";
import type { DataSource } from "@/server/data/types";
import { asPriority } from "@/server/providers/fyers/budget";

// Wiring for the data engine: which sources exist and in what order they're
// tried. Set DATA_SOURCES (comma-separated ids) to change the order or leave
// one out, e.g. DATA_SOURCES=eod,sample to run without the broker.
//
// To add a source: write an adapter in ./sources implementing DataSource
// (./types.ts), add it to AVAILABLE below, and list its id in DATA_SOURCES (or
// DEFAULT_ORDER). Nothing else in the app changes.

const AVAILABLE: Record<string, DataSource> = {
  [fyersSource.id]: fyersSource,
  [eodSource.id]: eodSource,
  [sampleSource.id]: sampleSource,
};

const DEFAULT_ORDER = ["fyers", "eod", "sample"];

function configuredSources(): DataSource[] {
  const ids = (process.env.DATA_SOURCES?.split(",") ?? DEFAULT_ORDER).map((id) => id.trim().toLowerCase()).filter(Boolean);
  const sources = ids.flatMap((id) => {
    const source = AVAILABLE[id];
    if (!source) console.warn(`DATA_SOURCES: unknown source "${id}" (known: ${Object.keys(AVAILABLE).join(", ")})`);
    return source ? [source] : [];
  });
  return sources.length ? sources : DEFAULT_ORDER.map((id) => AVAILABLE[id]);
}

const globalForData = globalThis as unknown as { dataEngine?: DataEngine; marketStream?: MarketStream };

/** The app's one data engine (built on first use, kept across hot reloads). */
export function dataEngine(): DataEngine {
  if (!(globalForData.dataEngine instanceof DataEngine)) {
    globalForData.dataEngine = new DataEngine(configuredSources(), { historyStore: { get: getHistory } });
  }
  return globalForData.dataEngine;
}

/** The app's one live price pipeline. */
export function marketStream(): MarketStream {
  if (!(globalForData.marketStream instanceof MarketStream)) {
    // Polled prices keep visible things current: charge them as "refresh", below charts.
    globalForData.marketStream = new MarketStream(dataEngine(), { runPolling: (job) => asPriority("refresh", job) });
  }
  return globalForData.marketStream;
}
