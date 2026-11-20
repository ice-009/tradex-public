import "server-only";

import type { HealthReport } from "@/contracts/api";
import { log, LOG_LEVELS } from "@/server/log";
import { gauge, renderPrometheus, requestMetrics, type MetricFamily } from "@/server/metrics";
import { healthReport } from "./health";

// GET /api/metrics: Prometheus text format. The same state as the /health page
// (one hub /v1/status read, cached 30 s), as gauges an alert rule can use —
// e.g. `tradex_dataset_stale == 1`, `tradex_hub_reachable == 0`,
// `time() - tradex_hub_feed_last_tick_timestamp_seconds > 120` in market hours,
// `tradex_data_quality_recent_findings{severity="problem"} > 0` —
// plus request counts and durations and log lines per level.

const seconds = (ms: number | null | undefined) => (ms ? Math.round(ms / 1000) : null);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function family(name: string, help: string, type: MetricFamily["type"], samples: MetricFamily["samples"]): MetricFamily {
  return { name, help, type, samples };
}

export function metricFamilies(report: HealthReport): MetricFamily[] {
  const { hub, budget, live, tradex } = report;
  const counts = log.counts();
  const memory = process.memoryUsage();
  const families: MetricFamily[] = [
    gauge("tradex_build_info", "Tradex version and Node.js runtime (always 1).", 1, { version: tradex.version, node: tradex.node }),
    gauge("tradex_process_start_time_seconds", "When this server process started (unix seconds).", seconds(tradex.startedAt)),
    gauge("tradex_process_resident_memory_bytes", "Resident memory of the server process.", memory.rss),
    gauge("tradex_process_heap_used_bytes", "V8 heap in use.", memory.heapUsed),
    family("tradex_log_lines_total", "Log lines written, by level.", "counter", LOG_LEVELS.map((level) => ({ labels: { level }, value: counts[level] }))),
    gauge("tradex_healthy", "1 when the health page's verdict is ok (no problems), else 0.", report.verdict === "ok"),
    family("tradex_health_issues", "Reasons a number may be old, by severity.", "gauge", (["problem", "warning", "info"] as const).map((severity) => ({ labels: { severity }, value: report.issues.filter((issue) => issue.severity === severity).length }))),
    gauge("tradex_market_open", "1 during the regular NSE session (holidays aren't known).", report.market.open),

    gauge("tradex_hub_configured", "HUB_URL and HUB_KEY are set.", hub.configured),
    gauge("tradex_hub_reachable", "The hub's last /v1/status answered.", hub.reachable),
    gauge("tradex_hub_healthy", "The hub's own health check (absent when unknown).", hub.healthy),
    gauge("tradex_hub_problems", "Problems the hub reports.", hub.configured ? hub.problems.length : null),
    gauge("tradex_hub_warnings", "Warnings the hub reports.", hub.configured ? hub.warnings.length : null),
    gauge("tradex_hub_status_checked_timestamp_seconds", "When Tradex last read the hub's /v1/status.", seconds(hub.checkedAt)),
    gauge("tradex_hub_uptime_seconds", "The hub process's uptime.", hub.uptimeSec),
    gauge("tradex_hub_broker_connected", "The hub's broker login is connected.", report.broker.connected),
    gauge("tradex_hub_broker_owns_connection", "This hub process holds the broker connection.", report.broker.ownsConnection),
  ];

  if (budget) {
    families.push(
      gauge("tradex_hub_budget_used_today", "Broker calls the hub has made today (every app).", budget.usedToday),
      gauge("tradex_hub_budget_day_cap", "The hub's daily broker-call cap.", budget.dayCap),
      gauge("tradex_hub_budget_used_this_minute", "Broker calls in the current minute.", budget.usedThisMinute),
      gauge("tradex_hub_budget_minute_cap", "The hub's per-minute broker-call cap.", budget.minuteCap),
      gauge("tradex_hub_budget_strikes", "Rate-limit (429) strikes today.", budget.strikes),
      gauge("tradex_hub_budget_cooling_down", "Broker calls paused after a rate-limit warning.", budget.coolingDown),
      gauge("tradex_hub_budget_stopped_for_today", "Broker calls stopped for the rest of the day.", budget.stoppedForToday),
      family("tradex_hub_budget_used_today_by_priority", "Broker calls today by priority.", "gauge", Object.entries(budget.byPriority).map(([priority, value]) => ({ labels: { priority }, value }))),
    );
  }

  const feed = live.hubFeed;
  if (feed) {
    families.push(
      gauge("tradex_hub_feed_mode", "The hub's live feed mode (socket, polling, mixed, idle, down).", 1, { mode: feed.mode }),
      gauge("tradex_hub_feed_socket_connected", "The hub's broker socket is connected.", feed.socket === "connected"),
      gauge("tradex_hub_feed_socket_symbols", "Symbols on the hub's broker socket.", feed.socketSymbols),
      gauge("tradex_hub_feed_polled_symbols", "Symbols the hub polls instead.", feed.polledSymbols),
      gauge("tradex_hub_feed_reconnects", "Socket reconnects since the hub's feed started.", feed.reconnects),
      gauge("tradex_hub_feed_last_tick_timestamp_seconds", "Last tick the hub received.", seconds(feed.lastTickAt)),
    );
  }

  const stream = live.hubStream;
  if (stream) {
    families.push(
      gauge("tradex_hub_stream_open", "Tradex's SSE connection to the hub's /v1/stream is open.", stream.open),
      family("tradex_hub_stream_connects_total", "Successful connections to the hub's stream.", "counter", [{ value: stream.connects }]),
      gauge("tradex_hub_stream_failures", "Failed connection attempts in a row.", stream.failures),
      gauge("tradex_hub_stream_symbols", "Symbols Tradex streams from the hub.", stream.symbols),
      gauge("tradex_hub_stream_last_heard_timestamp_seconds", "Last data or heartbeat from the hub's stream.", seconds(stream.lastHeardAt)),
    );
  }

  families.push(
    gauge("tradex_market_stream_subscribers", "Open live-price consumers (browser streams).", live.market.subscribers),
    family("tradex_market_stream_symbols", "Symbols fed live to browsers, by how.", "gauge", [
      { labels: { via: "socket" }, value: live.market.live },
      { labels: { via: "polling" }, value: live.market.polled },
    ]),
    gauge("tradex_market_stream_last_tick_timestamp_seconds", "Last tick sent to browsers.", seconds(live.market.lastTickAt)),
    family("tradex_source_resting", "A chart/quote source is resting after errors.", "gauge", live.sources.map((source) => ({ labels: { source: source.id }, value: Number(Boolean(source.restingUntil && source.restingUntil > report.checkedAt)) }))),
  );

  const states = ["ok", "waiting", "late", "stale", "error", "missing", "info"] as const;
  families.push(
    family("tradex_dataset_state", "Each dataset's freshness state (1 for its current state).", "gauge", report.datasets.flatMap((dataset) => states.map((state) => ({ labels: { dataset: dataset.id, owner: dataset.owner, state }, value: Number(dataset.state === state) })))),
    family("tradex_dataset_stale", "1 when a dataset is stale, missing or failing to refresh.", "gauge", report.datasets.filter((dataset) => dataset.state !== "info").map((dataset) => ({ labels: { dataset: dataset.id, owner: dataset.owner }, value: Number(["stale", "missing", "error"].includes(dataset.state)) }))),
    family("tradex_dataset_as_of_timestamp_seconds", "Newest session a dataset holds (UTC midnight of its date).", "gauge", report.datasets.filter((dataset) => dataset.asOf && ISO_DAY.test(dataset.asOf)).map((dataset) => ({ labels: { dataset: dataset.id, owner: dataset.owner }, value: Date.parse(`${dataset.asOf}T00:00:00Z`) / 1000 }))),
    family("tradex_dataset_updated_timestamp_seconds", "When a dataset was last refreshed.", "gauge", report.datasets.filter((dataset) => dataset.updatedAt).map((dataset) => ({ labels: { dataset: dataset.id, owner: dataset.owner }, value: seconds(dataset.updatedAt)! }))),
    ...qualityFamilies(report),
    family("tradex_job_running", "1 while a background job runs.", "gauge", report.jobs.map((job) => ({ labels: { job: job.id, owner: job.owner }, value: Number(job.state === "running") }))),
    family("tradex_job_failed", "1 when a background job's last run failed.", "gauge", report.jobs.map((job) => ({ labels: { job: job.id, owner: job.owner }, value: Number(job.state === "failed") }))),
    ...requestMetrics.families(),
  );
  return families;
}

/** The hub's data-quality findings (absent when the hub doesn't report them). */
function qualityFamilies(report: HealthReport): MetricFamily[] {
  const quality = report.quality;
  if (!quality) return [];
  const severities = ["problem", "warning", "info"] as const;
  return [
    family("tradex_data_quality_findings", "Open data-quality findings on the hub, by severity (every date).", "gauge", severities.map((severity) => ({ labels: { severity }, value: quality.open[severity] }))),
    family("tradex_data_quality_findings_by_check", "Open data-quality findings on the hub, by check and severity.", "gauge", quality.checks.map((row) => ({ labels: { check: row.check, severity: row.severity }, value: row.count }))),
    family("tradex_data_quality_recent_findings", "Open data-quality findings about the last 30 days' trade dates, by severity.", "gauge", severities.map((severity) => ({ labels: { severity }, value: quality.recent.filter((finding) => finding.severity === severity).length }))),
    gauge("tradex_data_quality_pending_days", "Stored days the hub hasn't checked yet.", quality.pendingDays),
    gauge("tradex_data_quality_last_run_timestamp_seconds", "When the hub's data-quality checks last ran.", seconds(quality.lastRunAt)),
  ];
}

/** The Prometheus scrape body. */
export async function prometheusMetrics(): Promise<string> {
  return renderPrometheus(metricFamilies(await healthReport()));
}
