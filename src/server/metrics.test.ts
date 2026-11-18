import { describe, expect, it } from "vitest";
import { DURATION_BUCKETS, RequestMetrics, gauge, renderPrometheus } from "./metrics";

describe("Prometheus text format", () => {
  it("renders HELP, TYPE and samples with escaped labels", () => {
    const text = renderPrometheus([
      gauge("tradex_hub_reachable", "The hub answered.", true),
      { name: "tradex_dataset_stale", help: 'Stale "datasets"\nper id', type: "gauge", samples: [{ labels: { dataset: 'cash"Bhav\\x' }, value: 1 }] },
    ]);
    expect(text).toBe(
      [
        "# HELP tradex_hub_reachable The hub answered.",
        "# TYPE tradex_hub_reachable gauge",
        "tradex_hub_reachable 1",
        '# HELP tradex_dataset_stale Stale "datasets"\\nper id',
        "# TYPE tradex_dataset_stale gauge",
        'tradex_dataset_stale{dataset="cash\\"Bhav\\\\x"} 1',
        "",
      ].join("\n"),
    );
  });

  it("leaves out families without samples and unknown values", () => {
    expect(renderPrometheus([gauge("tradex_hub_healthy", "Unknown.", null), gauge("bad name", "x", 1)])).toBe("\n");
  });

  it("writes infinities and NaN the way Prometheus reads them", () => {
    expect(renderPrometheus([{ name: "x", help: "x", type: "gauge", samples: [{ value: Infinity }, { value: NaN }] }])).toContain("x +Inf\nx NaN");
  });
});

describe("request metrics", () => {
  it("counts by route, method and status class, with a cumulative duration histogram", () => {
    const metrics = new RequestMetrics();
    metrics.record("Chart", "GET", 200, 0.04);
    metrics.record("Chart", "GET", 200, 0.3);
    metrics.record("Chart", "GET", 503, 12);
    const [total, duration] = metrics.families();
    expect(total.samples).toEqual([
      { labels: { route: "Chart", method: "GET", status: "2xx" }, value: 2 },
      { labels: { route: "Chart", method: "GET", status: "5xx" }, value: 1 },
    ]);
    const bucket = (le: string) => duration.samples.find((sample) => sample.suffix === "_bucket" && sample.labels?.le === le)?.value;
    expect(bucket("0.05")).toBe(1);
    expect(bucket("0.5")).toBe(2);
    expect(bucket("10")).toBe(2);
    expect(bucket("30")).toBe(3);
    expect(bucket("+Inf")).toBe(3);
    expect(duration.samples.filter((sample) => sample.suffix === "_bucket")).toHaveLength(DURATION_BUCKETS.length + 1);
    expect(duration.samples.find((sample) => sample.suffix === "_count")?.value).toBe(3);
    expect(duration.samples.find((sample) => sample.suffix === "_sum")?.value).toBeCloseTo(12.34);
    expect(renderPrometheus(metrics.families())).toContain('tradex_http_request_duration_seconds_bucket{route="Chart",method="GET",le="+Inf"} 3');
  });
});
