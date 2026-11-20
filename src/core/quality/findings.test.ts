import { describe, expect, it } from "vitest";
import { ALERT_LOOKBACK_MS, QualityWatch, TOAST_DETAIL_MAX, checkLabel, groupFindings, pendingQualityAlerts, qualityIssues, qualityReport, type HubQualityInput } from "./findings";

const NOW = Date.parse("2026-11-18T15:00:00Z");
const finding = (check: string, date: string, subject: string, severity: string, firstSeenAt = NOW - 3_600_000) => ({ check, date, subject, severity, message: `${subject}: ${check} on ${date}.`, firstSeenAt });
const hub = (recent: HubQualityInput["recent"], extra: Partial<HubQualityInput> = {}): HubQualityInput => ({ lastRunAt: NOW, pendingDays: 0, waitingDays: 0, open: { problem: 0, warning: 0, info: 0 }, checks: [], recent, ...extra });

describe("data quality: the hub's report for Tradex", () => {
  it("names checks, keys findings and finds the symbol a finding is about", () => {
    const report = qualityReport(hub([finding("price_outlier", "2026-11-17", "M&M", "warning"), finding("missing_session", "2026-11-17", "fo_bhav", "problem"), finding("lot_change", "2026-11-17", "fo", "info"), finding("brand_new_check", "2026-11-17", "calendar", "odd")], { checks: [{ check: "price_outlier", severity: "warning", count: 3, newestDate: "2026-11-17" }] }))!;
    expect(report.recent.map((f) => [f.key, f.label, f.symbol, f.severity])).toEqual([
      ["price_outlier|2026-11-17|M&M", "Price outlier", "M&M", "warning"],
      ["missing_session|2026-11-17|fo_bhav", "Missing session", null, "problem"],
      ["lot_change|2026-11-17|fo", "Lot-size change", null, "info"],
      ["brand_new_check|2026-11-17|calendar", "brand new check", null, "info"],
    ]);
    expect(report.checks).toEqual([{ check: "price_outlier", label: "Price outlier", severity: "warning", count: 3, newestDate: "2026-11-17" }]);
    expect(qualityReport(undefined)).toBeNull();
    expect(qualityReport({})).toMatchObject({ lastRunAt: null, open: { problem: 0, warning: 0, info: 0 }, recent: [] });
    expect(checkLabel("wrong_date")).toBe("File for the wrong date");
  });

  it("raises recent problems as problems, older ones and grouped warnings as warnings", () => {
    const report = qualityReport(hub([finding("missing_session", "2026-11-17", "fo_bhav", "problem"), finding("repeated_file", "2026-10-20", "cash_bhav", "problem"), finding("candle_gap", "2026-11-08", "ABB", "warning"), finding("candle_gap", "2026-11-08", "LT", "warning"), finding("broker_mismatch", "2026-11-02", "INFY", "warning")], { waitingDays: 71 }));
    expect(qualityIssues(report, NOW)).toEqual([
      { severity: "problem", area: "data", text: "Data quality (missing session): fo_bhav: missing_session on 2026-11-17." },
      { severity: "warning", area: "data", text: "Data quality (repeated file): cash_bhav: repeated_file on 2026-10-20." },
      { severity: "warning", area: "data", text: "Data quality: 2 candle gaps in the last 30 days; newest: ABB: candle_gap on 2026-11-08." },
      { severity: "warning", area: "data", text: "Data quality (broker vs NSE close): INFY: broker_mismatch on 2026-11-02." },
      { severity: "info", area: "data", text: "Data quality: 71 stored days wait to be checked until the hub's archive download stores the sessions before them." },
    ]);
    expect(qualityIssues(null, NOW)).toEqual([]);
  });
});

describe("data quality: alerts", () => {
  const report = qualityReport(
    hub([
      finding("price_outlier", "2026-11-17", "ACME", "warning"),
      finding("price_outlier", "2026-11-17", "XYZ", "warning"),
      finding("price_outlier", "2026-11-17", "LOW", "info"), // a circuit: not alerted
      finding("missing_session", "2026-11-17", "fo_bhav", "problem"),
      finding("lot_change", "2026-11-17", "fo", "info"),
      finding("broker_mismatch", "2026-11-16", "TRENT", "info"), // an adjusted corporate action: not alerted
      finding("candle_gap", "2026-11-08", "ABB", "warning", NOW - ALERT_LOOKBACK_MS - 1), // seen too long ago
    ]),
  );

  it("groups new findings per check and day, worst first, and skips what flashed or is old", () => {
    const alerts = pendingQualityAlerts(report, new Set(), NOW);
    expect(alerts.map((alert) => [alert.tag, alert.severity, alert.title, alert.detail, alert.symbol])).toEqual([
      ["quality-missing_session|2026-11-17", "problem", "Data quality · Missing session", "fo_bhav: missing_session on 2026-11-17.", null],
      ["quality-price_outlier|2026-11-17", "warning", "Data quality · 2 price outliers · 17 Nov 2026", "ACME, XYZ", null],
      ["quality-lot_change|2026-11-17", "info", "Data quality · Lot-size change", "fo: lot_change on 2026-11-17.", null],
    ]);
    const flashed = new Set(alerts.flatMap((alert) => alert.keys));
    expect(pendingQualityAlerts(report, flashed, NOW)).toEqual([]);
    // One stock's finding opens its chart.
    const one = pendingQualityAlerts(report, new Set([...flashed].filter((key) => key !== "price_outlier|2026-11-17|ACME")), NOW);
    expect(one).toMatchObject([{ title: "Data quality · Price outlier · ACME", symbol: "ACME" }]);
  });

  it("logs a tally first, then only what's new and worth saying", () => {
    const watch = new QualityWatch();
    expect(watch.observe(null)).toEqual({ first: false, fresh: [] });
    expect(watch.observe(report)).toEqual({ first: true, fresh: [] });
    expect(watch.observe(report).fresh).toEqual([]);
    const next = qualityReport(hub([finding("wrong_date", "2026-11-18", "cash_bhav", "warning"), finding("price_outlier", "2026-11-18", "LOW", "info")]));
    expect(watch.observe(next).fresh.map((f) => f.key)).toEqual(["wrong_date|2026-11-18|cash_bhav"]);
  });
});

describe("data quality: the /health page's rows", () => {
  it("folds three or more findings of one check and date into one row, in place", () => {
    const report = qualityReport(hub([finding("price_outlier", "2026-11-17", "ACME", "warning"), ...["ABB", "LT", "TCS"].map((symbol) => finding("candle_gap", "2026-11-08", symbol, "warning")), finding("candle_gap", "2026-11-07", "INFY", "warning")]))!;
    expect(groupFindings(report.recent).map((row) => row.map((f) => f.subject))).toEqual([["ACME"], ["ABB", "LT", "TCS"], ["INFY"]]);
  });

  it("keeps a toast short", () => {
    const long = qualityReport(hub([{ ...finding("price_outlier", "2026-11-17", "ACME", "warning"), message: `ACME: ${"word ".repeat(80)}` }]));
    const [alert] = pendingQualityAlerts(long, new Set(), NOW);
    expect(alert.detail.length).toBeLessThanOrEqual(TOAST_DETAIL_MAX);
    expect(alert.detail.endsWith("word…")).toBe(true);
  });
});
