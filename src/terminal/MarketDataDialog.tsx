"use client";

import { useEffect, useState } from "react";
import type { MarketDataStatus } from "@/contracts/api";
import { api } from "@/client/api";
import { Modal } from "./ui";

// "Market data: provided by your hub". Tradex fetches no market data itself:
// the Market Data Hub keeps the broker connection, the candles and NSE's files
// current. This panel shows the hub's health (GET /v1/status) and how fresh
// each dataset is. Read-only: Tradex's key has no admin scope, so downloads
// and backfills are run on the hub (its `npm run hub -- data …` commands).

/** Where to read about running a hub. */
export const HUB_DOCS_URL = "https://github.com/ice-009/market-data-hub";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => {
  const [year, month, date] = iso.split("-").map(Number);
  return year && month && date ? `${date} ${MONTHS[month - 1]} ${year}` : iso;
};
const ago = (at: number) => {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};
const thousands = (value: number) => value.toLocaleString("en-IN");

export function MarketDataDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<MarketDataStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const next = await api.marketData();
        if (cancelled) return;
        setStatus(next);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
      if (!cancelled) timer = setTimeout(load, 30_000);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const hub = status?.hub;
  const budget = status?.budget;
  return (
    <Modal title="Market data: provided by your hub" onClose={onClose} width={560}>
      <div className="tx-mdata">
        <p className="tx-mdata-intro">
          Tradex gets all its market data — charts, quotes, live prices, daily bars, open interest, lot sizes, the ban list and results dates — from a{" "}
          <a href={HUB_DOCS_URL} target="_blank" rel="noreferrer">
            Market Data Hub
          </a>
          . It makes no broker or NSE requests itself. Downloads and backfills are run on the hub.
        </p>
        {error && <p className="tx-mdata-error">{error}</p>}
        {!status || !hub ? (
          !error && <p className="tx-dim">Loading…</p>
        ) : !hub.configured ? (
          <p className="tx-mdata-message">
            <strong>No hub is configured.</strong> Set <code>HUB_URL</code> and <code>HUB_KEY</code> in <code>.env</code> and restart Tradex; until then charts show labelled sample data and the
            screener, backtests and plan have no data. See the{" "}
            <a href={HUB_DOCS_URL} target="_blank" rel="noreferrer">
              hub&apos;s README
            </a>{" "}
            to run one.
          </p>
        ) : (
          <>
            <dl className="tx-mdata-facts">
              <div>
                <dt>Hub</dt>
                <dd title={hub.url}>{hub.reachable ? `Reachable${hub.version ? ` · v${hub.version}` : ""}` : "Unreachable"}</dd>
              </div>
              <div>
                <dt>Health</dt>
                <dd>{hub.healthy === null ? "—" : hub.healthy ? "Healthy" : `${hub.problems.length} problem${hub.problems.length === 1 ? "" : "s"}`}</dd>
              </div>
              <div>
                <dt>Broker · live feed</dt>
                <dd>
                  {status.broker.connected === null ? "—" : status.broker.connected ? "Connected" : "Not connected"}
                  {hub.feed ? ` · ${hub.feed}` : ""}
                </dd>
              </div>
            </dl>
            {hub.error && <p className="tx-mdata-error">{hub.error}</p>}
            {hub.problems.map((problem) => (
              <p key={problem} className="tx-mdata-error">
                {problem}
              </p>
            ))}
            {hub.warnings.map((warning) => (
              <p key={warning} className="tx-mdata-message">
                {warning}
              </p>
            ))}
            {status.broker.lastLoginError && <p className="tx-mdata-message">Broker login: {status.broker.lastLoginError}</p>}

            {status.datasets.length > 0 && (
              <div className="tx-mdata-rows">
                {status.datasets.map((dataset) => (
                  <div key={dataset.id} className="tx-mdata-row is-static" title={dataset.error ?? undefined}>
                    <span className={`tx-mdata-dot ${dataset.error ? "is-bad" : dataset.session || dataset.updatedAt ? "is-ok" : ""}`} aria-hidden />
                    <span className="tx-mdata-name">{dataset.label}</span>
                    <span className="tx-mdata-count">
                      {[dataset.session ? `through ${day(dataset.session)}` : "", dataset.detail ?? "", dataset.updatedAt ? `updated ${ago(dataset.updatedAt)}` : ""].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {budget && (
              <p className="tx-mdata-message">
                The hub&apos;s broker budget today ({budget.plan === "prime" ? "Prime" : "Standard"} plan): {thousands(budget.usedToday)} of {thousands(budget.dayCap)} calls, shared by every app
                on the hub. Tradex paces its screener and Day High/Low refreshes from what&apos;s left.
              </p>
            )}
            {status.store.message && (
              <p className="tx-mdata-message">
                Screener &amp; backtest daily bars: {status.store.message}
              </p>
            )}
            <p className="tx-dim">
              {hub.url}
              {status.scopes.length ? ` · this key: ${status.scopes.join(", ")}` : ""} · read-only
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
