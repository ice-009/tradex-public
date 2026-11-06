"use client";

import { useMemo } from "react";
import { openSidePanel, updateScreener, useTerminal, type SidePanel } from "./store";
import { useScreenerFeed } from "@/client/screenerFeed";
import { stepIdea } from "./ideaActions";
import { Icons } from "./icons";
import { useHighLowFeed } from "@/client/highLowFeed";
import { istParts } from "@/core/market/session";
import { usePlanFeed } from "@/client/planFeed";
import { useDailyPlan } from "./usePlan";

/**
 * Bottom panel strip, always visible under the charts (like a trading
 * platform's bottom panel): opens, collapses and maximizes the screener.
 */
export function BottomDock() {
  const open = useTerminal((state) => state.screener.open);
  const maximized = useTerminal((state) => state.screener.maximized);
  const view = useTerminal((state) => state.screener.view);
  const listSize = useTerminal((state) => state.watchlist.length);
  const hlTotals = useHighLowFeed((feed) => feed.totals);
  const hlStatus = useHighLowFeed((feed) => feed.status);
  const ideas = useScreenerFeed((feed) => feed.ideas.size);
  const status = useScreenerFeed((feed) => feed.data?.status);
  const plan = useDailyPlan();
  const planned = plan?.ideas.filter((idea) => idea.size.status === "ok").length ?? 0;
  const urgent = usePlanFeed((feed) => Object.values(feed.trades?.tracks ?? {}).filter((track) => track.urgent).length);

  return (
    <div className="tx-dock">
      <button
        type="button"
        className={`tx-dock-tab ${open && view === "plan" ? "is-active" : ""}`}
        onClick={() => updateScreener(open && view === "plan" ? { open: false, maximized: false } : { open: true, view: "plan" })}
        title="Today's trade plan: which setups to take, how many lots, and what to do with your open trades"
      >
        Plan
        {planned > 0 && <span className="tx-dock-count">{planned}</span>}
        {urgent > 0 && <span className="tx-dock-dot is-error" title={`${urgent} open trade${urgent === 1 ? " needs" : "s need"} action today`} />}
      </button>
      <button
        type="button"
        className={`tx-dock-tab ${open && view === "screener" ? "is-active" : ""}`}
        onClick={() => updateScreener(open && view === "screener" ? { open: false, maximized: false } : { open: true, view: "screener" })}
        title="Explore every screen's matches: BTST, swing and 15–30 day setups"
      >
        Explore
        {ideas > 0 && <span className="tx-dock-count">{ideas}</span>}
        {status === "error" && <span className="tx-dock-dot is-error" title="No data" />}
      </button>
      <button
        type="button"
        className={`tx-dock-tab ${open && view === "compare" ? "is-active" : ""}`}
        onClick={() => updateScreener(open && view === "compare" ? { open: false, maximized: false } : { open: true, view: "compare" })}
        title="Score and rank the stocks in a list to pick the best one"
      >
        Compare
        <span className="tx-dock-count is-muted">{listSize}</span>
      </button>
      <button
        type="button"
        className={`tx-dock-tab ${open && view === "highlow" ? "is-active" : ""}`}
        onClick={() => updateScreener(open && view === "highlow" ? { open: false, maximized: false } : { open: true, view: "highlow" })}
        title="F&O stocks making a new day high or low, in cash or futures. Scans only while this panel is open, to save API calls."
      >
        Day High/Low
        {hlStatus === "live" && open && view === "highlow" && <span className="tx-hl-live" aria-hidden />}
        <span className="tx-dock-hl">
          <span className="is-up">▲{hlTotals.highs}</span>
          <span className="is-down">▼{hlTotals.lows}</span>
        </span>
      </button>
      <button
        type="button"
        className={`tx-dock-tab ${open && view === "backtest" ? "is-active" : ""}`}
        onClick={() => updateScreener(open && view === "backtest" ? { open: false, maximized: false } : { open: true, view: "backtest", maximized: true })}
        title="Backtest the screens as one account: equity curve, drawdown, costs, in- vs out-of-sample"
      >
        Backtest
      </button>
      <span className="tx-dock-hint">
        <kbd>[</kbd>
        <kbd>]</kbd> previous / next idea
      </span>
      <span className="tx-tb-spacer" />
      {ideas > 0 && (
        <>
          <button type="button" className="tx-dock-btn" title="Previous idea ([)" onClick={() => stepIdea(-1)}>
            <Icons.chevronUp size={15} style={{ transform: "rotate(-90deg)" }} />
          </button>
          <button type="button" className="tx-dock-btn" title="Next idea (])" onClick={() => stepIdea(1)}>
            <Icons.chevronUp size={15} style={{ transform: "rotate(90deg)" }} />
          </button>
          <span className="tx-dock-sep" />
        </>
      )}
      {open && (
        <button
          type="button"
          className="tx-dock-btn"
          title={maximized ? "Restore panel" : "Maximize panel"}
          onClick={() => updateScreener({ maximized: !maximized })}
        >
          {maximized ? <Icons.minimize size={15} /> : <Icons.maximize size={15} />}
        </button>
      )}
      <button
        type="button"
        className="tx-dock-btn"
        title={open ? "Collapse panel" : "Open panel"}
        onClick={() => updateScreener({ open: !open, maximized: false })}
      >
        {open ? <Icons.chevronDown size={16} /> : <Icons.chevronUp size={16} />}
      </button>
    </div>
  );
}

const PANELS: Array<{ id: SidePanel; title: string; icon: keyof typeof Icons }> = [
  { id: "watchlist", title: "Watchlists, details and trade setup", icon: "list" },
  { id: "movers", title: "Market movers: gainers, losers, volume, 52-week highs", icon: "trending" },
  { id: "sectors", title: "Sector performance and breadth", icon: "sectors" },
  { id: "results", title: "Results calendar (NSE)", icon: "calendar" },
  { id: "alerts", title: "Price alerts", icon: "bell" },
];

/** Narrow icon strip on the far right: side panels, the screener, next idea. */
export function WidgetBar() {
  const open = useTerminal((state) => state.watchlistOpen);
  const panel = useTerminal((state) => state.sidePanel);
  const screenerOpen = useTerminal((state) => state.screener.open);
  const ideas = useScreenerFeed((feed) => feed.ideas.size);
  const watchlist = useTerminal((state) => state.watchlist);
  const events = useScreenerFeed((feed) => feed.results?.events);
  const ideaMap = useScreenerFeed((feed) => feed.ideas);
  const armedAlerts = useTerminal((state) => state.alerts.filter((alert) => !alert.triggeredAt).length);
  const firedAlerts = useTerminal((state) => state.alerts.filter((alert) => alert.triggeredAt && Date.now() - alert.triggeredAt < 86_400_000).length);
  // Only stocks you'd act on — the open list and current screener ideas — not the whole market.
  const resultsSoon = useMemo(() => {
    if (!events?.length) return 0;
    const mine = new Set([...watchlist, ...ideaMap.keys()]);
    const today = istParts().day;
    return new Set(events.filter((event) => mine.has(event.symbol) && event.date >= today && event.date <= today + 3 * 86_400_000).map((event) => event.symbol)).size;
  }, [events, watchlist, ideaMap]);

  return (
    <nav className="tx-widgetbar" aria-label="Side panels">
      {PANELS.map((entry) => {
        const Icon = Icons[entry.icon] as (props: { size?: number }) => React.ReactElement;
        return (
          <button
            type="button"
            key={entry.id}
            className={`tx-widget-btn ${open && panel === entry.id ? "is-active" : ""}`}
            title={entry.title}
            aria-pressed={open && panel === entry.id}
            onClick={() => openSidePanel(entry.id)}
          >
            <Icon size={19} />
            {entry.id === "alerts" && (firedAlerts > 0 || armedAlerts > 0) && (
              <span className={`tx-widget-badge ${firedAlerts ? "is-fired" : "is-muted"}`} title={`${armedAlerts} armed · ${firedAlerts} fired today`}>
                {firedAlerts || armedAlerts}
              </span>
            )}
            {entry.id === "results" && resultsSoon > 0 && (
              <span className="tx-widget-badge is-muted" title={`${resultsSoon} of your stocks report results within 3 days`}>
                {resultsSoon > 99 ? "99+" : resultsSoon}
              </span>
            )}
          </button>
        );
      })}
      <span className="tx-widget-sep" />
      <button
        type="button"
        className={`tx-widget-btn ${screenerOpen ? "is-active" : ""}`}
        title="Stock screener"
        onClick={() => updateScreener({ open: !screenerOpen, maximized: false })}
      >
        <Icons.screener size={19} />
        {ideas > 0 && <span className="tx-widget-badge">{ideas > 99 ? "99+" : ideas}</span>}
      </button>
      <button type="button" className="tx-widget-btn" title="Next trade idea (])" onClick={() => stepIdea(1)} disabled={!ideas}>
        <Icons.target size={19} />
      </button>
    </nav>
  );
}
