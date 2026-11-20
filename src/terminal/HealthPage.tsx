"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { DataQualityFinding, DatasetHealth, FreshnessState, HealthReport, JobHealth } from "@/contracts/api";
import { api } from "@/client/api";
import { groupFindings } from "@/core/quality/findings";
import { HUB_DOCS_URL } from "./MarketDataDialog";

// /health: answers "why is this number old?" — the hub connection, how fresh
// each dataset is (the hub's and Tradex's own copies), the broker budget, every
// socket between the broker and this browser, background jobs and the
// server's recent warnings and errors, and the hub's data-quality findings.
// Read-only; refreshes every 15 s.

const EVERY_MS = 15_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_MS = 5.5 * 60 * 60 * 1000;

const thousands = (value: number) => value.toLocaleString("en-IN");
const day = (iso: string) => {
  const [year, month, date] = iso.slice(0, 10).split("-").map(Number);
  return year && month && date ? `${date} ${MONTHS[month - 1]} ${year}` : iso;
};
/** "14:05" IST, with the date when it isn't the same IST day as `now`. */
function clock(at: number, now: number) {
  const ist = new Date(at + IST_MS);
  const time = `${String(ist.getUTCHours()).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")}`;
  const sameDay = new Date(now + IST_MS).toISOString().slice(0, 10) === ist.toISOString().slice(0, 10);
  return sameDay ? time : `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${time}`;
}
function span(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}
const ago = (at: number | null | undefined, now: number) => (at ? `${span(now - at)} ago` : "—");
const yesNo = (value: boolean | null, yes: string, no: string) => (value === null ? "—" : value ? yes : no);

const VERDICT: Record<HealthReport["verdict"], string> = { ok: "Everything is current", degraded: "Something is stale or failing", down: "No market data" };
const STATE_LABEL: Record<FreshnessState, string> = { ok: "Fresh", waiting: "Waiting", late: "Late", stale: "Stale", error: "Refresh failed", missing: "Missing", info: "—" };
const STATE_TONE: Record<FreshnessState, string> = { ok: "is-ok", waiting: "is-wait", late: "is-warn", stale: "is-bad", error: "is-warn", missing: "is-bad", info: "" };
const JOB_TONE: Record<string, string> = { running: "is-ok", queued: "is-wait", paused: "is-warn", failed: "is-bad", done: "", idle: "", cancelled: "" };

export function HealthPage() {
  const { status: session } = useSession();
  const router = useRouter();
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (session === "unauthenticated") router.push("/auth/signin");
  }, [router, session]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await api.health());
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session !== "authenticated") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const tick = async () => {
      await load();
      if (!cancelled) timer = setTimeout(tick, EVERY_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load, session]);

  if (session !== "authenticated") {
    return (
      <div className="tx-boot">
        <span className="tx-spinner" />
      </div>
    );
  }

  const now = report?.checkedAt ?? 0;
  return (
    <div className="tx-health">
      <header className="tx-health-head">
        <Link href="/" className="tx-health-back">
          ← Terminal
        </Link>
        <h1>Health</h1>
        {report && <span className={`tx-health-verdict is-${report.verdict}`}>{VERDICT[report.verdict]}</span>}
        <span className="tx-health-checked">
          {report ? `Checked ${clock(report.checkedAt, report.checkedAt)} IST · every ${EVERY_MS / 1000} s` : ""}
          <button type="button" className="tx-btn-outline" onClick={() => void load()} disabled={loading}>
            {loading ? "Checking…" : "Check now"}
          </button>
        </span>
      </header>

      {error && <p className="tx-health-error">Couldn&apos;t read the server&apos;s health: {error}</p>}
      {!report ? (
        !error && <p className="tx-dim">Loading…</p>
      ) : (
        <>
          <Issues report={report} />
          <div className="tx-health-grid">
            <HubCard report={report} now={now} />
            <BudgetCard report={report} now={now} />
            <LiveCard report={report} now={now} />
          </div>
          <Datasets datasets={report.datasets} now={now} />
          <Quality report={report} now={now} />
          <div className="tx-health-grid is-two">
            <Jobs jobs={report.jobs} now={now} />
            <ServerCard report={report} now={now} />
          </div>
          <Errors report={report} now={now} />
        </>
      )}
    </div>
  );
}

function Card({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`tx-health-card${wide ? " is-wide" : ""}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: Array<[string, ReactNode, string?]> }) {
  return (
    <dl className="tx-health-facts">
      {rows.map(([name, value, tone]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd className={tone}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Issues({ report }: { report: HealthReport }) {
  return (
    <section className="tx-health-why" aria-label="Why might a number be old?">
      <h2>Why might a number be old?</h2>
      {report.issues.length === 0 ? (
        <p className="tx-dim">Nothing is stale: every dataset is current, the hub is healthy and live prices are flowing.</p>
      ) : (
        <ul>
          {report.issues.map((issue) => (
            <li key={issue.text} className={`is-${issue.severity}`}>
              <span className="tx-health-dot" aria-hidden />
              <span>{issue.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HubCard({ report, now }: { report: HealthReport; now: number }) {
  const { hub, broker } = report;
  if (!hub.configured) {
    return (
      <Card title="Market Data Hub">
        <p className="tx-health-note">
          No hub configured. Set <code>HUB_URL</code> and <code>HUB_KEY</code> in <code>.env</code> and restart.{" "}
          <a href={HUB_DOCS_URL} target="_blank" rel="noreferrer">
            How to run one
          </a>
        </p>
      </Card>
    );
  }
  return (
    <Card title="Market Data Hub">
      <Facts
        rows={[
          ["Connection", hub.reachable ? "Reachable" : "Unreachable", hub.reachable ? "is-ok" : "is-bad"],
          ["Hub health", hub.healthy === null ? "—" : hub.healthy ? "Healthy" : `${hub.problems.length} problem${hub.problems.length === 1 ? "" : "s"}`, hub.healthy === false ? "is-bad" : hub.healthy ? "is-ok" : ""],
          ["Version · uptime", `${hub.version ? `v${hub.version}` : "—"}${hub.uptimeSec !== null ? ` · ${span(hub.uptimeSec * 1000)}` : ""}`],
          ["Status read", ago(hub.checkedAt, now)],
          ["Mode", hub.endOfDay ? "End-of-day data (no broker connected)" : "Full (broker configured)"],
          ["Broker login", broker.configured === false ? "Not configured" : yesNo(broker.connected, "Connected", "Not connected"), broker.connected ? "is-ok" : broker.connected === false && !hub.endOfDay ? "is-bad" : ""],
          ["Owns broker connection", yesNo(broker.ownsConnection, "Yes", "No (serves stored data only)"), broker.ownsConnection === false ? "is-warn" : ""],
        ]}
      />
      {hub.error && <p className="tx-health-error">{hub.error}</p>}
      {broker.lastLoginError && (
        <p className="tx-health-error">
          Broker login failed: {broker.lastLoginError}
          {broker.loginRetryAfter ? ` (retrying ${clock(broker.loginRetryAfter, now)} IST)` : ""}
        </p>
      )}
      <p className="tx-dim tx-health-small">
        {hub.url}
        {hub.keyName ? ` · key “${hub.keyName}”` : ""}
        {hub.scopes.length ? ` (${hub.scopes.join(", ")})` : ""}
        {broker.lastLoginAt ? ` · broker login ${clock(broker.lastLoginAt, now)}` : ""}
      </p>
    </Card>
  );
}

function Meter({ label, used, cap }: { label: string; used: number; cap: number }) {
  const share = cap > 0 ? used / cap : 0;
  const tone = share >= 0.95 ? "is-bad" : share >= 0.75 ? "is-warn" : "";
  return (
    <div className={`tx-health-meter ${tone}`}>
      <div className="tx-health-meter-head">
        <span>{label}</span>
        <span>
          {thousands(used)} / {thousands(cap)}
        </span>
      </div>
      <span className="tx-health-meter-bar" aria-hidden>
        <i style={{ width: `${Math.min(100, share * 100)}%` }} />
      </span>
    </div>
  );
}

function BudgetCard({ report }: { report: HealthReport; now: number }) {
  const budget = report.budget;
  if (!budget) {
    return (
      <Card title="Broker request budget">
        <p className="tx-dim">{report.hub.configured ? "The hub hasn't reported its budget." : "No hub."}</p>
      </Card>
    );
  }
  const flags = [budget.stoppedForToday && "Stopped for today", budget.coolingDown && "Cooling down after a 429", budget.slowed && "Slowed"].filter(Boolean) as string[];
  return (
    <Card title={`Broker request budget · ${budget.plan === "prime" ? "Prime" : "Standard"}`}>
      <Meter label="Today (every app on the hub)" used={budget.usedToday} cap={budget.dayCap} />
      <Meter label="This minute" used={budget.usedThisMinute} cap={budget.minuteCap} />
      <Facts
        rows={[
          ...Object.entries(budget.byPriority).map(([priority, count]): [string, ReactNode] => [priority.charAt(0).toUpperCase() + priority.slice(1), thousands(count)]),
          ["429 strikes", String(budget.strikes), budget.strikes ? "is-warn" : ""],
        ]}
      />
      {flags.length > 0 && <p className="tx-health-error">{flags.join(" · ")}</p>}
      <p className="tx-dim tx-health-small">Tradex paces the screener&apos;s live quotes and the Day High/Low sweep from what&apos;s left of the day.</p>
    </Card>
  );
}

function LiveCard({ report, now }: { report: HealthReport; now: number }) {
  const { hubFeed, hubStream, market, sources } = report.live;
  const resting = sources.filter((source) => source.restingUntil && source.restingUntil > now);
  return (
    <Card title="Live prices">
      <p className={`tx-health-market ${report.market.open ? "is-ok" : ""}`}>{report.market.open ? "Market open" : "Market closed"}</p>
      <div className="tx-health-chain">
        <div>
          <strong>Broker → hub</strong>
          {hubFeed ? (
            <span className={hubFeed.mode === "socket" || hubFeed.mode === "idle" ? "" : "is-warn"}>
              {hubFeed.mode}
              {hubFeed.socket ? ` · socket ${hubFeed.socket}` : ""} · {hubFeed.socketSymbols} on socket{hubFeed.polledSymbols ? `, ${hubFeed.polledSymbols} polled` : ""}
              {hubFeed.capacity ? ` (of ${hubFeed.capacity})` : ""} · last tick {ago(hubFeed.lastTickAt, now)} · {hubFeed.reconnects} reconnects
              {hubFeed.pollingStopped ? ` · polling stopped: ${hubFeed.pollingStopped}` : ""}
            </span>
          ) : (
            <span className="tx-dim">unknown</span>
          )}
        </div>
        <div>
          <strong>Hub → Tradex</strong>
          {hubStream ? (
            <span className={hubStream.open ? "" : hubStream.failures ? "is-bad" : ""}>
              {hubStream.open ? `open since ${clock(hubStream.openedAt ?? now, now)}` : hubStream.running ? "reconnecting" : "not started (no live symbols yet)"} · {hubStream.symbols} symbols · last heard {ago(hubStream.lastHeardAt, now)} · {hubStream.connects} connects
              {hubStream.failures ? ` · ${hubStream.failures} failures in a row` : ""}
            </span>
          ) : (
            <span className="tx-dim">no hub</span>
          )}
        </div>
        {hubStream?.lastError && (
          <p className="tx-health-error">
            Stream error {hubStream.lastErrorAt ? `at ${clock(hubStream.lastErrorAt, now)}` : ""}: {hubStream.lastError}
          </p>
        )}
        <div>
          <strong>Tradex → browsers</strong>
          <span className={market.mode === "offline" && market.subscribers ? "is-bad" : market.mode === "polling" ? "is-warn" : ""}>
            {market.mode}
            {market.source ? ` via ${market.source}` : ""} · {market.subscribers} open stream{market.subscribers === 1 ? "" : "s"} · {market.live} live, {market.polled} polled · last tick {ago(market.lastTickAt, now)}
          </span>
        </div>
      </div>
      {resting.map((source) => (
        <p key={source.id} className="tx-health-error">
          {source.label} resting until {clock(source.restingUntil!, now)}
          {source.lastError ? `: ${source.lastError}` : ""}
        </p>
      ))}
    </Card>
  );
}

function Datasets({ datasets, now }: { datasets: DatasetHealth[]; now: number }) {
  return (
    <Card title="Data freshness" wide>
      {datasets.length === 0 ? (
        <p className="tx-dim">The hub hasn&apos;t answered yet.</p>
      ) : (
        <div className="tx-health-table" role="table">
          <div className="tx-health-tr is-head" role="row">
            <span role="columnheader">Dataset</span>
            <span role="columnheader">Holds</span>
            <span role="columnheader">Refreshed</span>
            <span role="columnheader">State</span>
          </div>
          {datasets.map((dataset) => (
            <div key={dataset.id} className="tx-health-tr" role="row">
              <span role="cell" className="tx-health-name">
                {dataset.label}
                <small>
                  {dataset.owner === "hub" ? "Hub" : "Tradex"} · {dataset.usedBy}
                </small>
              </span>
              <span role="cell">
                {dataset.asOf ? `through ${day(dataset.asOf)}` : "—"}
                {dataset.detail && <small>{dataset.detail}</small>}
              </span>
              <span role="cell">{ago(dataset.updatedAt, now)}</span>
              <span role="cell" className={`tx-health-state ${STATE_TONE[dataset.state]}`}>
                {dataset.state !== "info" && <span className="tx-health-dot" aria-hidden />}
                {STATE_LABEL[dataset.state]}
              </span>
              {(dataset.message || dataset.error) && (
                <span role="cell" className="tx-health-why-row">
                  {dataset.message}
                  {dataset.error && <em> Last error: {dataset.error}</em>}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const SEVERITY_TONE: Record<DataQualityFinding["severity"], string> = { problem: "is-bad", warning: "is-warn", info: "" };
const SEVERITY_LABEL: Record<DataQualityFinding["severity"], string> = { problem: "Problem", warning: "Warning", info: "Note" };
/** Findings listed before "Show all". */
const QUALITY_ROWS = 12;

/** The hub's data-quality checks: what they found in the last 30 days' data, worst checks first. */
function Quality({ report, now }: { report: HealthReport; now: number }) {
  const [all, setAll] = useState(false);
  const quality = report.quality;
  if (!quality) {
    return (
      <Card title="Data quality" wide>
        <p className="tx-dim">{report.hub.configured ? (report.hub.reachable ? "This hub doesn't run data-quality checks yet: update the Market Data Hub." : "The hub hasn't answered.") : "No hub."}</p>
      </Card>
    );
  }
  const rows = groupFindings(quality.recent);
  const shown = all ? rows : rows.slice(0, QUALITY_ROWS);
  const counts = (["problem", "warning", "info"] as const).map((severity) => `${thousands(quality.open[severity])} ${SEVERITY_LABEL[severity].toLowerCase()}${quality.open[severity] === 1 ? "" : "s"}`);
  return (
    <Card title="Data quality" wide>
      <p className="tx-health-note">
        The hub checks its NSE files after every evening import: missing sessions, files for the wrong date, price outliers no corporate action explains, stored candles against NSE&apos;s closes, and lot-size and F&amp;O-list changes. Open: {counts.join(", ")}
        {quality.lastRunAt ? ` · checked ${ago(quality.lastRunAt, now)}` : ""}
        {quality.waitingDays ? ` · ${thousands(quality.waitingDays)} stored day${quality.waitingDays === 1 ? "" : "s"} wait for the archive download` : ""}.
      </p>
      {quality.checks.length > 0 && (
        <div className="tx-health-chips">
          {quality.checks.map((row) => (
            <span key={`${row.check}-${row.severity}`} className={`tx-health-chip ${SEVERITY_TONE[row.severity]}`} title={`Newest: ${day(row.newestDate)}`}>
              <span className="tx-health-dot" aria-hidden />
              {row.label} · {thousands(row.count)}
            </span>
          ))}
        </div>
      )}
      {quality.recent.length === 0 ? (
        <p className="tx-dim">Nothing found in the last 30 days&apos; data.</p>
      ) : (
        <div className="tx-health-list">
          {shown.map((group) => {
            const [finding] = group;
            const many = group.length > 1;
            return (
              <div key={finding.key} className="tx-health-item">
                <div className="tx-health-item-head">
                  <span className={`tx-health-state ${SEVERITY_TONE[finding.severity]}`}>
                    <span className="tx-health-dot" aria-hidden />
                    {SEVERITY_LABEL[finding.severity]}
                  </span>
                  <strong>
                    {many ? `${finding.label} · ${group.length}` : finding.label}
                    {!many && finding.symbol ? ` · ${finding.symbol}` : ""}
                  </strong>
                  <span className="tx-dim">{day(finding.date)}</span>
                </div>
                <p className="tx-health-small">{many ? `${group.map((entry) => entry.subject).join(", ")}. For example: ${finding.message}` : finding.message}</p>
              </div>
            );
          })}
        </div>
      )}
      {rows.length > QUALITY_ROWS && (
        <button type="button" className="tx-btn-outline tx-health-more" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${quality.recent.length}`}
        </button>
      )}
      <p className="tx-dim tx-health-small">
        Older findings: the hub&apos;s <code>GET /v1/quality</code> or <code>hub data quality</code>. New problems, warnings and lot / F&amp;O changes also flash in the terminal.
      </p>
    </Card>
  );
}

function Jobs({ jobs, now }: { jobs: JobHealth[]; now: number }) {
  return (
    <Card title="Background jobs">
      <div className="tx-health-list">
        {jobs.map((job) => (
          <div key={job.id} className="tx-health-item">
            <div className="tx-health-item-head">
              <span className={`tx-health-state ${JOB_TONE[job.state] ?? ""}`}>
                <span className="tx-health-dot" aria-hidden />
                {job.state}
              </span>
              <strong>{job.label}</strong>
              <span className="tx-dim">{ago(job.updatedAt, now)}</span>
            </div>
            {(job.progress || job.message) && <p className="tx-health-small">{[job.progress, job.message].filter(Boolean).join(" · ")}</p>}
          </div>
        ))}
      </div>
    </Card>
  );
}

function ServerCard({ report }: { report: HealthReport; now: number }) {
  const { tradex } = report;
  return (
    <Card title="Tradex server">
      <Facts
        rows={[
          ["Version", `v${tradex.version} · Node ${tradex.node.replace(/^v/, "")}`],
          ["Up for", span(tradex.uptimeSec * 1000)],
          ["Log level", tradex.logLevel],
          ["Warnings · errors logged", `${thousands(tradex.logCounts.warn)} · ${thousands(tradex.logCounts.error)}`, tradex.logCounts.error ? "is-warn" : ""],
        ]}
      />
      <p className="tx-dim tx-health-small">
        Logs are JSON lines on the server&apos;s stdout/stderr; each API request has an id (the <code>X-Request-Id</code> header). Prometheus metrics: <code>/api/metrics</code>
        {tradex.metricsToken ? " (signed-in session or the METRICS_TOKEN bearer token)." : " (signed-in session; set METRICS_TOKEN for a scraper)."}
      </p>
    </Card>
  );
}

function Errors({ report, now }: { report: HealthReport; now: number }) {
  return (
    <Card title="Recent warnings and errors" wide>
      {report.errors.length === 0 ? (
        <p className="tx-dim">None since the server started {ago(report.tradex.startedAt, now)}.</p>
      ) : (
        <div className="tx-health-log">
          {report.errors.map((entry, index) => (
            <div key={`${entry.time}-${index}`} className={`tx-health-logline is-${entry.level}`}>
              <span className="tx-health-logtime">{clock(entry.time, now)}</span>
              <span className="tx-health-loglevel">{entry.level}</span>
              <span className="tx-health-logmsg">
                {entry.msg}
                {entry.detail && <small>{entry.detail}</small>}
              </span>
              {entry.requestId && (
                <code className="tx-health-reqid" title={`Request id ${entry.requestId} (X-Request-Id)`}>
                  {entry.requestId.slice(0, 8)}
                </code>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
