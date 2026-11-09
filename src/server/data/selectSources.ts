import type { DataSource } from "./types";

// Which data sources the engine uses, in order. Pure, so it can be tested:
//
//  - Standalone (no hub): DATA_SOURCES, default "fyers,eod,sample".
//  - With a Market Data Hub (HUB_URL + HUB_KEY): default "hub,eod,sample", and
//    "fyers" is dropped even if DATA_SOURCES lists it — the hub owns the broker
//    connection, and two processes calling Fyers is what trips its rate limits.
//
// Sources are given as factories and only the chosen ones are built, so in hub
// mode nothing of the Fyers source is constructed.

export const STANDALONE_ORDER = ["fyers", "eod", "sample"];
export const HUB_ORDER = ["hub", "eod", "sample"];

export function selectSources(params: { dataSources?: string; hub: boolean; factories: Record<string, () => DataSource>; warn?: (message: string) => void }): DataSource[] {
  const { hub, factories } = params;
  const warn = params.warn ?? ((message) => console.warn(message));
  const fallback = hub ? HUB_ORDER : STANDALONE_ORDER;
  let ids = (params.dataSources?.split(",") ?? fallback).map((id) => id.trim().toLowerCase()).filter(Boolean);
  if (hub && ids.includes("fyers")) {
    warn('DATA_SOURCES: "fyers" is ignored while a Market Data Hub is configured (HUB_URL): the hub talks to the broker.');
    ids = ids.filter((id) => id !== "fyers");
    if (!ids.includes("hub")) ids.unshift("hub");
  }
  if (!hub && ids.includes("hub")) {
    warn('DATA_SOURCES: "hub" needs HUB_URL and HUB_KEY; leaving it out.');
    ids = ids.filter((id) => id !== "hub");
  }
  ids = [...new Set(ids)].filter((id) => {
    if (factories[id]) return true;
    warn(`DATA_SOURCES: unknown source "${id}" (known: ${Object.keys(factories).join(", ")})`);
    return false;
  });
  if (!ids.length) ids = fallback.filter((id) => factories[id]);
  return ids.map((id) => factories[id]());
}
