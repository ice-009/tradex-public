"use client";

import { useEffect, useState } from "react";
import { useHubHealth } from "@/client/usageFeed";
import { BROKER_DOCS_URL, END_OF_DAY_LABEL } from "./endOfDay";
import { HUB_DOCS_URL, MarketDataDialog } from "./MarketDataDialog";
import { adaptToEndOfDay } from "./store";

/** Remembers, per browser, that the "End-of-day data" banner was dismissed. */
const EOD_DISMISSED_KEY = "tradex.eodBannerDismissed";

/**
 * "Connect a Market Data Hub": shown across the top while Tradex has no hub
 * (HUB_URL / HUB_KEY not set) or can't reach it. Charts meanwhile show labelled
 * sample data; the screener, backtests and plan wait for real data.
 *
 * "End-of-day data (no broker connected)": the hub runs without a broker
 * (market-data-hub#32). Everything daily works; live quotes and intraday charts
 * don't. Said once, dismissible; the top bar keeps saying "End-of-day".
 */
export function HubBanner() {
  const hub = useHubHealth();
  const [open, setOpen] = useState(false);
  // Read once on the client (nothing renders before the hub's health arrives, so the server's guess never shows).
  const [eodDismissed, setEodDismissed] = useState(() => {
    try {
      return typeof window === "undefined" || window.localStorage.getItem(EOD_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  // No intraday data in end-of-day mode: charts on an intraday interval move to daily.
  const endOfDay = Boolean(hub?.endOfDay);
  useEffect(() => {
    if (endOfDay) adaptToEndOfDay();
  }, [endOfDay]);

  if (!hub) return null;
  if (hub.configured && hub.reachable) {
    if (!hub.endOfDay || eodDismissed) return null;
    const dismiss = () => {
      setEodDismissed(true);
      try {
        window.localStorage.setItem(EOD_DISMISSED_KEY, "1");
      } catch {
        // private window: dismissed until the next visit
      }
    };
    return (
      <div className="tx-hub-banner is-info" role="status">
        <strong>{END_OF_DAY_LABEL}</strong>
        <span>
          Charts, screens, backtests and the plan run on NSE&apos;s daily files. Live quotes and intraday charts need a broker on the hub.{" "}
          <a href={BROKER_DOCS_URL} target="_blank" rel="noreferrer">
            Connect one
          </a>
        </span>
        <button type="button" className="tx-btn-outline" onClick={() => setOpen(true)}>
          Details
        </button>
        <button type="button" className="tx-btn-outline" onClick={dismiss}>
          Got it
        </button>
        {open && <MarketDataDialog onClose={() => setOpen(false)} />}
      </div>
    );
  }
  return (
    <div className="tx-hub-banner" role="status">
      <strong>{hub.configured ? "Market Data Hub unreachable" : "Connect a Market Data Hub"}</strong>
      <span>
        {hub.configured
          ? `Tradex can't reach the hub at ${hub.url}${hub.error ? ` (${hub.error})` : ""}. Charts show sample data until it's back.`
          : "Tradex gets all its market data from a hub. Set HUB_URL and HUB_KEY in .env and restart; until then charts show sample data."}{" "}
        <a href={HUB_DOCS_URL} target="_blank" rel="noreferrer">
          How to run one
        </a>
      </span>
      <button type="button" className="tx-btn-outline" onClick={() => setOpen(true)}>
        Details
      </button>
      {open && <MarketDataDialog onClose={() => setOpen(false)} />}
    </div>
  );
}
