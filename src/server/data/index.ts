import "server-only";

import { getHistory, peekHistory } from "@/server/data/historyStore";
import { DataEngine } from "@/server/data/engine";
import { selectSources } from "@/server/data/selectSources";
import { MarketStream } from "@/server/data/stream";
import { eodSource } from "@/server/data/sources/eod";
import { fyersSource } from "@/server/data/sources/fyers";
import { createHubSource } from "@/server/data/sources/hub";
import { sampleSource } from "@/server/data/sources/sample";
import type { DataSource } from "@/server/data/types";
import { hubClient, hubMode, hubStream } from "@/server/providers/hub";
import { asPriority } from "@/server/providers/marketBudget";

// Wiring for the data engine: which sources exist and in what order they're
// tried (see ./selectSources.ts). Set DATA_SOURCES (comma-separated ids) to
// change the order or leave one out, e.g. DATA_SOURCES=eod,sample to run
// without the broker. With HUB_URL and HUB_KEY set, the Market Data Hub
// replaces Fyers.
//
// To add a source: write an adapter in ./sources implementing DataSource
// (./types.ts), add it to FACTORIES below, and list its id in DATA_SOURCES.
// Nothing else in the app changes.

const FACTORIES: Record<string, () => DataSource> = {
  fyers: () => fyersSource,
  hub: () => createHubSource({ client: () => hubClient()!, stream: () => hubStream()! }),
  eod: () => eodSource,
  sample: () => sampleSource,
};

const globalForData = globalThis as unknown as { dataEngine?: DataEngine; marketStream?: MarketStream; dataEngineMode?: string };

/** The app's one data engine (built on first use, kept across hot reloads). */
export function dataEngine(): DataEngine {
  const mode = hubMode() ? "hub" : "standalone";
  if (!(globalForData.dataEngine instanceof DataEngine) || globalForData.dataEngineMode !== mode) {
    globalForData.dataEngine = new DataEngine(selectSources({ dataSources: process.env.DATA_SOURCES, hub: mode === "hub", factories: FACTORIES }), {
      historyStore: { get: getHistory, peek: peekHistory },
    });
    globalForData.dataEngineMode = mode;
    globalForData.marketStream = undefined;
  }
  return globalForData.dataEngine;
}

/** The app's one live price pipeline. */
export function marketStream(): MarketStream {
  const engine = dataEngine();
  if (!(globalForData.marketStream instanceof MarketStream)) {
    // Polled prices keep visible things current: charge them as "refresh", below charts.
    globalForData.marketStream = new MarketStream(engine, { runPolling: (job) => asPriority("refresh", job) });
  }
  return globalForData.marketStream;
}
