"use client";

import { useMemo } from "react";
import { formatPrice } from "@/core/format";
import { toggleShortlist, updateActiveCell, updateScreener, useTerminal } from "./store";
import { useScreenerFeed } from "@/client/screenerFeed";
import { Icons } from "./icons";
import { istParts } from "@/core/market/session";
import { useHighLowFeed, useHighLowPolling, type Feed } from "@/client/highLowFeed";

export { useHighLowFeed, useHighLowPolling };

// Live feed of F&O stocks making a new day high / low, in cash or near-month
// futures. The server scans every 20 s (src/server/services/highLowScanner.ts); the terminal
// asks for anything new every 5 s and prints it at the top of the table.

const sweepLabel = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`);
const istMinutes = (at: number) => istParts(at).minutes;
const time = (at: number) => new Date(at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

const STATUS_TEXT: Record<Feed["status"], string> = {
  live: "Live",
  closed: "Market closed",
  "no-broker": "Connect Fyers to scan",
  starting: "Starting…",
  error: "Scan unavailable",
};

export function HighLowPanel() {
  const prefs = useTerminal((state) => state.screener);
  const height = prefs.height;
  const watchlist = useTerminal((state) => state.watchlist);
  const activeSymbol = useTerminal((state) => state.cells[state.activeCell].symbol);
  const ideas = useScreenerFeed((current) => current.ideas);
  const data = useHighLowFeed((current) => current);
  const filter = prefs.hl;

  const rows = useMemo(() => {
    const inList = new Set(watchlist);
    let list = data.events.filter(
      (event) =>
        (filter.kind === "all" || event.kind === filter.kind) &&
        (filter.segment === "both" || event.segment === filter.segment) &&
        (!filter.listOnly || inList.has(event.symbol)) &&
        (!filter.from930 || istMinutes(event.at) >= 9 * 60 + 30),
    );
    if (filter.latestOnly) {
      const seen = new Set<string>();
      list = [...list].reverse().filter((event) => {
        const key = `${event.symbol}|${event.segment}|${event.kind}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return list.slice(0, 400);
    }
    return [...list].reverse().slice(0, 400);
  }, [data.events, filter, watchlist]);

  const shortlisted = useMemo(() => new Set(watchlist), [watchlist]);
  const patch = (next: Partial<typeof filter>) => updateScreener({ hl: { ...filter, ...next } });
  const seg = (value: typeof filter.segment, label: string) => (
    <button type="button" className={filter.segment === value ? "is-active" : ""} onClick={() => patch({ segment: value })}>
      {label}
    </button>
  );
  const kind = (value: typeof filter.kind, label: string) => (
    <button type="button" className={filter.kind === value ? "is-active" : ""} onClick={() => patch({ kind: value })}>
      {label}
    </button>
  );

  return (
    <section className="tx-scr tx-hl" style={{ height: prefs.maximized ? undefined : `min(${height}px, 42vh)` }}>
      <header className="tx-scr-head">
        <span className="tx-cmp-title">Day high / low</span>
        <span className={`tx-hl-status is-${data.status}`}>
          <i />
          {STATUS_TEXT[data.status]}
          {data.status === "live" && data.lastPollAt ? ` · ${data.instruments} instruments · ${time(data.lastPollAt)}` : ""}
          {data.status === "live" ? (
            <span title="Every F&O stock is re-read through the quotes API at a pace that fits the daily API limit. A late read still catches the new high/low (quotes carry the day's range); symbols streaming live (open charts, top of the watchlist) are checked on every tick.">
              {data.sweepMs ? ` · full sweep every ${sweepLabel(data.sweepMs)}` : " · API budget for today used — live symbols only"}
            </span>
          ) : null}
        </span>
        <span className="tx-hl-totals">
          <span className="is-up">▲ {data.totals.highs}</span>
          <span className="is-down">▼ {data.totals.lows}</span>
        </span>
        <span className="tx-tb-spacer" />
        <div className="tx-seg" role="group" aria-label="Event">
          {kind("all", "All")}
          {kind("high", "Highs")}
          {kind("low", "Lows")}
        </div>
        <div className="tx-seg" role="group" aria-label="Segment">
          {seg("both", "Cash + Fut")}
          {seg("cash", "Cash")}
          {seg("fut", "Fut")}
        </div>
      </header>
      <div className="tx-scr-chips">
        <button type="button" className={`tx-scr-chip ${filter.latestOnly ? "is-active" : ""}`} onClick={() => patch({ latestOnly: !filter.latestOnly })} title="One row per stock: its latest new high / low">
          Latest per stock
        </button>
        <button type="button" className={`tx-scr-chip ${filter.from930 ? "is-active" : ""}`} onClick={() => patch({ from930: !filter.from930 })} title="Hide the first 15 minutes, when nearly everything makes a new high or low">
          From 9:30
        </button>
        <button type="button" className={`tx-scr-chip ${filter.listOnly ? "is-active" : ""}`} onClick={() => patch({ listOnly: !filter.listOnly })}>
          <Icons.star size={13} filled={filter.listOnly} /> Open list only
        </button>
        <span className="tx-side-note tx-hl-note">New rows print at the top. The first quote of the day is the baseline, so only breaks after you open the terminal show up.</span>
      </div>
      <div className="tx-scr-table-wrap">
        <table className="tx-scr-table tx-hl-table">
          <thead>
            <tr>
              <th className="is-left">Time</th>
              <th className="is-left">Symbol</th>
              <th className="is-left">Seg</th>
              <th className="is-left">Event</th>
              <th>Price</th>
              <th title="The day high / low it broke">Broke</th>
              <th>LTP</th>
              <th>Chg%</th>
              <th title="How many new highs (or lows) today">#</th>
              <th className="col-actions" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((event) => {
              const idea = ideas.get(event.symbol);
              return (
                <tr key={event.seq} className={`tx-hl-row is-${event.kind} ${event.symbol === activeSymbol ? "is-active" : ""}`} onClick={() => updateActiveCell({ symbol: event.symbol })}>
                  <td className="is-left tx-dim">{time(event.at)}</td>
                  <td className="is-left">
                    <span className="tx-scr-symbol">{event.symbol}</span>
                    {idea && <span className={`tx-wl-setup tx-hz-${idea.best.screen.group}`} title={idea.hits.map((hit) => hit.screen.name).join(", ")}>{idea.hits.length}</span>}
                  </td>
                  <td className="is-left">
                    <span className={`tx-tag ${event.segment === "fut" ? "tx-tag-index" : ""}`}>{event.segment === "fut" ? "FUT" : "CASH"}</span>
                  </td>
                  <td className={`is-left ${event.kind === "high" ? "is-up" : "is-down"}`}>{event.kind === "high" ? "▲ New day high" : "▼ New day low"}</td>
                  <td className={event.kind === "high" ? "is-up" : "is-down"}>{formatPrice(event.price)}</td>
                  <td className="tx-dim">{formatPrice(event.previous)}</td>
                  <td>{formatPrice(event.ltp)}</td>
                  <td className={event.changePct >= 0 ? "is-up" : "is-down"}>
                    {event.changePct >= 0 ? "+" : ""}
                    {event.changePct.toFixed(2)}%
                  </td>
                  <td>{event.count}</td>
                  <td className="tx-scr-actions">
                    <button
                      type="button"
                      className={`tx-star ${shortlisted.has(event.symbol) ? "is-on" : ""}`}
                      title={shortlisted.has(event.symbol) ? "Remove from the open list" : "Add to the open list"}
                      onClick={(clickEvent) => {
                        clickEvent.stopPropagation();
                        toggleShortlist(event.symbol);
                      }}
                    >
                      <Icons.star size={15} filled={shortlisted.has(event.symbol)} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && (
          <div className="tx-scr-state">
            {data.status === "no-broker" ? (
              <>
                <strong>Connect Fyers to scan</strong>
                <span>The scan reads live day highs and lows for every F&amp;O stock and its near-month future.</span>
              </>
            ) : data.status === "closed" ? (
              <>
                <strong>Market closed</strong>
                <span>The scan runs 9:15–15:30 IST on trading days{data.events.length ? "; today's events are filtered out by the options above" : ""}.</span>
              </>
            ) : (
              <>
                <strong>Watching {data.instruments || "all"} F&amp;O instruments</strong>
                <span>New day highs and lows print here as they happen.</span>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
