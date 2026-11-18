import "server-only";

import type { DatasetHealth, HealthReport } from "@/contracts/api";
import { dataEngine, marketStream } from "@/server/data";
import { log } from "@/server/log";
import { screenerStore } from "@/server/providers/dailyStore";
import { oiHealth } from "@/server/providers/foData";
import { hubHealth, hubStream, type HubStatus } from "@/server/providers/hub";
import { evidenceHealth } from "@/server/services/evidence";
import { highLowHealth } from "@/server/services/highLowScanner";
import { hubHealthSummary } from "@/server/services/marketConnection";
import { BENCHMARK } from "@/server/services/screener";
import { HUB_DATASETS, assessHealth, candleDatasets, evidenceDataset, hubDatasetHealth, hubJobs, marketState, oiTagHealth, storeHealth, tradexJobs } from "./healthRules";
import packageJson from "../../../package.json";

// The /health page (GET /api/health/details): the hub connection, data freshness per
// dataset, the broker budget, every socket between the broker and the browser,
// background jobs and the server's recent warnings and errors — gathered from
// what's already in memory (plus the hub's /v1/status, cached 30 s), then
// judged by ./healthRules.ts. Asking for it never starts a download.

export async function healthReport(now = Date.now()): Promise<HealthReport> {
  const summary = await hubHealthSummary();
  const status = summary.configured ? (await hubHealth()).status : null;
  const market = marketState(now);

  const hub: HealthReport["hub"] = {
    ...summary,
    uptimeSec: status?.uptimeSec ?? null,
    keyName: status?.key?.name ?? null,
    scopes: status?.key?.scopes ?? [],
    streams: status?.live?.streams ?? null,
  };

  const broker = status?.broker;
  const budget = broker?.budget;
  const report: Omit<HealthReport, "verdict" | "issues"> = {
    checkedAt: now,
    market,
    tradex: {
      version: packageJson.version,
      startedAt: Math.round(now - process.uptime() * 1000),
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      logLevel: log.level,
      metricsToken: Boolean(process.env.METRICS_TOKEN?.trim()),
      logCounts: { warn: log.counts().warn, error: log.counts().error },
    },
    hub,
    broker: {
      configured: broker ? Boolean(broker.configured) : null,
      connected: broker ? Boolean(broker.connected) : null,
      ownsConnection: typeof broker?.ownsConnection === "boolean" ? broker.ownsConnection : null,
      lastLoginAt: broker?.lastLoginAt ?? null,
      lastLoginError: broker?.lastLoginError ?? null,
      loginRetryAfter: broker?.loginRetryAfter ?? null,
    },
    budget:
      budget && typeof budget.dayCap === "number"
        ? {
            plan: budget.plan === "prime" ? "prime" : "standard",
            usedToday: budget.usedToday ?? 0,
            dayCap: budget.dayCap,
            usedThisMinute: budget.usedThisMinute ?? 0,
            minuteCap: budget.minuteCap ?? 0,
            byPriority: { ...(budget.byPriority ?? {}) },
            strikes: budget.strikes ?? 0,
            slowed: Boolean(budget.slowed),
            coolingDown: Boolean(budget.coolingDown),
            stoppedForToday: Boolean(budget.stoppedForToday),
          }
        : null,
    live: liveState(status?.live?.feed ?? null, summary.configured),
    datasets: datasets(status, now),
    jobs: [
      ...hubJobs(status?.jobs ?? [], status?.live?.recovery),
      ...tradexJobs({ store: storeState(), evidence: evidenceHealth(), highLow: highLowHealth() }),
    ],
    errors: log
      .recent()
      .filter((entry) => entry.level === "warn" || entry.level === "error")
      .slice(0, 30)
      .map((entry) => ({ ...entry, level: entry.level as "warn" | "error" })),
  };

  const { verdict, issues } = assessHealth({ now, market, hub, budget: report.budget, live: report.live, datasets: report.datasets, jobs: report.jobs });
  return { ...report, verdict, issues };
}

function liveState(feed: NonNullable<HubStatus["live"]>["feed"] | null, configured: boolean): HealthReport["live"] {
  const engine = dataEngine();
  const stream = marketStream();
  const status = stream.status();
  const diagnostics = stream.diagnostics();
  return {
    hubFeed: feed
      ? {
          mode: feed.mode,
          socket: feed.socket ?? null,
          socketSymbols: feed.socketSymbols ?? 0,
          polledSymbols: feed.polledSymbols ?? 0,
          capacity: feed.capacity ?? null,
          lastTickAt: feed.lastTickAt ?? null,
          reconnects: feed.reconnects ?? 0,
          pollingStopped: feed.pollingStopped ?? null,
        }
      : null,
    hubStream: configured ? (hubStream()?.diagnostics() ?? null) : null,
    market: {
      mode: status.mode,
      source: status.source,
      live: status.live.length,
      polled: status.polled.length,
      subscribers: diagnostics.subscribers,
      lastTickAt: diagnostics.lastTickAt,
      lastPollAt: diagnostics.lastPollAt,
      lastRestartAt: diagnostics.lastRestartAt,
    },
    sources: engine.status().map(({ source, restingUntil, lastError }) => ({ id: source.id, label: source.label, lastError, restingUntil })),
  };
}

function storeState() {
  const { phase, message, finishedAt, queued, done, total } = screenerStore.progress;
  return { phase, message, finishedAt, queued, done, total, lastBar: screenerStore.getBars(BENCHMARK).at(-1)?.t ?? null };
}

function datasets(status: HubStatus | null, now: number): DatasetHealth[] {
  const data = status?.data;
  const context = { now, problems: status?.problems ?? [], warnings: status?.warnings ?? [] };
  const fromHub = status ? HUB_DATASETS.map((meta) => hubDatasetHealth(meta, data?.[meta.id], context)) : [];
  const cashAsOf = fromHub.find((dataset) => dataset.id === "cashBhav")?.asOf ?? null;
  const foAsOf = fromHub.find((dataset) => dataset.id === "foBhav")?.asOf ?? null;
  return [
    ...fromHub,
    storeHealth(storeState(), cashAsOf),
    oiTagHealth(oiHealth(), foAsOf, now),
    evidenceDataset(evidenceHealth()),
    ...candleDatasets(data?.candles ?? []),
  ];
}
