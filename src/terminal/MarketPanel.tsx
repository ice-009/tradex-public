"use client";

import { useMemo, useState } from "react";
import { formatPrice } from "@/core/format";
import type { MarketRow, SectorStat } from "@/core/screener/screens";
import { addPresetList, toggleShortlist, updateActiveCell, updateScreener, useTerminal, type SidePanel } from "./store";
import { loadResultsCalendar, resultsNote, useScreenerFeed, type ResultsEvent } from "@/client/screenerFeed";
import { openIdea } from "./ideaActions";
import { SymbolLogo } from "./Watchlist";
import { Icons } from "./icons";
import { istParts } from "@/core/market/session";

const pct = (value: number, digits = 2) => (Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%` : "—");
const tone = (value: number) => (value > 0 ? "is-up" : value < 0 ? "is-down" : "");

/** Movers / Sectors / Results: the other sidebar panels (the watchlist is its own component). */
export function MarketPanel({ panel }: { panel: Exclude<SidePanel, "watchlist" | "alerts"> }) {
  if (panel === "movers") return <Movers />;
  if (panel === "sectors") return <Sectors />;
  return <Results />;
}

function PanelState({ children }: { children: React.ReactNode }) {
  return <div className="tx-empty">{children}</div>;
}

// ------------------------------------------------------------------ Movers

const MOVER_TABS = [
  { id: "gainers", label: "Gainers" },
  { id: "losers", label: "Losers" },
  { id: "active", label: "Volume" },
  { id: "highs", label: "52W high" },
] as const;

function Movers() {
  const market = useScreenerFeed((feed) => feed.data?.market);
  const universe = useScreenerFeed((feed) => feed.data?.universe?.label);
  const [tab, setTab] = useState<(typeof MOVER_TABS)[number]["id"]>("gainers");
  const rows = market?.[tab] ?? [];

  return (
    <>
      <div className="tx-side-sub">
        <div className="tx-seg tx-seg-wide" role="tablist">
          {MOVER_TABS.map((entry) => (
            <button type="button" key={entry.id} role="tab" aria-selected={tab === entry.id} className={tab === entry.id ? "is-active" : ""} onClick={() => setTab(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
        <span className="tx-side-note">{universe ?? "Screener universe"} · liquid stocks</span>
      </div>
      <div className="tx-mk-cols">
        <span>Symbol</span>
        <span>Last</span>
        <span>{tab === "active" ? "Vol×" : tab === "highs" ? "1M" : "Chg%"}</span>
      </div>
      <div className="tx-wl-list">
        {!market && <PanelState>Loading the market…</PanelState>}
        {market && !rows.length && <PanelState>Nothing here right now.</PanelState>}
        {rows.map((row) => (
          <MoverRow key={row.symbol} row={row} value={tab === "active" ? `${row.volRatio.toFixed(1)}×` : tab === "highs" ? pct(row.ret21, 1) : pct(row.changePct)} tone={tab === "active" ? "" : tone(tab === "highs" ? row.ret21 : row.changePct)} />
        ))}
      </div>
    </>
  );
}

function MoverRow({ row, value, tone: valueTone }: { row: MarketRow; value: string; tone: string }) {
  const activeSymbol = useTerminal((state) => state.cells[state.activeCell].symbol);
  const listed = useTerminal((state) => state.watchlist.includes(row.symbol));
  const idea = useScreenerFeed((feed) => feed.ideas.get(row.symbol));
  return (
    <div
      role="button"
      tabIndex={0}
      className={`tx-mk-row ${row.symbol === activeSymbol ? "is-active" : ""}`}
      title={`${row.name} · ${row.industry}`}
      onClick={() => (idea ? openIdea(row.symbol) : updateActiveCell({ symbol: row.symbol, interval: "1d" }))}
      onKeyDown={(event) => event.key === "Enter" && updateActiveCell({ symbol: row.symbol, interval: "1d" })}
    >
      <span className="tx-wl-symbol">
        <SymbolLogo symbol={row.symbol} />
        <span className="tx-wl-symbol-text">{row.symbol}</span>
        {idea && <span className={`tx-wl-setup tx-hz-${idea.best.screen.group}`}>{idea.hits.length}</span>}
      </span>
      <span className="tx-wl-num">{formatPrice(row.close)}</span>
      <span className={`tx-wl-num ${valueTone}`}>{value}</span>
      <button
        type="button"
        className={`tx-mk-star tx-star ${listed ? "is-on" : ""}`}
        title={listed ? "Remove from the open list" : "Add to the open list"}
        onClick={(event) => {
          event.stopPropagation();
          toggleShortlist(row.symbol);
        }}
      >
        <Icons.star size={14} filled={listed} />
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ Sectors

const SECTOR_SORTS = [
  { id: "change", label: "1D" },
  { id: "ret5", label: "1W" },
  { id: "ret21", label: "1M" },
] as const;

function Sectors() {
  const market = useScreenerFeed((feed) => feed.data?.market);
  const universe = useScreenerFeed((feed) => feed.data?.universe?.label);
  const [sort, setSort] = useState<(typeof SECTOR_SORTS)[number]["id"]>("change");
  const [open, setOpen] = useState<string | null>(null);
  const sectors = useMemo(() => [...(market?.sectors ?? [])].sort((a, b) => (b[sort] || 0) - (a[sort] || 0)), [market, sort]);
  const max = Math.max(0.5, ...sectors.map((sector) => Math.abs(sector[sort] || 0)));

  return (
    <>
      <div className="tx-side-sub">
        <div className="tx-seg" role="tablist" aria-label="Sort sectors by">
          {SECTOR_SORTS.map((entry) => (
            <button type="button" key={entry.id} className={sort === entry.id ? "is-active" : ""} onClick={() => setSort(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
        <span className="tx-side-note">Median move · {universe ?? "universe"}</span>
      </div>
      <div className="tx-wl-list">
        {!market && <PanelState>Loading sectors…</PanelState>}
        {sectors.map((sector) => (
          <SectorRow key={sector.sector} sector={sector} value={sector[sort]} max={max} open={open === sector.sector} onToggle={() => setOpen(open === sector.sector ? null : sector.sector)} />
        ))}
      </div>
    </>
  );
}

function SectorRow({ sector, value, max, open, onToggle }: { sector: SectorStat; value: number; max: number; open: boolean; onToggle: () => void }) {
  const width = `${Math.min(100, (Math.abs(value) / max) * 100) / 2}%`;
  return (
    <div className={`tx-sector ${open ? "is-open" : ""}`}>
      <button type="button" className="tx-sector-head" onClick={onToggle}>
        <span className="tx-sector-name">{sector.sector}</span>
        <span className="tx-sector-bar" aria-hidden>
          <i className={value >= 0 ? "is-up" : "is-down"} style={value >= 0 ? { left: "50%", width } : { right: "50%", width }} />
        </span>
        <span className={`tx-wl-num ${tone(value)}`}>{pct(value, 1)}</span>
      </button>
      <div className="tx-sector-meta">
        <span>{sector.count} stocks</span>
        <span className="tx-breadth" title="Share of the sector up today">
          <i style={{ width: `${sector.breadth * 100}%` }} />
        </span>
        <span>{Math.round(sector.breadth * 100)}% up</span>
      </div>
      {open && (
        <div className="tx-sector-body">
          <div className="tx-sector-chips">
            {sector.symbols.slice(0, 24).map((symbol) => (
              <button type="button" key={symbol} className="tx-scr-chip" onClick={() => updateActiveCell({ symbol, interval: "1d" })}>
                {symbol}
              </button>
            ))}
          </div>
          <div className="tx-setup-actions">
            <button type="button" className="tx-btn-outline" onClick={() => updateScreener({ open: true, group: "all", sector: sector.sector })}>
              <Icons.screener size={14} /> Setups in sector
            </button>
            <button type="button" className="tx-btn-small" onClick={() => addPresetList(sector.sector, sector.symbols)}>
              Make a watchlist
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Results calendar

function Results() {
  const results = useScreenerFeed((feed) => feed.results);
  const watchlist = useTerminal((state) => state.watchlist);
  const [scope, setScope] = useState<"all" | "list">("all");
  const days = useMemo(() => {
    const inList = new Set(watchlist);
    const events = (results?.events ?? []).filter((event) => scope === "all" || inList.has(event.symbol));
    const grouped = new Map<number, ResultsEvent[]>();
    for (const event of events) grouped.set(event.date, [...(grouped.get(event.date) ?? []), event]);
    return [...grouped.entries()].sort((a, b) => a[0] - b[0]);
  }, [results, watchlist, scope]);
  const today = istParts().day;

  return (
    <>
      <div className="tx-side-sub">
        <div className="tx-seg" role="tablist">
          <button type="button" className={scope === "all" ? "is-active" : ""} onClick={() => setScope("all")}>
            All
          </button>
          <button type="button" className={scope === "list" ? "is-active" : ""} onClick={() => setScope("list")}>
            Open list
          </button>
        </div>
        <span className="tx-side-note">NSE event calendar · last week → 5 weeks</span>
      </div>
      <div className="tx-wl-list">
        {!results && <PanelState>Loading the results calendar…</PanelState>}
        {results && !results.available && (
          <PanelState>
            NSE&apos;s results calendar couldn&apos;t be reached from the server, so dates aren&apos;t shown.
            <br />
            The Results screens still work — they read the price/volume reaction itself.
            <br />
            <button type="button" className="tx-btn-outline tx-retry" onClick={() => void loadResultsCalendar(true)}>
              Try again
            </button>
          </PanelState>
        )}
        {results?.available && !days.length && <PanelState>No results dates in this window{scope === "list" ? " for the open list" : ""}.</PanelState>}
        {days.map(([date, events]) => (
          <div key={date} className="tx-cal-day">
            <div className={`tx-cal-date ${date === today ? "is-today" : date < today ? "is-past" : ""}`}>
              {date === today ? "Today · " : ""}
              {new Date(date).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}
              <span>{events.length}</span>
            </div>
            {events.map((event) => (
              <CalendarRow key={`${event.symbol}-${event.date}`} event={event} />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

function CalendarRow({ event }: { event: ResultsEvent }) {
  const activeSymbol = useTerminal((state) => state.cells[state.activeCell].symbol);
  const listed = useTerminal((state) => state.watchlist.includes(event.symbol));
  const idea = useScreenerFeed((feed) => feed.ideas.get(event.symbol));
  return (
    <div
      role="button"
      tabIndex={0}
      className={`tx-mk-row tx-cal-row ${event.symbol === activeSymbol ? "is-active" : ""}`}
      title={event.purpose}
      onClick={() => updateActiveCell({ symbol: event.symbol, interval: "1d" })}
      onKeyDown={(keyEvent) => keyEvent.key === "Enter" && updateActiveCell({ symbol: event.symbol, interval: "1d" })}
    >
      <span className="tx-wl-symbol">
        <SymbolLogo symbol={event.symbol} />
        <span className="tx-wl-symbol-text">{event.symbol}</span>
        {idea && <span className={`tx-wl-setup tx-hz-${idea.best.screen.group}`}>{idea.hits.length}</span>}
      </span>
      <span className="tx-cal-company">{event.company}</span>
      <button
        type="button"
        className={`tx-mk-star tx-star ${listed ? "is-on" : ""}`}
        title={listed ? "Remove from the open list" : "Add to the open list"}
        onClick={(clickEvent) => {
          clickEvent.stopPropagation();
          toggleShortlist(event.symbol);
        }}
      >
        <Icons.star size={14} filled={listed} />
      </button>
    </div>
  );
}

/** Small "Results in 3 days" pill for the setup card and screener rows. */
export function ResultsBadge({ symbol, compact = false }: { symbol: string; compact?: boolean }) {
  const event = useScreenerFeed((feed) => feed.results?.bySymbol.get(symbol));
  const note = resultsNote(event);
  if (!note) return null;
  return (
    <span className={`tx-results-badge ${note.soon ? "is-soon" : ""}`} title={`${note.text}${event ? ` · ${event.purpose}` : ""}`}>
      {compact ? "R" : note.text}
    </span>
  );
}
