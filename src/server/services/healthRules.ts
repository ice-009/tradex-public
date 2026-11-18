import { DAY_MS, SESSION_CLOSE_MIN, SESSION_OPEN_MIN, isWeekday, istParts } from "@/core/market/session";
import type { DatasetHealth, HealthIssue, HealthReport, JobHealth } from "@/contracts/api";
import type { HubDataset, HubJob, HubRecovery } from "@/server/providers/hub/client";

// The /health page's judgement: is each dataset fresh, what background work
// is running, and — the point of the page — why a number may be old. Pure
// functions of the state gathered by ./health.ts, so every rule is unit-tested.
//
// No server-only import: unit-tested.

/** The hub stores a trading day's NSE files by 20:00 IST (its health check flags them after that). */
export const NSE_DUE_MIN = 20 * 60;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-17" → "17 Nov 2026". */
export function dayLabel(iso: string): string {
  const [year, month, date] = iso.slice(0, 10).split("-").map(Number);
  return year && month && date ? `${date} ${MONTHS[month - 1]} ${year}` : iso;
}

/** Day key → "2026-11-17". */
export const isoDay = (dayKey: number) => new Date(dayKey).toISOString().slice(0, 10);

/** Epoch ms → "14:05 IST". */
export function istClock(ms: number): string {
  const { minutes } = istParts(ms);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")} IST`;
}

/** A duration in words: "40 s", "12 min", "3 h", "4 days". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

const thousands = (value: number) => value.toLocaleString("en-IN");

// ------------------------------------------------------------------ market session

/** Is the regular session open, in words (exchange holidays aren't known here). */
export function marketState(now: number): HealthReport["market"] {
  const { minutes, weekday } = istParts(now);
  if (weekday === 0 || weekday === 6) return { open: false, label: "Closed: weekend. Prices are Friday's; live prices resume Monday 09:15 IST." };
  if (minutes < SESSION_OPEN_MIN) return { open: false, label: "Before the open: prices are the last session's until 09:15 IST." };
  if (minutes <= SESSION_CLOSE_MIN) return { open: true, label: "Open until 15:30 IST (unless today is an exchange holiday)." };
  return { open: false, label: "Closed for the day: prices are today's close; live prices resume at 09:15 IST." };
}

// ------------------------------------------------------------------ hub datasets

export interface HubDatasetMeta {
  id: "cashBhav" | "foBhav" | "lots" | "foBan" | "resultsCalendar";
  label: string;
  /** How the hub's health messages name it (market-data-hub src/health.ts). */
  hubLabel: string;
  /** A trading day's NSE file (expected every session evening), or a reference file refreshed daily. */
  kind: "session" | "reference";
  usedBy: string;
  /** What being old means in Tradex, given the date it holds. */
  effect: (asOf: string | null) => string;
}

export const HUB_DATASETS: HubDatasetMeta[] = [
  {
    id: "cashBhav",
    label: "Daily bars & delivery % (NSE bhavcopy)",
    hubLabel: "Cash bhavcopy",
    kind: "session",
    usedBy: "Screener, plan, backtests, trade journal",
    effect: (asOf) => `Final daily bars and delivery % end at ${asOf ? dayLabel(asOf) : "the last stored session"}; during the session today's bar comes from live quotes.`,
  },
  {
    id: "foBhav",
    label: "Futures OI & F&O list (NSE F&O bhavcopy)",
    hubLabel: "F&O bhavcopy",
    kind: "session",
    usedBy: "Screener's OI tag; point-in-time F&O list in backtests and plan evidence",
    effect: (asOf) => `The screener's OI tag shows ${asOf ? dayLabel(asOf) : "the last stored day"}'s open interest.`,
  },
  { id: "lots", label: "Lot sizes", hubLabel: "Lot sizes", kind: "reference", usedBy: "Plan sizing, order ticket, backtests", effect: () => "The last fetched lot sizes are used." },
  { id: "foBan", label: "F&O ban list", hubLabel: "F&O ban list", kind: "reference", usedBy: "Plan (banned stocks are left out)", effect: (asOf) => `The plan uses the ban list for ${asOf ? dayLabel(asOf) : "the last stored day"}.` },
  { id: "resultsCalendar", label: "Results calendar", hubLabel: "Results calendar", kind: "reference", usedBy: "Results screen and results-day warnings", effect: () => "Results dates announced since the last fetch are missing." },
];

const mentions = (messages: string[], label: string) => messages.find((message) => message.startsWith(label)) ?? null;

/** The newest attempt failed (the data may still be fine from an earlier success). */
function failedAttempt(entry: HubDataset | undefined): string | null {
  if (!entry?.lastError) return null;
  if (entry.lastSuccessAt && entry.lastAttemptAt && entry.lastAttemptAt <= entry.lastSuccessAt) return null;
  return entry.lastError;
}

/**
 * One hub dataset's freshness. The hub's own health check decides "stale" (it
 * knows exchange holidays); this adds "waiting" — today's file isn't due until
 * the evening — and what each state means in Tradex.
 */
export function hubDatasetHealth(meta: HubDatasetMeta, entry: HubDataset | undefined, context: { now: number; problems: string[]; warnings: string[] }): DatasetHealth {
  const asOf = entry?.lastSession ?? entry?.tradeDate ?? null;
  const updatedAt = entry?.lastSuccessAt ?? null;
  const detail = meta.id === "lots" && entry?.count ? `${thousands(entry.count)} lot sizes` : meta.id === "resultsCalendar" && entry?.events ? `${thousands(entry.events)} events` : null;
  const error = failedAttempt(entry);
  const problem = mentions(context.problems, meta.hubLabel);
  const warning = mentions(context.warnings, meta.hubLabel);
  const base = { id: meta.id, label: meta.label, owner: "hub" as const, asOf, updatedAt, detail, error, usedBy: meta.usedBy };

  if (!asOf && !updatedAt) return { ...base, state: "missing", message: problem ?? "The hub has nothing stored yet." };
  if (problem) return { ...base, state: "stale", message: `${problem} ${meta.effect(asOf)}` };
  if (warning) return { ...base, state: "late", message: `${warning} ${meta.effect(asOf)}` };
  if (error) return { ...base, state: "error", message: `The hub's last refresh failed; it keeps using the copy from ${updatedAt ? `${duration(context.now - updatedAt)} ago` : "earlier"} and tries again.` };
  if (meta.kind === "session" && asOf) {
    const { day: today, minutes } = istParts(context.now);
    if (isWeekday(today) && minutes >= SESSION_OPEN_MIN && minutes < NSE_DUE_MIN && asOf < isoDay(today)) {
      return { ...base, state: "waiting", message: `Today's file comes out after the close; the hub stores it by about 20:00 IST. ${meta.effect(asOf)}` };
    }
  }
  return { ...base, state: "ok", message: null };
}

/** The hub's stored candles per timeframe: information, not judged (charts read newer candles on demand). */
export function candleDatasets(candles: Array<{ tf: string; series: number; candles: number; lastSession?: string | null }>): DatasetHealth[] {
  return candles.map((row) => ({
    id: `candles-${row.tf}`,
    label: `Stored candles · ${row.tf}`,
    owner: "hub",
    state: "info",
    asOf: row.lastSession ? row.lastSession.slice(0, 10) : null,
    updatedAt: null,
    detail: `${thousands(row.series)} series · ${thousands(row.candles)} candles`,
    message: row.tf === "1d" ? null : "What the hub has downloaded; a chart asks it for newer candles when it opens.",
    error: null,
    usedBy: row.tf === "1d" ? "Daily charts, screener's daily bars" : "Intraday charts",
  }));
}

// ------------------------------------------------------------------ Tradex's own caches

export interface StoreState {
  phase: "idle" | "history" | "done" | "error";
  message: string;
  finishedAt: number | null;
  queued: number;
  /** Day key of NIFTY's newest stored bar, or null before the first read. */
  lastBar: number | null;
}

/** The screener's daily-bar store (Tradex's copy of the hub's daily bars). `hubAsOf`: the cash bhavcopy's newest session. */
export function storeHealth(store: StoreState, hubAsOf: string | null): DatasetHealth {
  const asOf = store.lastBar ? isoDay(store.lastBar) : null;
  const base = { id: "tradex-daily", label: "Screener daily bars (Tradex's copy)", owner: "tradex" as const, asOf, updatedAt: store.finishedAt, detail: null, error: null, usedBy: "Screener, plan, backtests, trade journal" };
  if (store.phase === "error") return { ...base, state: "error", error: store.message, message: "Reading daily bars from the hub failed; the stored copy is used and it tries again in 30 s." };
  if (store.phase === "idle" && !asOf) return { ...base, state: "info", message: "Not read yet: it loads when the screener, plan or a backtest opens." };
  if (store.queued > 0) return { ...base, state: "waiting", message: `The hub is downloading ${store.queued} symbol${store.queued === 1 ? "" : "s"}; Tradex asks again every 30 s.` };
  if (store.phase === "history") return { ...base, state: "waiting", message: store.message || "Reading daily bars from the hub." };
  if (asOf && hubAsOf && asOf < hubAsOf) {
    return { ...base, state: "stale", message: `Tradex holds bars through ${dayLabel(asOf)}; the hub has ${dayLabel(hubAsOf)}. It re-reads the hub every 15 minutes while the screener or plan is open.` };
  }
  return { ...base, state: "ok", message: null };
}

/** The screener's OI tag (held for 30 minutes). `hubAsOf`: the F&O bhavcopy's newest session. */
export function oiTagHealth(oi: { day: number | null; fetchedAt: number | null; answered: boolean }, hubAsOf: string | null, now: number): DatasetHealth {
  const asOf = oi.day ? isoDay(oi.day) : null;
  const base = { id: "tradex-oi", label: "Screener OI tag (Tradex's copy)", owner: "tradex" as const, asOf, updatedAt: oi.fetchedAt, detail: null, error: null, usedBy: "Screener's OI column" };
  if (!oi.fetchedAt) return { ...base, state: "info", message: "Not read yet: it loads when the screener opens." };
  if (!asOf) return { ...base, state: oi.answered ? "missing" : "error", message: oi.answered ? "The hub has no open interest stored." : "Reading open interest from the hub failed; it tries again in 5 minutes." };
  if (istParts(now).day - (oi.day ?? 0) > 7 * DAY_MS) return { ...base, state: "stale", message: `The newest OI is from ${dayLabel(asOf)}, over a week old: the screener hides the tag.` };
  if (hubAsOf && asOf < hubAsOf) return { ...base, state: "stale", message: `Tradex holds ${dayLabel(asOf)}'s OI; the hub has ${dayLabel(hubAsOf)}. It re-reads every 30 minutes.` };
  return { ...base, state: "ok", message: null };
}

/** The plan's strategy evidence (recomputed once a day from the stored bars). */
export function evidenceDataset(evidence: { through: number | null; computedAt: number | null; pending: { done: number; total: number } | null; error: { message: string } | null }): DatasetHealth {
  const asOf = evidence.through ? isoDay(evidence.through) : null;
  const base = { id: "tradex-evidence", label: "Plan evidence (Tradex)", owner: "tradex" as const, asOf, updatedAt: evidence.computedAt, detail: null, error: evidence.error?.message ?? null, usedBy: "Plan tab: which screens pass in today's market" };
  if (evidence.pending) return { ...base, state: "waiting", message: `Recomputing (${evidence.pending.done} / ${evidence.pending.total || "?"} sessions); the plan shows the previous table meanwhile.` };
  if (evidence.error && !evidence.computedAt) return { ...base, state: "error", message: "Computing the evidence failed; the Plan tab retries in a minute." };
  if (!evidence.computedAt) return { ...base, state: "info", message: "Not computed yet: it runs when the Plan tab opens." };
  return { ...base, state: "ok", message: null };
}

// ------------------------------------------------------------------ jobs

const plural = (count: number, word: string) => `${thousands(count)} ${word}${count === 1 ? "" : "s"}`;

function jobLabel(job: HubJob): string {
  const params = job.params && typeof job.params === "object" ? (job.params as Record<string, unknown>) : null;
  const what = params ? [params.tf, params.universe ?? params.symbols, params.from && `from ${String(params.from)}`].filter((part) => typeof part === "string" && part).join(" ") : "";
  return `Hub ${job.kind.replace(/[_-]/g, " ")}${what ? ` (${what.slice(0, 60)})` : ""}`;
}

export function hubJobs(jobs: HubJob[], recovery: HubRecovery | null | undefined): JobHealth[] {
  const out: JobHealth[] = jobs.map((job) => ({
    id: `hub-job-${job.id}`,
    label: jobLabel(job),
    owner: "hub",
    state: job.state,
    progress: job.total ? `${thousands(job.done)} / ${thousands(job.total)}${job.failed ? ` · ${plural(job.failed, "failure")}` : ""}` : null,
    message: [job.message, job.state === "paused" && job.resumeAfter ? `resumes ${istClock(job.resumeAfter)}` : ""].filter(Boolean).join(" · ") || null,
    updatedAt: job.updatedAt ?? null,
  }));
  if (recovery) {
    const last = recovery.last;
    out.push({
      id: "hub-recovery",
      label: "Hub live gap repair (1-minute bars)",
      owner: "hub",
      state: recovery.running ? "running" : recovery.pending ? "queued" : "idle",
      progress: last ? `last run: ${plural(last.calls ?? 0, "call")}, ${plural(last.bars ?? 0, "bar")}` : null,
      message: last?.error ?? (recovery.pending ? `${plural(recovery.pending, "repair")} waiting` : null),
      updatedAt: last ? (last.finishedAt ?? last.startedAt) : null,
    });
  }
  return out;
}

export function tradexJobs(input: {
  store: StoreState & { done: number; total: number };
  evidence: { computedAt: number | null; pending: { startedAt: number; done: number; total: number } | null; error: { message: string; at: number } | null };
  highLow: { running: boolean; status: string; lastPollAt: number | null; sweepMs: number | null; instruments: number };
}): JobHealth[] {
  const { store, evidence, highLow } = input;
  return [
    {
      id: "tradex-daily-sync",
      label: "Daily-bar sync from the hub",
      owner: "tradex",
      state: store.phase === "history" ? "running" : store.phase === "error" ? "failed" : store.phase === "done" ? "done" : "idle",
      progress: store.phase === "history" && store.total ? `${thousands(store.done)} / ${thousands(store.total)}` : null,
      message: store.message || null,
      updatedAt: store.finishedAt,
    },
    {
      id: "tradex-evidence",
      label: "Plan evidence",
      owner: "tradex",
      state: evidence.pending ? "running" : evidence.error && (!evidence.computedAt || evidence.error.at > evidence.computedAt) ? "failed" : evidence.computedAt ? "done" : "idle",
      progress: evidence.pending ? `${thousands(evidence.pending.done)} / ${thousands(evidence.pending.total)} sessions` : null,
      message: evidence.error?.message ?? null,
      updatedAt: evidence.pending?.startedAt ?? evidence.computedAt,
    },
    {
      id: "tradex-highlow",
      label: "Day High/Low sweep",
      owner: "tradex",
      state: highLow.running ? "running" : "idle",
      progress: highLow.instruments ? plural(highLow.instruments, "instrument") : null,
      message: !highLow.running
        ? "Runs only while its panel is open during market hours."
        : highLow.status === "live"
          ? highLow.sweepMs
            ? `Sweeps every ${duration(highLow.sweepMs)}, paced from the hub's budget.`
            : "The background budget for today is spent: only stream ticks are checked."
          : highLow.status === "closed"
            ? "Market closed."
            : highLow.status === "no-hub"
              ? "No hub."
              : null,
      updatedAt: highLow.lastPollAt,
    },
  ];
}

// ------------------------------------------------------------------ issues and verdict

export interface AssessInput {
  now: number;
  market: HealthReport["market"];
  hub: HealthReport["hub"];
  budget: HealthReport["budget"];
  live: HealthReport["live"];
  datasets: DatasetHealth[];
  jobs: JobHealth[];
}

/** Share of the hub's daily broker budget after which Tradex's paced refreshes slow down noticeably. */
const BUDGET_WARN = 0.85;
/** During the session, no tick to any open chart for this long is worth saying. */
const QUIET_TICKS_MS = 2 * 60_000;

/** Why numbers may be old, worst first, and the verdict. */
export function assessHealth(input: AssessInput): { verdict: HealthReport["verdict"]; issues: HealthIssue[] } {
  const { now, hub, budget, live, market } = input;
  const issues: HealthIssue[] = [];
  const add = (severity: HealthIssue["severity"], area: string, text: string) => {
    if (!issues.some((issue) => issue.text === text)) issues.push({ severity, area, text });
  };

  if (!hub.configured) {
    add("problem", "hub", "No Market Data Hub is configured (HUB_URL and HUB_KEY): charts show sample data, and the screener, plan and backtests have no data.");
    return { verdict: "down", issues };
  }
  if (!hub.reachable) {
    add("problem", "hub", `Tradex can't reach the hub at ${hub.url}${hub.error ? ` (${hub.error})` : ""}. Charts fall back to sample data; the screener and plan keep the bars they already hold.`);
  }

  for (const problem of hub.problems) add("problem", "hub", `Hub: ${problem}`);
  for (const warning of hub.warnings) add("warning", "hub", `Hub: ${warning}`);

  for (const source of live.sources) {
    if (source.restingUntil && source.restingUntil > now) {
      add("problem", "tradex", `${source.label} is resting until ${istClock(source.restingUntil)} after an error${source.lastError ? ` (${source.lastError})` : ""}: charts and quotes use cached or sample data meanwhile.`);
    }
  }

  const stream = live.hubStream;
  if (market.open && stream?.running && !stream.open && stream.failures > 0) {
    add("problem", "live", `Tradex's live stream from the hub is down${stream.lastError ? ` (${stream.lastError})` : ""}; prices are polled every 15 s instead.`);
  }
  if (market.open && live.market.subscribers > 0 && live.market.lastTickAt && now - live.market.lastTickAt > QUIET_TICKS_MS) {
    add("warning", "live", `No live price has arrived for ${duration(now - live.market.lastTickAt)} while the market is open.`);
  }

  if (budget && budget.dayCap > 0 && budget.usedToday / budget.dayCap >= BUDGET_WARN && !budget.stoppedForToday) {
    add("warning", "budget", `The hub has used ${Math.round((budget.usedToday / budget.dayCap) * 100)}% of today's broker calls: the screener's live quotes and the Day High/Low sweep refresh less often.`);
  }

  for (const dataset of input.datasets) {
    // The hub's own problems already describe its datasets; add what only Tradex knows.
    const hubSaid = dataset.owner === "hub" && (dataset.state === "stale" || dataset.state === "late" || dataset.state === "missing");
    if (hubSaid) continue;
    if (dataset.state === "stale") add("problem", "data", `${dataset.label}: ${dataset.message}`);
    else if (dataset.state === "error") add("warning", "data", `${dataset.label}: ${dataset.message}${dataset.error ? ` (${dataset.error})` : ""}`);
    else if (dataset.state === "waiting" && dataset.owner === "tradex") add("info", "data", `${dataset.label}: ${dataset.message}`);
  }

  for (const job of input.jobs) if (job.state === "failed") add("warning", "jobs", `${job.label} failed${job.message ? `: ${job.message}` : ""}.`);

  if (!market.open) add("info", "market", `Market: ${market.label}`);

  const rank = { problem: 0, warning: 1, info: 2 } as const;
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const verdict = !hub.reachable ? "down" : issues.some((issue) => issue.severity === "problem") ? "degraded" : "ok";
  return { verdict, issues };
}
