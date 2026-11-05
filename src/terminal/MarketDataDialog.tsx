"use client";

import { useEffect, useState } from "react";
import type { HistoryDbStatus, HistoryKind } from "@/contracts/api";
import { api } from "@/client/api";
import { Modal } from "./ui";

// The local market-data database: what's stored for the F&O stocks, and the
// "Download F&O history" job that fills it (so charts, the screener and
// backtests load from disk instead of the broker).

const mb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const thousands = (value: number) => value.toLocaleString("en-IN");

export function MarketDataDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<HistoryDbStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kinds, setKinds] = useState<HistoryKind[]>(["daily", "m15"]);
  const running = status?.job.state === "running";

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const next = await api.historyDb();
        if (cancelled) return;
        setStatus(next);
        setError(null);
        timer = setTimeout(load, next.job.state === "running" ? 2_000 : 15_000);
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
  }, [running]);

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
          </>
        )}
      </div>
    </Modal>
  );
}
