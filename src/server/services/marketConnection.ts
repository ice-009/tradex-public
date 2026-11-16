import "server-only";

import { istDayKey } from "@/core/market/session";
import { BROKER_PLANS, freshCaps } from "@/core/ratelimit/budget";
import type { ApiUsageResponse, BrokerStatusResponse, HubDatasetStatus, HubHealth, MarketDataStatus } from "@/contracts/api";
import { screenerStore } from "@/server/providers/dailyStore";
import { hubClient, hubHealth, hubStream, type HubStatus } from "@/server/providers/hub";

// How Tradex reaches the market: through a Market Data Hub, always. Its health
// (GET /v1/status, cached 30 s), its broker budget for the top bar's meter, and
// the read-only "Market data" panel. Tradex's key has no admin scope, so it can
// look but never start a download or change anything on the hub.

export const HUB_LABEL = "Connected via Market Data Hub";
export const HUB_MISSING = "Connect a Market Data Hub";
export const HUB_DOCS = "https://github.com/ice-009/market-data-hub";

const NOT_CONFIGURED: HubHealth = {
  configured: false,
  url: "",
  reachable: false,
  error: `HUB_URL and HUB_KEY aren't set: Tradex gets its market data from a Market Data Hub (${HUB_DOCS}). Showing sample data.`,
  version: null,
  healthy: null,
  problems: [],
  warnings: [],
  brokerConnected: null,
  feed: null,
  streamOpen: false,
  checkedAt: 0,
};

/** The hub's health (waits for a status request when the last one is over 30 s old). */
export async function hubHealthSummary(): Promise<HubHealth> {
  const client = hubClient();
  if (!client) return NOT_CONFIGURED;
  const { status, error, at } = await hubHealth({ wait: true });
  return {
    configured: true,
    url: new URL(client.url).origin,
    reachable: Boolean(status) && !error,
    error,
    version: status?.version ?? null,
    healthy: typeof status?.healthy === "boolean" ? status.healthy : null,
    problems: status?.problems ?? [],
    warnings: status?.warnings ?? [],
    brokerConnected: status ? Boolean(status.broker?.connected) : null,
    feed: status?.live?.feed?.mode ?? null,
    streamOpen: hubStream()?.isOpen() ?? false,
    checkedAt: at,
  };
}

export async function hubBrokerStatus(): Promise<BrokerStatusResponse> {
  const hub = await hubHealthSummary();
  if (!hub.configured) return { connected: false, mode: "hub", label: HUB_MISSING, hub, error: hub.error ?? undefined };
  return { connected: hub.reachable, mode: "hub", label: hub.reachable ? HUB_LABEL : "Market Data Hub unreachable", hub, ...(hub.error ? { error: `Market Data Hub unreachable: ${hub.error}` } : {}) };
}

function usageFrom(status: HubStatus | null, hub: HubHealth): ApiUsageResponse {
  const budget = status?.broker?.budget;
  const plan = budget?.plan === "prime" ? "prime" : "standard";
  const limits = BROKER_PLANS[plan];
  const caps = freshCaps(limits);
  const now = Date.now();
  return {
    limits,
    day: istDayKey(now),
    usedToday: budget?.usedToday ?? 0,
    dayCap: budget?.dayCap ?? caps.dayCap,
    usedThisMinute: budget?.usedThisMinute ?? 0,
    minuteCap: budget?.minuteCap ?? caps.minuteCap,
    inFlight: 0,
    slowed: Boolean(budget?.slowed),
    byPriority: { user: budget?.byPriority?.user ?? 0, refresh: budget?.byPriority?.refresh ?? 0, background: budget?.byPriority?.background ?? 0 },
    strikes: budget?.strikes ?? 0,
    cooldownUntil: budget?.coolingDown ? now + 60_000 : 0,
    plan,
    coolingDown: Boolean(budget?.coolingDown),
    hub,
  };
}

/** The hub's broker budget in the shape of the top bar's meter (zeros until the hub has answered). */
export async function hubApiUsage(): Promise<ApiUsageResponse> {
  const hub = await hubHealthSummary();
  const status = hub.configured ? (await hubHealth()).status : null;
  return usageFrom(status, hub);
}

const DATASETS: Array<{ id: "cashBhav" | "foBhav" | "lots" | "foBan" | "resultsCalendar"; label: string }> = [
  { id: "cashBhav", label: "Daily bars & delivery % (NSE bhavcopy)" },
  { id: "foBhav", label: "Futures OI & F&O list (NSE F&O bhavcopy)" },
  { id: "lots", label: "Lot sizes" },
  { id: "foBan", label: "F&O ban list" },
  { id: "resultsCalendar", label: "Results calendar" },
];

/** The read-only Market data panel: the hub's health and the freshness of what it serves. */
export async function marketDataStatus(): Promise<MarketDataStatus> {
  const hub = await hubHealthSummary();
  const status = hub.configured ? (await hubHealth()).status : null;
  const data = status?.data;
  const datasets: HubDatasetStatus[] = DATASETS.map(({ id, label }) => {
    const entry = data?.[id];
    const detail = id === "lots" && entry?.count ? `${entry.count} lot sizes` : id === "resultsCalendar" && entry?.events ? `${entry.events} events` : null;
    return { id, label, session: entry?.lastSession ?? entry?.tradeDate ?? null, updatedAt: entry?.lastSuccessAt ?? null, detail, error: entry?.lastError ?? null };
  });
  for (const candles of data?.candles ?? []) {
    datasets.push({ id: `candles-${candles.tf}`, label: `Candles · ${candles.tf}`, session: candles.lastSession ?? null, updatedAt: null, detail: `${candles.series.toLocaleString("en-IN")} series · ${candles.candles.toLocaleString("en-IN")} candles`, error: null });
  }
  return {
    hub,
    datasets: status ? datasets : [],
    broker: { configured: status ? Boolean(status.broker?.configured) : null, connected: status ? Boolean(status.broker?.connected) : null, lastLoginError: status?.broker?.lastLoginError ?? null },
    budget: status ? usageFrom(status, hub) : null,
    scopes: status?.key?.scopes ?? [],
    store: { message: screenerStore.progress.message, queued: screenerStore.progress.queued },
  };
}
