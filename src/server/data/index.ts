import "server-only";

import { getHistory, peekHistory } from "@/server/data/historyStore";
import { DataEngine } from "@/server/data/engine";
import { selectSources } from "@/server/data/selectSources";
import { MarketStream } from "@/server/data/stream";
import { createHubSource } from "@/server/data/sources/hub";
import { sampleSource } from "@/server/data/sources/sample";
import type { DataSource } from "@/server/data/types";
import { hubClient, hubMode, hubStream } from "@/server/providers/hub";

// Wiring for the data engine: the Market Data Hub (HUB_URL + HUB_KEY), then
// labelled sample data (./selectSources.ts). Without a hub only sample data
// exists and the app shows "Connect a Market Data Hub".
//
// Sources are built from factories, so one that isn't chosen is never constructed.

const FACTORIES: Record<string, () => DataSource> = {
  hub: () => createHubSource({ client: () => hubClient()!, stream: () => hubStream()! }),
  sample: () => sampleSource,
};

const globalForData = globalThis as unknown as { dataEngine?: DataEngine; marketStream?: MarketStream; dataEngineMode?: string };

/** The app's one data engine (built on first use, kept across hot reloads; rebuilt when the hub settings appear or go). */
export function dataEngine(): DataEngine {
  const mode = hubMode() ? "hub" : "offline";
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
  if (!(globalForData.marketStream instanceof MarketStream)) globalForData.marketStream = new MarketStream(engine);
  return globalForData.marketStream;
}
