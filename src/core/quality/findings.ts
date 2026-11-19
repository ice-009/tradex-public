// The Market Data Hub's data-quality checks (market-data-hub GET /v1/quality,
// summed up in /v1/status `quality`) as Tradex shows and alerts them: the
// /health page's card and issues, the terminal's toasts and the server log.
// The hub runs the checks after every evening import; Tradex only reads them.
// Pure (shared by the server and the browser); src/contracts/api.ts re-exports the types.

/** One data-quality finding from the hub's checks (missing sessions, wrong-date files, price outliers, …). */
export interface DataQualityFinding {
  /** Stable id: check, trade date and subject. */
  key: string;
  /** The hub's check name, e.g. "missing_session", "price_outlier". */
  check: string;
  /** The check in words, e.g. "Missing session". */
  label: string;
  /** Trade date it's about (YYYY-MM-DD). */
  date: string;
  /** A symbol, a dataset, "fo", "lots" or "calendar". */
  subject: string;
  /** A symbol Tradex can chart, when the finding is about one. */
  symbol: string | null;
  severity: "problem" | "warning" | "info";
  message: string;
  /** When the hub first saw it (epoch ms). */
  firstSeenAt: number;
}

/** The hub's data-quality checks, run after every evening import. */
export interface DataQualityReport {
  /** When the checks last ran on the hub. */
  lastRunAt: number | null;
  /** Stored days not checked yet; of those, days waiting for the sessions before them (an archive download). */
  pendingDays: number;
  waitingDays: number;
  /** Open findings by severity (every date). */
  open: { problem: number; warning: number; info: number };
  /** Open findings per check and severity, with the newest trade date. */
  checks: Array<{ check: string; label: string; severity: DataQualityFinding["severity"]; count: number; newestDate: string }>;
  /** Open findings about the last 30 days' trade dates, newest first. */
  recent: DataQualityFinding[];
}

/** A /health issue (the shape of HealthIssue in src/contracts/api.ts). */
export interface QualityIssue {
  severity: "problem" | "warning" | "info";
  area: string;
  text: string;
}

/** The hub's checks in words. Unknown ones (a newer hub) fall back to their name. */
export const CHECK_LABEL: Record<string, string> = {
  missing_session: "Missing session",
  unlisted_session: "Unlisted session",
  wrong_date: "File for the wrong date",
  repeated_file: "Repeated file",
  candle_gap: "Candle gap",
  price_outlier: "Price outlier",
  broker_mismatch: "Broker vs NSE close",
  lot_change: "Lot-size change",
  fo_list_change: "F&O-list change",
  lot_file_mismatch: "Lot file vs bhavcopy",
};

export const checkLabel = (check: string) => CHECK_LABEL[check] ?? check.replace(/_/g, " ");
/** A label inside a sentence: "price outlier", but "F&O-list change" and "broker vs NSE close" keep their capitals. */
const lower = (label: string) => (/^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label);

/** Lot-size and F&O-list changes are info, but worth a toast: they change position sizes and what can be traded. */
export const ALERTED_INFO = new Set(["lot_change", "fo_list_change"]);
/** Open problems about trade dates this recent make the health verdict degraded; older ones are warnings. */
export const QUALITY_PROBLEM_DAYS = 14;
/** New findings first seen this long ago or less are alerted when the terminal opens. */
export const ALERT_LOOKBACK_MS = 36 * 3_600_000;
/** A toast shows this much of a finding's message (the /health page has all of it). */
export const TOAST_DETAIL_MAX = 160;
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…`);

const SYMBOL = /^[A-Z0-9&_-]{1,20}$/;
const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (iso: string) => {
  const [year, month, date] = iso.split("-").map(Number);
  return year && month && date ? `${date} ${MONTHS[month - 1]} ${year}` : iso;
};
const severityOf = (value: string): DataQualityFinding["severity"] => (value === "problem" || value === "warning" ? value : "info");

/** The structural shape of /v1/status `quality` (src/server/providers/hub/client.ts HubQuality). */
export interface HubQualityInput {
  lastRunAt?: number | null;
  pendingDays?: number;
  waitingDays?: number;
  open?: { problem?: number; warning?: number; info?: number };
  checks?: Array<{ check: string; severity: string; count: number; newestDate: string }>;
  recent?: Array<{ check: string; date: string; subject: string; severity: string; message: string; firstSeenAt: number }>;
}

export const findingKey = (finding: { check: string; date: string; subject: string }) => `${finding.check}|${finding.date}|${finding.subject}`;

/** The hub's `quality` block for Tradex, or null when the hub doesn't report one. */
export function qualityReport(quality: HubQualityInput | null | undefined): DataQualityReport | null {
  if (!quality || typeof quality !== "object") return null;
  return {
    lastRunAt: quality.lastRunAt ?? null,
    pendingDays: quality.pendingDays ?? 0,
    waitingDays: quality.waitingDays ?? 0,
    open: { problem: quality.open?.problem ?? 0, warning: quality.open?.warning ?? 0, info: quality.open?.info ?? 0 },
    checks: (quality.checks ?? []).map((row) => ({ check: row.check, label: checkLabel(row.check), severity: severityOf(row.severity), count: row.count, newestDate: row.newestDate })),
    recent: (quality.recent ?? []).map((finding) => ({
      key: findingKey(finding),
      check: finding.check,
      label: checkLabel(finding.check),
      date: finding.date,
      subject: finding.subject,
      symbol: SYMBOL.test(finding.subject) && !["fo", "lots", "calendar"].includes(finding.subject) ? finding.subject : null,
      severity: severityOf(finding.severity),
      message: finding.message,
      firstSeenAt: finding.firstSeenAt,
    })),
  };
}

const plural = (count: number, word: string) => `${count.toLocaleString("en-IN")} ${word}${count === 1 ? "" : "s"}`;

/**
 * The /health page's issues from the hub's findings: each open problem about
 * the last QUALITY_PROBLEM_DAYS days (older ones as warnings), one warning per
 * check for the rest, and a note while an archive download keeps days waiting.
 */
export function qualityIssues(report: DataQualityReport | null, now: number): QualityIssue[] {
  if (!report) return [];
  const issues: QualityIssue[] = [];
  const recentFrom = new Date(now - QUALITY_PROBLEM_DAYS * DAY_MS).toISOString().slice(0, 10);
  const problems = report.recent.filter((finding) => finding.severity === "problem");
  for (const finding of problems.slice(0, 5)) issues.push({ severity: finding.date >= recentFrom ? "problem" : "warning", area: "data", text: `Data quality (${lower(finding.label)}): ${finding.message}` });
  if (problems.length > 5) issues.push({ severity: "warning", area: "data", text: `Data quality: ${plural(problems.length - 5, "more problem")} in the last 30 days (see the Data quality card).` });
  const byCheck = new Map<string, DataQualityFinding[]>();
  for (const finding of report.recent) if (finding.severity === "warning") byCheck.set(finding.check, [...(byCheck.get(finding.check) ?? []), finding]);
  for (const [check, findings] of byCheck) {
    const newest = findings[0];
    issues.push({ severity: "warning", area: "data", text: findings.length === 1 ? `Data quality (${lower(checkLabel(check))}): ${newest.message}` : `Data quality: ${plural(findings.length, lower(checkLabel(check)))} in the last 30 days; newest: ${newest.message}` });
  }
  if (report.waitingDays > 0) issues.push({ severity: "info", area: "data", text: `Data quality: ${plural(report.waitingDays, "stored day")} wait to be checked until the hub's archive download stores the sessions before them.` });
  return issues;
}

/** Findings worth a toast: problems, warnings, and lot-size / F&O-list changes. */
export const alertable = (finding: DataQualityFinding) => finding.severity !== "info" || ALERTED_INFO.has(finding.check);

export interface QualityAlert {
  /** Tag for the notification (one per check and trade date). */
  tag: string;
  /** The findings it covers. */
  keys: string[];
  title: string;
  detail: string;
  severity: DataQualityFinding["severity"];
  /** Chart this symbol on click (a finding about one stock). */
  symbol: string | null;
}

/**
 * New findings to alert: alertable ones not alerted yet and first seen within
 * ALERT_LOOKBACK_MS, grouped per check and trade date (one toast each), worst first.
 */
export function pendingQualityAlerts(report: DataQualityReport | null, alerted: ReadonlySet<string>, now: number): QualityAlert[] {
  if (!report) return [];
  const groups = new Map<string, DataQualityFinding[]>();
  for (const finding of report.recent) {
    if (!alertable(finding) || alerted.has(finding.key) || now - finding.firstSeenAt > ALERT_LOOKBACK_MS) continue;
    const tag = `${finding.check}|${finding.date}`;
    groups.set(tag, [...(groups.get(tag) ?? []), finding]);
  }
  const rank = { problem: 0, warning: 1, info: 2 } as const;
  return [...groups]
    .map(([tag, findings]): QualityAlert => {
      const worst = findings.reduce((a, b) => (rank[b.severity] < rank[a.severity] ? b : a));
      const one = findings.length === 1;
      return {
        tag: `quality-${tag}`,
        keys: findings.map((finding) => finding.key),
        title: one ? `Data quality · ${worst.label}${worst.symbol ? ` · ${worst.symbol}` : ""}` : `Data quality · ${plural(findings.length, lower(worst.label))} · ${dayLabel(worst.date)}`,
        detail: one ? clip(worst.message, TOAST_DETAIL_MAX) : findings.map((finding) => finding.subject).slice(0, 8).join(", ") + (findings.length > 8 ? ` and ${findings.length - 8} more` : ""),
        severity: worst.severity,
        symbol: one ? worst.symbol : null,
      };
    })
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * Which findings the server should log: on the first look a one-line tally
 * (the server just started, nothing is new to it), then each new problem,
 * warning or lot / F&O change as the hub reports it.
 */
export class QualityWatch {
  private seen: Set<string> | null = null;

  observe(report: DataQualityReport | null): { first: boolean; fresh: DataQualityFinding[] } {
    if (!report) return { first: false, fresh: [] };
    const keys = new Set(report.recent.map((finding) => finding.key));
    if (this.seen === null) {
      this.seen = keys;
      return { first: true, fresh: [] };
    }
    const fresh = report.recent.filter((finding) => !this.seen!.has(finding.key) && alertable(finding));
    this.seen = keys;
    return { first: false, fresh };
  }
}

/** Findings of one check on one trade date at least this many: one row on the /health page. */
export const GROUP_MIN = 3;

/** The /health page's rows: findings in order, with GROUP_MIN or more of one check and date folded into one row. */
export function groupFindings(findings: readonly DataQualityFinding[]): DataQualityFinding[][] {
  const groups = new Map<string, DataQualityFinding[]>();
  for (const finding of findings) {
    const tag = `${finding.check}|${finding.date}|${finding.severity}`;
    groups.set(tag, [...(groups.get(tag) ?? []), finding]);
  }
  const rows: DataQualityFinding[][] = [];
  const placed = new Set<string>();
  for (const finding of findings) {
    const tag = `${finding.check}|${finding.date}|${finding.severity}`;
    const group = groups.get(tag)!;
    if (group.length < GROUP_MIN) rows.push([finding]);
    else if (!placed.has(tag)) {
      placed.add(tag);
      rows.push(group);
    }
  }
  return rows;
}
