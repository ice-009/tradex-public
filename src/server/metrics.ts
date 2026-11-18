// Prometheus text format (version 0.0.4), without a client library: metric
// families are plain objects, rendered at scrape time by `renderPrometheus`.
// Request counters and durations are recorded here by `authed()`
// (src/server/http.ts); everything else is read from current state when
// /api/metrics is scraped (src/server/services/metrics.ts).
//
// No server-only import: unit-tested.

export type MetricType = "counter" | "gauge" | "histogram";
export type Labels = Record<string, string>;

export interface MetricSample {
  labels?: Labels;
  value: number;
  /** Appended to the family name: `_bucket`, `_sum`, `_count` for histograms. */
  suffix?: string;
}

export interface MetricFamily {
  name: string;
  help: string;
  type: MetricType;
  samples: MetricSample[];
}

const escapeHelp = (text: string) => text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
const escapeLabel = (text: string) => text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return String(value);
}

function formatLabels(labels: Labels | undefined): string {
  const entries = Object.entries(labels ?? {}).filter(([name]) => NAME.test(name));
  return entries.length ? `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}` : "";
}

/** The text a Prometheus server scrapes. Families with no samples are left out. */
export function renderPrometheus(families: MetricFamily[]): string {
  const lines: string[] = [];
  for (const family of families) {
    if (!NAME.test(family.name) || !family.samples.length) continue;
    lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples) lines.push(`${family.name}${sample.suffix ?? ""}${formatLabels(sample.labels)} ${formatValue(sample.value)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** A gauge from a value; null/undefined leaves the sample out. */
export function gauge(name: string, help: string, value: number | boolean | null | undefined, labels?: Labels): MetricFamily {
  return { name, help, type: "gauge", samples: value === null || value === undefined ? [] : [{ value: Number(value), labels }] };
}

// ------------------------------------------------------------------ request metrics

/** Upper bounds (seconds) of the request-duration histogram. */
export const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

interface RouteStats {
  route: string;
  method: string;
  /** Status class ("2xx", "4xx", …) → count. */
  byStatus: Map<string, number>;
  buckets: number[];
  sum: number;
  count: number;
}

export class RequestMetrics {
  private readonly routes = new Map<string, RouteStats>();

  /** One handled request: its route name, method, HTTP status and duration in seconds. */
  record(route: string, method: string, status: number, seconds: number) {
    const key = `${route}\u0000${method}`;
    let stats = this.routes.get(key);
    if (!stats) {
      stats = { route, method, byStatus: new Map(), buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 };
      this.routes.set(key, stats);
    }
    const statusClass = `${Math.floor(status / 100)}xx`;
    stats.byStatus.set(statusClass, (stats.byStatus.get(statusClass) ?? 0) + 1);
    DURATION_BUCKETS.forEach((bound, index) => {
      if (seconds <= bound) stats.buckets[index] += 1;
    });
    stats.sum += seconds;
    stats.count += 1;
  }

  families(): MetricFamily[] {
    const all = [...this.routes.values()];
    const total: MetricFamily = { name: "tradex_http_requests_total", help: "API requests handled, by route, method and status class.", type: "counter", samples: [] };
    const duration: MetricFamily = { name: "tradex_http_request_duration_seconds", help: "API request duration, by route and method.", type: "histogram", samples: [] };
    for (const stats of all) {
      const labels = { route: stats.route, method: stats.method };
      for (const [status, count] of stats.byStatus) total.samples.push({ labels: { ...labels, status }, value: count });
      DURATION_BUCKETS.forEach((bound, index) => duration.samples.push({ suffix: "_bucket", labels: { ...labels, le: String(bound) }, value: stats.buckets[index] }));
      duration.samples.push({ suffix: "_bucket", labels: { ...labels, le: "+Inf" }, value: stats.count });
      duration.samples.push({ suffix: "_sum", labels, value: Math.round(stats.sum * 1e6) / 1e6 });
      duration.samples.push({ suffix: "_count", labels, value: stats.count });
    }
    return [total, duration];
  }
}

const globalForMetrics = globalThis as unknown as { tradexRequestMetrics?: RequestMetrics };
/** The process's request metrics (kept across hot reloads). */
export const requestMetrics: RequestMetrics = (globalForMetrics.tradexRequestMetrics ??= new RequestMetrics());
