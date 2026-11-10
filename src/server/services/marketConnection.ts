import "server-only";

import { istDayKey } from "@/core/market/session";
import { FYERS_PLANS, HEADROOM } from "@/core/ratelimit/budget";
import type { ApiUsageResponse, BrokerStatusResponse, HubHealth } from "@/contracts/api";
import { hubClient, hubHealth, hubStream } from "@/server/providers/hub";

// How Tradex reaches the market when it's connected to a Market Data Hub: the
// hub's health, and its broker budget for the top bar's API meter. (Standalone,
// the broker routes read Tradex's own Fyers login and budget instead.)

export const HUB_LABEL = "Connected via Market Data Hub";

/** The hub's health (waits for a status request when the last one is over 30 s old). */
export async function hubHealthSummary(): Promise<HubHealth> {
  const client = hubClient();
  const { status, error, at } = await hubHealth({ wait: true });
  return {
    url: client ? new URL(client.url).origin : "",
    reachable: Boolean(status) && !error,
    error,
    version: status?.version ?? null,
    brokerConnected: status ? Boolean(status.broker?.connected) : null,
    feed: status?.live?.feed?.mode ?? null,
    streamOpen: hubStream()?.isOpen() ?? false,
    checkedAt: at,
  };
}

export async function hubBrokerStatus(): Promise<BrokerStatusResponse> {
  const hub = await hubHealthSummary();
  return { connected: hub.reachable, mode: "hub", label: HUB_LABEL, hub, ...(hub.error ? { error: `Market Data Hub unreachable: ${hub.error}` } : {}) };
}

/** The hub's broker budget in the shape of Tradex's own (zeros until the hub has answered). */
export async function hubApiUsage(): Promise<ApiUsageResponse> {
  const hub = await hubHealthSummary();
  const { status } = await hubHealth();
  const budget = status?.broker?.budget;
  const plan = budget?.plan === "prime" ? "prime" : "standard";
  const limits = FYERS_PLANS[plan];
  const now = Date.now();
  const byPriority = { user: budget?.byPriority?.user ?? 0, refresh: budget?.byPriority?.refresh ?? 0, background: budget?.byPriority?.background ?? 0 };
  return {
    limits,
    day: istDayKey(now),
    usedToday: budget?.usedToday ?? 0,
    dayCap: budget?.dayCap ?? Math.floor(limits.perDay * HEADROOM.day),
    usedThisMinute: budget?.usedThisMinute ?? 0,
    minuteCap: budget?.minuteCap ?? Math.floor(limits.perMinute * HEADROOM.minute),
    inFlight: 0,
    slowed: Boolean(budget?.slowed),
    byPriority,
    strikes: budget?.strikes ?? 0,
    cooldownUntil: budget?.coolingDown ? now + 60_000 : 0,
    plan,
    coolingDown: Boolean(budget?.coolingDown),
    via: "hub",
    hub,
  };
}
