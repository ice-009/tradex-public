import { authedOrToken } from "@/server/http";
import { prometheusMetrics } from "@/server/services/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Prometheus metrics (text format). Needs a signed-in session, or
 * `Authorization: Bearer <METRICS_TOKEN>` when METRICS_TOKEN is set (for a scraper).
 */
export const GET = authedOrToken("METRICS_TOKEN", "Metrics", "Unable to collect metrics right now.", async () =>
  new Response(await prometheusMetrics(), { headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" } }),
);
