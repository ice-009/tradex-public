"use client";

import { useEffect, useState } from "react";
import type { FoBhavStatus, HistoryDbStatus, HistoryKind } from "@/contracts/api";
import { api } from "@/client/api";
import { Modal } from "./ui";

// The local market-data database: what's stored for the F&O stocks, and the
// "Download F&O history" job that fills it (so charts, the screener and
// backtests load from disk instead of the broker). Below it, the NSE F&O
// bhavcopy import (stock-futures OI and point-in-time F&O membership), which
// comes from NSE's free archive and costs no broker calls.

const mb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const thousands = (value: number) => value.toLocaleString("en-IN");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (key: number) => {
  const date = new Date(key);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

export function MarketDataDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<HistoryDbStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kinds, setKinds] = useState<HistoryKind[]>(["daily", "m15"]);
  const running = status?.job.state === "running";
  const foRunning = status?.fo?.job.state === "running";

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const next = await api.historyDb();
        if (cancelled) return;
        setStatus(next);
        setError(null);
        timer = setTimeout(load, next.job.state === "running" || next.fo?.job.state === "running" ? 2_000 : 15_000);
      } catch (cause) {
        if (cancelled) return;
        setError((cause as Error).message);
        timer = setTimeout(load, 15_000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [running, foRunning]);

  const act = async (action: Parameters<typeof api.historyDbAction>[0]) => {
    try {
      setStatus(await api.historyDbAction(action));
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const selected = status?.coverage.filter((row) => kinds.includes(row.kind)) ?? [];
  const calls = selected.reduce((sum, row) => sum + row.estimatedCalls, 0);
  const missing = selected.reduce((sum, row) => sum + row.missing, 0);
  const budget = status?.backgroundCallsLeft;

  return (
    <Modal title="Market data" onClose={onClose} width={560}>
      <div className="tx-mdata">
        <p className="tx-mdata-intro">
          Candles are kept in a local database, so charts, the screener and backtests load from disk. Download the F&amp;O stocks&apos; history once; after
          that only the newest candles are fetched.
        </p>
        {error && <p className="tx-mdata-error">{error}</p>}
        {!status ? (
          <p className="tx-dim">Loading…</p>
        ) : (
          <>
            <div className="tx-mdata-rows">
              {status.coverage.map((row) => (
                <label key={row.kind} className="tx-mdata-row">
                  <input
                    type="checkbox"
                    checked={kinds.includes(row.kind)}
                    disabled={running}
                    onChange={(event) => setKinds((current) => (event.target.checked ? [...current, row.kind] : current.filter((kind) => kind !== row.kind)))}
                  />
                  <span className="tx-mdata-name">{row.label}</span>
                  <span className="tx-mdata-bar" aria-hidden>
                    <i style={{ width: `${(row.covered / Math.max(1, row.total)) * 100}%` }} />
                  </span>
                  <span className="tx-mdata-count">
                    {row.covered}/{row.total}
                  </span>
                </label>
              ))}
            </div>

            <dl className="tx-mdata-facts">
              <div>
                <dt>Database</dt>
                <dd>
                  {mb(status.db.bytes)} · {thousands(status.db.candles)} candles in {status.db.series} series
                </dd>
              </div>
              <div>
                <dt>To download</dt>
                <dd>
                  {missing ? `${missing} series · about ${thousands(calls)} API calls` : "Nothing — selected history is stored"}
                </dd>
              </div>
              <div>
                <dt>Budget left today</dt>
                <dd>{budget === null || budget === undefined ? "—" : `${thousands(budget)} background calls`}</dd>
              </div>
            </dl>

            {running && (
              <div className="tx-mdata-progress" role="status">
                <span className="tx-mdata-bar is-wide" aria-hidden>
                  <i style={{ width: `${(status.job.done / Math.max(1, status.job.total)) * 100}%` }} />
                </span>
                <span>
                  {status.job.done}/{status.job.total} · {status.job.current ?? "starting…"}
                </span>
              </div>
            )}
            {status.job.message && !running && <p className="tx-mdata-message">{status.job.message}</p>}
            {!status.brokerConnected && <p className="tx-mdata-message">Connect Fyers to download history (see .env.example).</p>}
            {budget !== null && budget !== undefined && calls > budget && !running && (
              <p className="tx-mdata-message">
                That&apos;s more than today&apos;s background budget: it downloads what fits and pauses; start it again tomorrow to finish.
              </p>
            )}

            <div className="tx-mdata-actions">
              {running ? (
                <button type="button" className="tx-btn-outline" onClick={() => void act({ action: "stop" })}>
                  Stop
                </button>
              ) : (
                <button type="button" className="tx-btn-small" disabled={!status.brokerConnected || !missing} onClick={() => void act({ action: "start", kinds })}>
                  Download F&amp;O history
                </button>
              )}
              <span className="tx-dim">Runs in the background at low priority — charts stay fast. Safe to stop and resume.</span>
            </div>

            {status.fo && <FoBhavSection fo={status.fo} act={act} />}
          </>
        )}
      </div>
    </Modal>
  );
}

/** "F&O bhavcopy (NSE, free)": stock-futures OI and point-in-time F&O membership, from NSE's public archive. */
function FoBhavSection({ fo, act }: { fo: FoBhavStatus; act: (action: Parameters<typeof api.historyDbAction>[0]) => Promise<void> }) {
  const running = fo.job.state === "running";
  const { coverage } = fo;
  const missing = Math.max(0, coverage.expected - coverage.checked);
  return (
    <section className="tx-mdata-fo" aria-label="F&O bhavcopy">
      <div className="tx-mdata-row is-static">
        <span className="tx-tag">free</span>
        <span className="tx-mdata-name">F&amp;O bhavcopy (NSE, free)</span>
        <span className="tx-mdata-bar" aria-hidden>
          <i style={{ width: `${(Math.min(coverage.checked, coverage.expected) / Math.max(1, coverage.expected)) * 100}%` }} />
        </span>
        <span className="tx-mdata-count" title="Weekdays checked (trading days + holidays) of the last year">
          {Math.min(coverage.checked, coverage.expected)}/{coverage.expected}
        </span>
      </div>
      <p className="tx-mdata-message">
        Stock-futures open interest and the F&amp;O list as it was on each day, from NSE&apos;s public archive — <strong>no broker API calls</strong>. Backtests of the
        F&amp;O universe use the list of the day; the screener shows each F&amp;O stock&apos;s OI buildup as information only (it showed no tested edge on its own).
        The newest day is fetched each evening.
      </p>
      <p className="tx-mdata-message">
        {coverage.days
          ? `${coverage.days} trading days stored (${day(coverage.first!)} – ${day(coverage.last!)}), ${thousands(coverage.rows)} stock-days.`
          : "Nothing stored yet."}
        {missing ? ` ${missing} weekday${missing === 1 ? "" : "s"} of the last year not checked yet (about ${Math.max(1, Math.ceil((missing * 1.2) / 60))} min at one request a second).` : ""}
      </p>
      {running && (
        <div className="tx-mdata-progress" role="status">
          <span className="tx-mdata-bar is-wide" aria-hidden>
            <i style={{ width: `${(fo.job.done / Math.max(1, fo.job.total)) * 100}%` }} />
          </span>
          <span>
            {fo.job.done}/{fo.job.total} · {fo.job.current ?? "starting…"}
            {fo.job.failed ? ` · ${fo.job.failed} failed` : ""}
          </span>
        </div>
      )}
      {fo.job.message && !running && <p className="tx-mdata-message">{fo.job.message}</p>}
      <div className="tx-mdata-actions">
        {running ? (
          <button type="button" className="tx-btn-outline" onClick={() => void act({ action: "stop-fo" })}>
            Stop
          </button>
        ) : (
          <button type="button" className="tx-btn-small" disabled={!missing} onClick={() => void act({ action: "start-fo" })}>
            Download F&amp;O bhavcopy
          </button>
        )}
        <span className="tx-dim">Free · at most one request a second to NSE · safe to stop and resume.</span>
      </div>
    </section>
  );
}
