"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatPrice } from "@/core/format";
import { SCREENS, SCREEN_GROUPS, SCREEN_MAP, type ScreenerRow } from "@/core/screener/screens";
import type { TrackRecord } from "@/core/screener/backtest";
import { toggleShortlist, updateScreener, useTerminal } from "./store";
import { GROUP_LABEL, focusedHit, refreshScreener, riskReward, scoreHit, setIdeaOrder, useScreenerFeed, type SetupHit, type TradeIdea } from "@/client/screenerFeed";
import { openIdea } from "./ideaActions";
import { drawPlanOnChart } from "./SetupCard";
import { ScoreChip } from "./ScoreBits";
import type { SetupScore } from "@/core/screener/score";
import { ResultsBadge } from "./MarketPanel";
import { Icons } from "./icons";
import { PriceCells, useVisibleLiveTick } from "./LivePrice";
import { isBuyStop, planStatus } from "@/core/screener/planStatus";
import { isNewSetup } from "@/core/screener/fresh";
import type { ScreenerResponse } from "@/contracts/api";

const UNIVERSES = [
  { id: "nifty50", label: "Nifty 50" },
  { id: "nifty200", label: "Nifty 200" },
  { id: "fno", label: "F&O stocks" },
  { id: "nifty500", label: "Nifty 500" },
];

const MIN_RR_OPTIONS = [0, 1.5, 2, 3];

type SortKey = "setups" | "score" | "setupScore" | "symbol" | "changePct" | "volRatio" | "deliveryPct" | "rsi14" | "rsRank" | "rr" | "track" | "since";

/** One table row: a stock plus the setup whose plan the row shows. */
interface Line {
  symbol: string;
  idea: TradeIdea;
  hit: SetupHit;
  row: ScreenerRow;
}

function formatDay(time: number) {
  return new Date(time).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

function TrackCell({ record }: { record?: TrackRecord }) {
  if (!record) return <span className="tx-dim">…</span>;
  if (!record.signals) return <span className="tx-dim">—</span>;
  const share = record.winShare !== null ? `${Math.round(record.winShare * 100)}%` : `${(record.avgR ?? 0) >= 0 ? "+" : ""}${(record.avgR ?? 0).toFixed(2)}R`;
  return (
    <span className={`tx-track tx-tone-${record.tone}`} title={`${record.verdict} ${record.signals} past signals: ${record.target} target first, ${record.stop} stop first, ${record.open} still open. Avg ${(record.avgR ?? 0).toFixed(2)} R.`}>
      {share}
    </span>
  );
}

export function ScreenerPanel() {
  const prefs = useTerminal((state) => state.screener);
  const activeSymbol = useTerminal((state) => state.cells[state.activeCell].symbol);
  const watchlist = useTerminal((state) => state.watchlist);
  const shortlisted = useMemo(() => new Set(watchlist), [watchlist]);
  const data = useScreenerFeed((feed) => feed.data);
  const ideas = useScreenerFeed((feed) => feed.ideas);
  const focus = useScreenerFeed((feed) => feed.focus);
  const track = useScreenerFeed((feed) => feed.track);
  const results = useScreenerFeed((feed) => feed.results);
  // One setup score per (stock, setup) shown — cached until the feed changes.
  const scores = useMemo(() => {
    const map = new Map<string, SetupScore | null>();
    for (const idea of ideas.values()) for (const hit of idea.hits) map.set(`${idea.symbol}:${hit.screen.id}`, scoreHit(hit, track, results));
    return map;
  }, [ideas, track, results]);
  const loading = useScreenerFeed((feed) => feed.loading);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "setupScore", dir: -1 });
  const [query, setQuery] = useState("");
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  const allView = prefs.group === "all";
  const screen = SCREEN_MAP[prefs.screenId] ?? SCREENS[0];
  const group = SCREEN_GROUPS.find((entry) => entry.id === screen.group) ?? SCREEN_GROUPS[0];
  const records = track?.screens;

  const sectors = useMemo(() => [...new Set([...ideas.values()].map((idea) => idea.industry).filter(Boolean))].sort(), [ideas]);

  const lines = useMemo<Line[]>(() => {
    const needle = query.trim().toUpperCase();
    const inWatchlist = new Set(watchlist);
    const base: Line[] = allView
      ? [...ideas.values()].map((idea) => {
          const hit = focusedHit(idea, focus);
          return { symbol: idea.symbol, idea, hit, row: hit.row };
        })
      : (data?.results?.[screen.id] ?? []).flatMap((row) => {
          const idea = ideas.get(row.symbol);
          const hit = idea?.hits.find((entry) => entry.screen.id === screen.id);
          return idea && hit ? [{ symbol: row.symbol, idea, hit, row }] : [];
        });

    const filtered = base.filter(({ idea, hit }) => {
      if (needle && !idea.symbol.includes(needle) && !idea.name.toUpperCase().includes(needle)) return false;
      if (prefs.sector && idea.industry !== prefs.sector) return false;
      if (prefs.minRR && (hit.rr ?? 0) < prefs.minRR) return false;
      if (prefs.watchlistOnly && !inWatchlist.has(idea.symbol)) return false;
      return true;
    });

    const value = ({ idea, hit, row }: Line): number | string => {
      switch (sort.key) {
        case "symbol":
          return row.symbol;
        case "setups":
          // Confluence first, then how well the best setup's rules have done.
          return idea.hits.length * 1000 + (records?.[hit.screen.id]?.avgR ?? 0) * 100 + Math.min(row.score, 99) / 100;
        case "rr":
          return hit.rr ?? -Infinity;
        case "setupScore":
          return scores.get(`${row.symbol}:${hit.screen.id}`)?.total ?? -Infinity;
        case "track":
          return records?.[hit.screen.id]?.avgR ?? -Infinity;
        case "since":
          // Newest setup on the stock (in "All setups" a stock can match several screens).
          return Math.max(0, ...idea.hits.map((entry) => entry.row.firstSeenAt ?? 0), row.firstSeenAt ?? 0);
        default: {
          const raw = row[sort.key];
          return typeof raw === "number" && Number.isFinite(raw) ? raw : -Infinity;
        }
      }
    };
    return filtered.sort((a, b) => {
      const left = value(a);
      const right = value(b);
      return (left < right ? -1 : left > right ? 1 : 0) * sort.dir;
    });
  }, [allView, data, ideas, focus, screen.id, query, prefs.sector, prefs.minRR, prefs.watchlistOnly, watchlist, sort, records, scores]);

  // Publish the visible order so [ / ] can step through it from anywhere.
  useEffect(() => setIdeaOrder(lines.map((line) => line.symbol)), [lines]);

  // Keep the active row in view while stepping.
  useEffect(() => {
    tableRef.current?.querySelector("tr.is-active")?.scrollIntoView({ block: "nearest" });
  }, [activeSymbol]);

  const step = (direction: 1 | -1) => {
    if (!lines.length) return;
    const index = lines.findIndex((line) => line.symbol === activeSymbol);
    const next = lines[index === -1 ? (direction === 1 ? 0 : lines.length - 1) : Math.min(lines.length - 1, Math.max(0, index + direction))];
    openIdea(next.symbol, next.hit.screen.id);
  };

  const onTableKey = (event: React.KeyboardEvent) => {
    const key = event.key.toLowerCase();
    const current = lines.find((line) => line.symbol === activeSymbol);
    if (key === "arrowdown" || key === "j") step(1);
    else if (key === "arrowup" || key === "k") step(-1);
    else if (key === "w" && current) toggleShortlist(current.symbol);
    else if (key === "p" && current) drawPlanOnChart(current.hit);
    else return;
    // Keep these keys away from the chart's pan/zoom and the type-to-search shortcut.
    event.preventDefault();
    event.stopPropagation();
  };

  const setSortKey = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: key === "symbol" ? 1 : -1 }));

  const onResizeStart = (event: React.PointerEvent) => {
    dragRef.current = { startY: event.clientY, startHeight: prefs.height };
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: React.PointerEvent) => {
    if (!dragRef.current) return;
    const max = Math.round(window.innerHeight * 0.75);
    const height = Math.min(max, Math.max(180, dragRef.current.startHeight - (event.clientY - dragRef.current.startY)));
    updateScreener({ height });
  };

  const header = (key: SortKey, label: string, align: "left" | "right" = "right", title?: string, className = "") => (
    <th className={`${align === "left" ? "is-left" : ""} ${className}`} title={title}>
      <button type="button" onClick={() => setSortKey(key)}>
        {label}
        {sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );

  const progress = data?.progress;
  const syncing = data?.status === "syncing" || data?.syncing;
  const status =
    data?.status === "error"
      ? "No data"
      : data?.status === "syncing"
        ? `${progress?.message ?? "Syncing"} ${progress?.total ? `${progress.done}/${progress.total}` : ""}`
        : data?.asOf
          ? `${data.universe?.covered}/${data.universe?.count} stocks · EOD ${formatDay(data.asOf.eodDate)}${liveStatus(data.asOf)}${data.syncing ? " · updating…" : ""}`
          : "Loading…";

  // New setups: appeared after the day's first scan, within the last 30 minutes.
  const now = data?.asOf?.computedAt ?? 0;
  const firstScanAt = useMemo(() => {
    const times = Object.values(data?.results ?? {}).flatMap((rows) => rows.map((row) => row.firstSeenAt ?? Infinity));
    return times.length ? Math.min(...times) : 0;
  }, [data]);
  const newCount = lines.filter(({ idea, row }) => idea.hits.some((entry) => isNewSetup(entry.row.firstSeenAt, firstScanAt, now)) || isNewSetup(row.firstSeenAt, firstScanAt, now)).length;

  const groupCount = (id: string) => [...ideas.values()].filter((idea) => idea.groups.includes(id as never)).length;
  const filtersActive = Boolean(query || prefs.sector || prefs.minRR || prefs.watchlistOnly);

  return (
    <section className="tx-scr" style={{ height: prefs.maximized ? undefined : `min(${prefs.height}px, 42vh)` }}>
      <div className="tx-scr-resize" onPointerDown={onResizeStart} onPointerMove={onResizeMove} onPointerUp={() => (dragRef.current = null)} />

      <header className="tx-scr-head">
        <div className="tx-scr-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={allView}
            className={`tx-scr-tab ${allView ? "is-active" : ""}`}
            onClick={() => updateScreener({ group: "all" })}
            title="Every setup from every screen, one row per stock"
          >
            All setups
            <span className="tx-scr-count">{ideas.size || "–"}</span>
          </button>
          {SCREEN_GROUPS.map((entry) => (
            <button
              type="button"
              role="tab"
              key={entry.id}
              aria-selected={!allView && entry.id === group.id}
              className={`tx-scr-tab tx-hz-${entry.id} ${!allView && entry.id === group.id ? "is-active" : ""}`}
              onClick={() =>
                updateScreener({
                  group: entry.id,
                  screenId: screen.group === entry.id ? screen.id : SCREENS.find((s) => s.group === entry.id)?.id ?? prefs.screenId,
                })
              }
            >
              <span className="tx-hz-dot" />
              {entry.label}
              <span className="tx-scr-horizon">{entry.horizon}</span>
              <span className="tx-scr-count">{ideas.size ? groupCount(entry.id) : "–"}</span>
            </button>
          ))}
        </div>
        <select
          className="tx-input tx-scr-universe"
          value={prefs.universe}
          onChange={(event) => updateScreener({ universe: event.target.value })}
          aria-label="Universe"
        >
          {UNIVERSES.map((universe) => (
            <option key={universe.id} value={universe.id}>
              {universe.label}
            </option>
          ))}
        </select>
        {data?.regime && (
          <span
            className={`tx-regime is-${data.regime.state}`}
            title={[
              `Market regime: ${data.regime.label}`,
              ...data.regime.reasons,
              data.regime.state === "healthy" ? "Long setups get no penalty." : `Long setups lose ${data.regime.state === "risk-off" ? 10 : 4} points.`,
              data.ban ? (data.ban.available ? `F&O ban today: ${data.ban.symbols.length ? data.ban.symbols.join(", ") : "none"}` : "F&O ban list: NSE couldn't be reached") : "",
            ]
              .filter(Boolean)
              .join("\n")}
          >
            <i aria-hidden />
            Market: {data.regime.label}
          </span>
        )}
        <span className={`tx-scr-status ${data?.status === "error" || data?.asOf?.stale ? "is-error" : ""}`} title={data?.asOf?.stale ? "Market is open but no live prices are arriving (broker disconnected or today's API budget used up): the screens show the last close." : progress?.message}>
          {syncing && <span className="tx-spinner tx-spinner-sm" />}
          {status}
        </span>
        <span className="tx-tb-spacer" />
        <button type="button" className={`tx-icon-btn ${prefs.showInfo ? "is-on" : ""}`} title="Rules, track record & sources" onClick={() => updateScreener({ showInfo: !prefs.showInfo })}>
          <Icons.gear size={15} />
        </button>
        <button type="button" className="tx-icon-btn" title="Refresh" disabled={loading} onClick={refreshScreener}>
          <Icons.reset size={15} />
        </button>
      </header>

      {data?.status === "syncing" && progress?.total ? (
        <div className="tx-scr-progress">
          <div style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
        </div>
      ) : null}

      <div className="tx-scr-chips">
        {!allView &&
          SCREENS.filter((entry) => entry.group === group.id).map((entry) => {
            const count = data?.results?.[entry.id]?.length;
            return (
              <button
                type="button"
                key={entry.id}
                className={`tx-scr-chip ${entry.id === screen.id ? "is-active" : ""}`}
                onClick={() => updateScreener({ screenId: entry.id })}
                title={entry.summary}
              >
                {entry.name}
                <span className="tx-scr-count">{count ?? "–"}</span>
              </button>
            );
          })}
        <div className="tx-scr-filters">
          <label className="tx-scr-search">
            <Icons.search size={13} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter symbol or name" aria-label="Filter symbol or name" />
          </label>
          <select className="tx-input" value={prefs.sector} onChange={(event) => updateScreener({ sector: event.target.value })} aria-label="Sector">
            <option value="">All sectors</option>
            {sectors.map((sector) => (
              <option key={sector} value={sector}>
                {sector}
              </option>
            ))}
          </select>
          <select className="tx-input" value={prefs.minRR} onChange={(event) => updateScreener({ minRR: Number(event.target.value) })} aria-label="Minimum reward to risk">
            {MIN_RR_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value ? `R:R ≥ ${value}` : "Any R:R"}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`tx-btn-outline tx-scr-new ${sort.key === "since" ? "is-on" : ""}`}
            disabled={!newCount && sort.key !== "since"}
            title="Setups that appeared in the last 30 minutes (not the ones from the open). Click to sort newest first."
            onClick={() => setSort(sort.key === "since" ? { key: "setupScore", dir: -1 } : { key: "since", dir: -1 })}
          >
            {newCount ? `${newCount} new` : "Newest"}
          </button>
          <button
            type="button"
            className={`tx-scr-chip ${prefs.watchlistOnly ? "is-active" : ""}`}
            onClick={() => updateScreener({ watchlistOnly: !prefs.watchlistOnly })}
            title="Only stocks you've shortlisted (your watchlist)"
          >
            <Icons.star size={13} filled={prefs.watchlistOnly} />
            Shortlist
          </button>
          {filtersActive && (
            <button
              type="button"
              className="tx-scr-clear"
              onClick={() => {
                setQuery("");
                updateScreener({ sector: "", minRR: 0, watchlistOnly: false });
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="tx-scr-body">
        <div className="tx-scr-table-wrap" ref={tableRef} tabIndex={0} onKeyDown={onTableKey} aria-label="Screener results — ↑/↓ to step through">
          <table className="tx-scr-table">
            <thead>
              <tr>
                {header("symbol", "Symbol", "left")}
                <th className="col-price">Price</th>
                {header("changePct", "Chg%")}
                {allView ? (
                  header("setups", "Setups", "left", "How many screens this stock matches, then how well its best setup has done")
                ) : (
                  <>
                    {header("volRatio", screen.id === "pos-base-breakout" ? "Vol×50D" : "Vol×20D", "right", undefined, "col-extra")}
                    {header("deliveryPct", "Deliv%", "right", undefined, "col-extra")}
                    {header("rsi14", "RSI", "right", undefined, "col-extra")}
                    {header("rsRank", "RS", "right", undefined, "col-extra")}
                    <th className="is-left col-signals">Signals</th>
                  </>
                )}
                <th>Entry</th>
                <th>Stop</th>
                <th>Target</th>
                {header("rr", "R:R")}
                {header("setupScore", "Score", "right", "Setup score out of 100: trend, relative strength, accumulation, pattern, reward:risk, stop distance, extension, track record, minus penalties")}
                {header("track", "Track", "right", "Past signals of this setup: share that hit the target before the stop (or avg R for trailing exits)", "col-track")}
                <th className="col-actions" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {lines.map(({ symbol, idea, hit, row }) => (
                <ScreenerRowView
                  key={symbol}
                  symbol={symbol}
                  idea={idea}
                  hit={hit}
                  row={row}
                  allView={allView}
                  active={symbol === activeSymbol}
                  score={scores.get(`${symbol}:${hit.screen.id}`) ?? null}
                  record={records?.[hit.screen.id]}
                  shortlisted={shortlisted.has(symbol)}
                  firstScanAt={firstScanAt}
                  now={now}
                />
              ))}
            </tbody>
          </table>
          {data?.status === "ready" && lines.length === 0 && (
            <div className="tx-scr-state">
              {filtersActive
                ? "Nothing matches these filters."
                : allView
                  ? `No stocks in ${data.universe?.label} match any screen right now.`
                  : `No stocks in ${data.universe?.label} match every rule right now.`}
            </div>
          )}
          {data?.status === "syncing" && (
            <div className="tx-scr-state">
              <span className="tx-spinner" />
              <strong>Building the daily history</strong>
              <span>First run for this universe: each stock is downloaded once (Fyers allows ~200 requests/min), then it&apos;s cached on disk.</span>
            </div>
          )}
          {data?.status === "error" && (
            <div className="tx-scr-state is-error">
              <Icons.screener size={22} />
              <strong>The screener has no data yet</strong>
              <span>{data.error}</span>
              <span className="tx-dim">It tries again every 30 seconds.</span>
              <button type="button" className="tx-btn-small" onClick={refreshScreener} disabled={loading}>
                Retry now
              </button>
            </div>
          )}
          {!data && (
            <div className="tx-scr-skeleton" aria-label="Loading">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} />
              ))}
            </div>
          )}
        </div>

        {prefs.showInfo && (
          <aside className="tx-scr-info">
            <button type="button" className="tx-icon-btn tx-scr-info-close" title="Close" onClick={() => updateScreener({ showInfo: false })}>
              <Icons.x size={15} />
            </button>
            {allView ? <AllInfo records={records} sessions={track?.sessions} /> : <ScreenInfo screenId={screen.id} record={records?.[screen.id]} sessions={track?.sessions} />}
          </aside>
        )}
      </div>
    </section>
  );
}

/** One screener row. It follows the live price while on screen and checks the plan against it. */
/** Compact tag for the entry cell (the full explanation is in the cell's tooltip). */
function shortStatus(status: Exclude<ReturnType<typeof planStatus>, { kind: "ok" }>): string {
  switch (status.kind) {
    case "stop-broken":
      return "stop";
    case "triggered":
      return "hit";
    case "far":
      return "far";
    case "moved":
      return `${status.pct >= 0 ? "+" : ""}${status.pct.toFixed(1)}%`;
  }
}

/** NEW badge for a setup that appeared in the last 30 minutes (not one that was there at the open); the time is in the tooltip. */
function NewBadge({ firstSeenAt, firstScanAt, now }: { firstSeenAt?: number; firstScanAt: number; now: number }) {
  if (!firstSeenAt || !isNewSetup(firstSeenAt, firstScanAt, now)) return null;
  const time = new Date(firstSeenAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
  return (
    <span className="tx-new-badge" title={`New setup: first matched at ${time}`}>
      NEW
    </span>
  );
}

/** "· prices 40 s old · refresh ~1 min" (or a warning when live prices aren't arriving). */
function liveStatus(asOf: NonNullable<ScreenerResponse["asOf"]>): string {
  if (asOf.stale) return " · ⚠ no live prices — showing the last close";
  if (!asOf.live || !asOf.quotesAt) return "";
  const age = Math.max(0, Math.round((asOf.computedAt - asOf.quotesAt) / 1000));
  const pace = asOf.paceMs ? (asOf.paceMs >= 60_000 ? `${Math.round(asOf.paceMs / 60_000)} min` : `${Math.round(asOf.paceMs / 1000)} s`) : null;
  return ` · live · quotes ${age} s old${pace ? `, refresh ~${pace}` : ""}${asOf.fromTicks ? ` · ${asOf.fromTicks} on ticks` : ""}`;
}

function ScreenerRowView({ symbol, idea, hit, row, allView, active, score, record, shortlisted, firstScanAt, now }: { symbol: string; idea: TradeIdea; hit: SetupHit; row: ScreenerRow; allView: boolean; active: boolean; score: SetupScore | null; record?: TrackRecord; shortlisted: boolean; firstScanAt: number; now: number }) {
  const { ref, tick } = useVisibleLiveTick<HTMLTableRowElement>(symbol);
  const rr = riskReward(row);
  const buyStop = isBuyStop(row.plan, row.close);
  // The plan was made at the scan; check it against the live price (stale entry, broken stop, trigger out of reach).
  const status = tick ? planStatus(row.plan, row.close, tick.ltp, row.facts?.atr14 ?? NaN) : ({ kind: "ok" } as const);
  const newest = Math.max(0, ...idea.hits.map((entry) => entry.row.firstSeenAt ?? 0), row.firstSeenAt ?? 0) || undefined;
  const isNew = isNewSetup(newest, firstScanAt, now);
  return (
    <tr ref={ref} className={`${active ? "is-active" : ""} ${status.kind === "stop-broken" || status.kind === "moved" || status.kind === "far" ? "is-stale" : ""}`} onClick={() => openIdea(symbol, hit.screen.id)}>
      <td className="is-left" title={`${idea.name}${idea.industry ? ` · ${idea.industry}` : ""}`}>
        <span className="tx-scr-symbol">{symbol}</span>
        <NewBadge firstSeenAt={newest} firstScanAt={firstScanAt} now={now} />
        <ResultsBadge symbol={symbol} compact />
        {row.warnings?.length ? (
          <span className="tx-warn-dot" title={row.warnings.join("\n")}>
            !
          </span>
        ) : null}
        {idea.live && !isNew && <span className="tx-tag tx-tag-index">live</span>}
      </td>
      <PriceCells tick={tick} close={idea.close} changePct={idea.changePct} priceClassName="col-price" />
      {allView ? (
        <td className="is-left" title={idea.hits.map((entry) => `${GROUP_LABEL[entry.screen.group]} · ${entry.screen.name}`).join("\n")}>
          <span className="tx-confluence">
            <span className={`tx-confluence-n is-${Math.min(idea.hits.length, 4)}`}>{idea.hits.length}</span>
            <span className={`tx-confluence-name tx-hz-${hit.screen.group}`}>{hit.screen.name}</span>
            <span className="tx-confluence-dots">
              {idea.groups.map((groupId) => (
                <span key={groupId} className={`tx-hz-dot tx-hz-${groupId}`} />
              ))}
            </span>
          </span>
        </td>
      ) : (
        <>
          <td className="col-extra">{Number.isFinite(row.volRatio) ? `${row.volRatio.toFixed(1)}×` : "—"}</td>
          <td className="col-extra">{row.deliveryPct !== null ? `${row.deliveryPct.toFixed(0)}%` : "—"}</td>
          <td className="col-extra">{Number.isFinite(row.rsi14) ? row.rsi14.toFixed(0) : "—"}</td>
          <td className="col-extra">{Number.isFinite(row.rsRank) ? row.rsRank : "—"}</td>
          <td className="is-left col-signals">
            <span className="tx-scr-tags">
              {row.tags.map((tag) => (
                <span key={tag} className="tx-tag">
                  {tag}
                </span>
              ))}
            </span>
          </td>
        </>
      )}
      <td title={status.kind === "ok" ? (buyStop ? "Buy-stop: enter only on a break above this price" : "Enter at the close") : status.detail}>
        {buyStop && <span className="tx-dim tx-plan-dir">↑ </span>}
        {formatPrice(row.plan.entry)}
        {status.kind !== "ok" && <span className={`tx-plan-status is-${status.kind}`} aria-label={status.detail}>{shortStatus(status)}</span>}
      </td>
      <td className="is-down">{formatPrice(row.plan.stop)}</td>
      <td className="is-up">{row.plan.target !== null ? formatPrice(row.plan.target) : "trail"}</td>
      <td>{rr !== null ? rr.toFixed(1) : "—"}</td>
      <td>
        <ScoreChip score={score} />
      </td>
      <td className="col-track">
        <TrackCell record={record} />
      </td>
      <td className="tx-scr-actions">
        <button
          type="button"
          className="col-plan"
          title="Save this plan on the chart as a Long Position (P)"
          onClick={(event) => {
            event.stopPropagation();
            drawPlanOnChart(hit);
          }}
        >
          <Icons.long size={15} />
        </button>
        <button
          type="button"
          className={`tx-star ${shortlisted ? "is-on" : ""}`}
          title={shortlisted ? "Remove from shortlist (W)" : "Shortlist (W)"}
          aria-pressed={shortlisted}
          onClick={(event) => {
            event.stopPropagation();
            toggleShortlist(symbol);
          }}
        >
          <Icons.star size={15} filled={shortlisted} />
        </button>
      </td>
    </tr>
  );
}

function AllInfo({ records, sessions }: { records?: Record<string, TrackRecord>; sessions?: number }) {
  return (
    <>
      <div className="tx-scr-info-name">Finding a trade</div>
      <ol className="tx-scr-rules">
        <li>
          Start with stocks that match <strong>more than one screen</strong> — they sort to the top.
        </li>
        <li>
          Step through with <kbd>↑</kbd>/<kbd>↓</kbd> here, or <kbd>[</kbd>/<kbd>]</kbd> anywhere. The chart shows the entry, stop and target.
        </li>
        <li>Prefer setups whose rules have a good <strong>track record</strong> and R:R ≥ 1.5.</li>
        <li>Size it in the sidebar card so a stop-out costs only what you chose to risk.</li>
      </ol>
      <div className="tx-section-label">Track record · last {sessions ?? "…"} sessions</div>
      <table className="tx-scr-track">
        <thead>
          <tr>
            <th className="is-left">Screen</th>
            <th>Signals</th>
            <th title="Target first, of the signals that hit a side">Win</th>
            <th>Avg R</th>
          </tr>
        </thead>
        <tbody>
          {SCREENS.map((screen) => {
            const record = records?.[screen.id];
            return (
              <tr key={screen.id} title={record?.verdict}>
                <td className="is-left">
                  <span className={`tx-hz-dot tx-hz-${screen.group}`} /> {screen.name}
                </td>
                <td>{record ? record.signals : "…"}</td>
                <td className={record ? `tx-tone-${record.tone}` : ""}>
                  {record?.winShare !== null && record?.winShare !== undefined ? `${Math.round(record.winShare * 100)}%` : "—"}
                </td>
                <td className={record ? `tx-tone-${record.tone}` : ""}>
                  {record?.avgR !== null && record?.avgR !== undefined ? `${record.avgR >= 0 ? "+" : ""}${record.avgR.toFixed(2)}` : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="tx-scr-note">
        Each past signal&apos;s plan is walked forward on daily bars: a bar touching both stop and target counts as the stop, gaps fill at the open, and trades
        still open after the holding period are marked to the close. Method adapted from the Day Trader skill&apos;s Time Machine. Today&apos;s index members, so
        survivorship bias applies. Not a prediction, not advice.
      </p>
    </>
  );
}

function ScreenInfo({ screenId, record, sessions }: { screenId: string; record?: TrackRecord; sessions?: number }) {
  const screen = SCREEN_MAP[screenId];
  const group = SCREEN_GROUPS.find((entry) => entry.id === screen.group) ?? SCREEN_GROUPS[0];
  return (
    <>
      <div className="tx-scr-info-name">{screen.name}</div>
      <div className="tx-scr-info-horizon">
        {screen.horizon} · {screen.basis === "eod" ? "last completed session" : "includes today's live candle in market hours"}
      </div>
      <p>{screen.summary}</p>
      {record && (
        <div className={`tx-scr-verdict tx-tone-${record.tone}`}>
          <strong>{record.verdict}</strong> {record.signals} signals in the last {sessions} sessions: {record.target} target, {record.stop} stop, {record.open} open.
          {record.avgR !== null && ` Avg ${record.avgR >= 0 ? "+" : ""}${record.avgR.toFixed(2)} R.`}
          {record.winShare !== null && record.breakEven !== null &&
            ` Target first ${Math.round(record.winShare * 100)}% vs ${Math.round(record.breakEven * 100)}% needed at ${record.planR}R.`}
        </div>
      )}
      <div className="tx-section-label">Rules (all must pass)</div>
      <ul className="tx-scr-rules">
        {screen.rules.map((rule) => (
          <li key={rule.label}>{rule.label}</li>
        ))}
      </ul>
      <p className="tx-scr-note">{group.note}</p>
      <div className="tx-section-label">Sources</div>
      <ul className="tx-scr-sources">
        {screen.sources.map((source) => (
          <li key={source.label}>
            {source.url ? (
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.label}
              </a>
            ) : (
              source.label
            )}
          </li>
        ))}
      </ul>
      <p className="tx-scr-note">Educational screens, not investment advice. Levels are mechanical starting points — check the chart.</p>
    </>
  );
}
