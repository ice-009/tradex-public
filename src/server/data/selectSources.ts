import type { DataSource } from "./types";

// Which data sources the engine uses, in order. Pure, so it can be tested.
//
// Tradex gets its market data from a Market Data Hub (HUB_URL + HUB_KEY): the
// hub, then labelled sample data for whatever it can't answer (it is down, or
// a symbol it doesn't serve). Without a hub there is only sample data, and the
// app says so. Sources are given as factories and only the chosen ones are
// built, so without a hub nothing of the hub source is constructed.
//
// DATA_SOURCES (which listed broker / end-of-day sources in earlier versions)
// no longer chooses anything: the hub is the only market-data source.

export const HUB_ORDER = ["hub", "sample"];
export const OFFLINE_ORDER = ["sample"];

export function selectSources(params: { hub: boolean; factories: Record<string, () => DataSource>; dataSources?: string; warn?: (message: string) => void }): DataSource[] {
  const warn = params.warn ?? ((message) => console.warn(message));
  if (params.dataSources?.trim()) warn("DATA_SOURCES is no longer used: Tradex gets its market data from the Market Data Hub (HUB_URL, HUB_KEY), with sample data as the offline fallback.");
  const ids = (params.hub ? HUB_ORDER : OFFLINE_ORDER).filter((id) => params.factories[id]);
  return ids.map((id) => params.factories[id]());
}
