"use client";

import { useEffect, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { CHART_TYPES } from "@/chart/types";
import { FAVORITE_INTERVALS, INTERVALS, INTERVAL_META } from "@/core/market/intervals";
import { liveHub, type LiveStatus } from "@/client/marketData";
import { useApiUsage } from "@/client/usageFeed";
import type { ApiUsageResponse } from "@/contracts/api";
import { MarketDataDialog } from "./MarketDataDialog";
import { LAYOUTS, setLayout, updateActiveCell, useTerminal } from "./store";
import { Icons, LayoutIcon } from "./icons";
import { LayoutsMenu, type LayoutDialogState } from "./LayoutsMenu";
import { Dropdown, useTerminalUI } from "./ui";

const STATUS_LABEL: Record<LiveStatus, string> = {
  idle: "Idle",
  connecting: "Connecting",
  live: "Live",
  delayed: "Delayed",
  offline: "Feed offline",
};

export function TopBar({ onLayoutDialog }: { onLayoutDialog: (dialog: LayoutDialogState) => void }) {
  const cell = useTerminal((state) => state.cells[state.activeCell]);
  const layout = useTerminal((state) => state.layout);
  const ui = useTerminalUI();
  const { data: session } = useSession();
  const [status, setStatus] = useState<LiveStatus>(liveHub.status);
  const usage = useApiUsage();
  const viaHub = usage?.via === "hub";

  useEffect(() => liveHub.onStatus(setStatus), []);

  const moreIntervals = INTERVALS.filter((meta) => !FAVORITE_INTERVALS.includes(meta.value));
  const intervalIsMore = !FAVORITE_INTERVALS.includes(cell.interval);

  return (
    <header className="tx-topbar">
      <div className="tx-brand" title="Tradex">
        TX
      </div>

      <button type="button" className="tx-tb-btn tx-symbol-btn" onClick={() => ui.openSearch()} title="Change symbol">
        <Icons.search size={15} />
        <span>{cell.symbol}</span>
      </button>

      <span className="tx-tb-sep" />

      <div className="tx-tb-group">
        {FAVORITE_INTERVALS.map((value) => (
          <button
            type="button"
            key={value}
            className={`tx-tb-btn tx-interval ${cell.interval === value ? "is-active" : ""}`}
            title={INTERVAL_META[value].title}
            onClick={() => updateActiveCell({ interval: value })}
          >
            {INTERVAL_META[value].label}
          </button>
        ))}
        <Dropdown
          title="More intervals"
          className={intervalIsMore ? "is-active" : ""}
          trigger={
            <>
              {intervalIsMore ? INTERVAL_META[cell.interval].label : ""}
              <Icons.chevronDown size={14} />
            </>
          }
        >
          {(close) =>
            moreIntervals.map((meta) => (
              <button
                type="button"
                key={meta.value}
                className={`tx-menu-item ${cell.interval === meta.value ? "is-active" : ""}`}
                onClick={() => {
                  updateActiveCell({ interval: meta.value });
                  close();
                }}
              >
                {meta.title}
              </button>
            ))
          }
        </Dropdown>
      </div>

      <span className="tx-tb-sep" />

      <Dropdown
        title="Chart type"
        trigger={
          <>
            <Icons.candles size={17} />
            <Icons.chevronDown size={13} />
          </>
        }
      >
        {(close) => (
          <>
            {CHART_TYPES.map((type) => (
              <button
                type="button"
                key={type.value}
                className={`tx-menu-item ${cell.chartType === type.value ? "is-active" : ""}`}
                onClick={() => {
                  updateActiveCell({ chartType: type.value });
                  close();
                }}
              >
                <span className="tx-check">{cell.chartType === type.value && <Icons.check size={14} />}</span>
                {type.label}
              </button>
            ))}
            <div className="tx-menu-sep" />
            <button type="button" className="tx-menu-item" onClick={() => updateActiveCell({ showVolume: !cell.showVolume })}>
              <span className="tx-check">{cell.showVolume && <Icons.check size={14} />}</span>Volume
            </button>
            <button
              type="button"
              className="tx-menu-item"
              onClick={() => updateActiveCell({ scaleMode: cell.scaleMode === "log" ? "linear" : "log" })}
            >
              <span className="tx-check">{cell.scaleMode === "log" && <Icons.check size={14} />}</span>Log scale
            </button>
          </>
        )}
      </Dropdown>

      <button type="button" className="tx-tb-btn" onClick={() => ui.openIndicators()} title="Indicators (/)">
        <Icons.indicators size={17} />
        <span>Indicators</span>
      </button>

      <span className="tx-tb-sep" />

      <Dropdown title="Layout" trigger={<LayoutIcon layout={layout} />}>
        {(close) =>
          LAYOUTS.map((entry) => (
            <button
              type="button"
              key={entry.id}
              className={`tx-menu-item ${layout === entry.id ? "is-active" : ""}`}
              onClick={() => {
                setLayout(entry.id);
                close();
              }}
            >
              <LayoutIcon layout={entry.id} />
              {entry.label}
            </button>
          ))
        }
      </Dropdown>

      <LayoutsMenu onDialog={onLayoutDialog} />

      <span className="tx-tb-spacer" />

      <ApiUsageMeter usage={usage} />

      <span
        className={`tx-status tx-status-${status}`}
        title={[
          status === "delayed" ? "No live socket: prices are polled every ~15 s through the data engine" : "Market data feed",
          viaHub ? hubSummary(usage.hub) : "",
        ]
          .filter(Boolean)
          .join("\n")}
      >
        <span className="tx-status-dot" />
        {STATUS_LABEL[status]}
      </span>

      <Dropdown
        title="Account"
        align="right"
        trigger={<span className="tx-avatar">{(session?.user?.email ?? "?").slice(0, 1).toUpperCase()}</span>}
      >
        {() => (
          <>
            <div className="tx-menu-note">{session?.user?.email}</div>
            <button type="button" className="tx-menu-item" onClick={() => signOut({ callbackUrl: "/auth/signin" })}>
              <Icons.logout size={15} />
              Sign out
            </button>
          </>
        )}
      </Dropdown>
    </header>
  );
}

const compact = (value: number) => (value >= 10_000 ? `${Math.round(value / 1000)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value));

/** "Connected via Market Data Hub" and the hub's health, for tooltips. */
function hubSummary(hub: ApiUsageResponse["hub"]): string {
  if (!hub) return "Connected via Market Data Hub";
  if (!hub.reachable) return `Market Data Hub at ${hub.url} unreachable${hub.error ? `: ${hub.error}` : ""}`;
  const broker = hub.brokerConnected === null ? "" : hub.brokerConnected ? " · its broker is connected" : " · its broker is NOT connected";
  const feed = hub.feed ? ` · live feed ${hub.feed}` : "";
  return `Connected via Market Data Hub (${hub.url}${hub.version ? `, v${hub.version}` : ""})${broker}${feed}${hub.streamOpen ? " · price stream open" : ""}`;
}

/** Today's broker API calls against the daily cap; turns amber past 70 %, red past 90 % or after a 429. */
function ApiUsageMeter({ usage }: { usage: ApiUsageResponse | null }) {
  const [open, setOpen] = useState(false);
  if (!usage) return null;
  const viaHub = usage.via === "hub";
  const share = usage.dayCap ? usage.usedToday / usage.dayCap : 0;
  const hubDown = viaHub && (!usage.hub?.reachable || usage.hub.brokerConnected === false);
  const tone = usage.strikes > 0 || share >= 0.9 || hubDown ? "is-bad" : share >= 0.7 ? "is-warn" : "";
  const title = [
    viaHub ? hubSummary(usage.hub) : "",
    `${viaHub ? "The hub's " : ""}Fyers ${usage.plan === "prime" ? "Prime" : "Standard"} plan · data API calls today: ${usage.usedToday.toLocaleString("en-IN")} of ${usage.dayCap.toLocaleString("en-IN")} (limit ${usage.limits.perDay.toLocaleString("en-IN")})`,
    `Last minute: ${usage.usedThisMinute} of ${usage.minuteCap} (limit ${usage.limits.perMinute})`,
    `Charts & searches ${usage.byPriority.user} · watchlist & alerts ${usage.byPriority.refresh} · scans ${usage.byPriority.background}`,
    usage.strikes ? `Rate-limited ${usage.strikes}× today${usage.coolingDown ? " — paused for a minute" : ""} (Fyers blocks the day after more than 3)` : "No rate-limit hits today",
    viaHub ? "Tradex makes no broker calls itself: the hub does, for every app connected to it" : "",
    "Click for market data and the history database",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <>
      <button type="button" className={`tx-api-meter ${tone}`} title={title} onClick={() => setOpen(true)}>
        <span className="tx-api-meter-bar" aria-hidden>
          <i style={{ width: `${Math.min(100, share * 100)}%` }} />
        </span>
        {viaHub ? "Hub" : "API"} {compact(usage.usedToday)}/{compact(usage.dayCap)}
      </button>
      {open && <MarketDataDialog onClose={() => setOpen(false)} />}
    </>
  );
}
