"use client";

import { useState } from "react";
import { useHubHealth } from "@/client/usageFeed";
import { HUB_DOCS_URL, MarketDataDialog } from "./MarketDataDialog";

/**
 * "Connect a Market Data Hub": shown across the top while Tradex has no hub
 * (HUB_URL / HUB_KEY not set) or can't reach it. Charts meanwhile show labelled
 * sample data; the screener, backtests and plan wait for real data.
 */
export function HubBanner() {
  const hub = useHubHealth();
  const [open, setOpen] = useState(false);
  if (!hub || (hub.configured && hub.reachable)) return null;
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
