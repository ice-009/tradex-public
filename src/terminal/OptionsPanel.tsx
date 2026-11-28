"use client";

import "./options.css";
import { useMemo, useState, type PointerEvent } from "react";
import type { OptionRange, OptionsDayRow, OptionsResponse } from "@/contracts/api";
import { formatCompact, formatPrice } from "@/core/format";
import { ivPoints, ivText, type IvRank, type OptionPoint, type OptionView } from "@/core/options/summary";
import { dayLabel } from "@/core/reference/timeMachine";
import { useOptions, useOptionsDay } from "@/client/optionsFeed";
import { useTimeMachine } from "@/client/timeMachine";
import { niceTicks, useWidth } from "./LabCardCharts";
import { updateActiveCell, useTerminal } from "./store";
import { SymbolLogo } from "./Watchlist";

// The Options side panel (issue #36): the charted underlying's option summary
// on the newest stored day — IV term structure (near, next, 30-day), the IV
// rank against its own year, the move the near straddle prices, skew, the
// put–call ratio, max pain and the OI walls — with its IV history, and a
// "Market" view of every underlying that day. Everything comes from the Market
// Data Hub's daily option summaries (NSE's F&O bhavcopy back to 2001), as of
// the Time Machine's day when one is set. Information only: nothing here is a
// score input; option signals go through the Signal Lab first (#38).

const RANGES: Array<{ id: OptionRange; label: string }> = [
  { id: "1y", label: "1Y" },
  { id: "5y", label: "5Y" },
  { id: "all", label: "All" },
];

const pct = (value: number | null, digits = 1) => (value === null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}%`);
const num = (value: number | null, digits = 2) => (value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits));
const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

export function OptionsPanel({ symbol }: { symbol: string }) {
  const [view, setView] = useState<"symbol" | "market">("symbol");
  const past = useTimeMachine((state) => state.asOf !== null);
  return (
    <>
      <div className="tx-side-sub">
        <div className="tx-seg tx-seg-wide" role="tablist">
          <button type="button" role="tab" aria-selected={view === "symbol"} className={view === "symbol" ? "is-active" : ""} onClick={() => setView("symbol")}>
            {symbol}
          </button>
          <button type="button" role="tab" aria-selected={view === "market"} className={view === "market" ? "is-active" : ""} onClick={() => setView("market")}>
            Market
          </button>
        </div>
        <span className="tx-side-note">NSE F&amp;O archive via your Market Data Hub · end of day{past ? " · as of the Time Machine's day" : ""}</span>
      </div>
      <div className="tx-wl-list tx-opt" data-testid="options-panel">
        {view === "symbol" ? <SymbolOptions symbol={symbol} /> : <MarketOptions />}
      </div>
    </>
  );
}

function PanelState({ children, tone }: { children: React.ReactNode; tone?: "warn" }) {
  return <div className={`tx-empty tx-opt-state ${tone === "warn" ? "is-warn" : ""}`}>{children}</div>;
}

// ------------------------------------------------------------------ one underlying

function SymbolOptions({ symbol }: { symbol: string }) {
  const [range, setRange] = useState<OptionRange>("1y");
  const answer = useOptions(symbol, range);
  if (!answer || answer.status === "loading") return <PanelState>Loading option summaries…</PanelState>;
  if (answer.status === "failed") return <PanelState tone="warn">Couldn&apos;t load option summaries: {answer.error}</PanelState>;
  if (answer.status === "unavailable")
    return (
      <PanelState tone={answer.reason === "error" ? "warn" : undefined}>
        <span data-testid="options-unavailable" data-reason={answer.reason}>
          {answer.message}
        </span>
      </PanelState>
    );
  if (answer.status === "empty") return <PanelState>{answer.message}</PanelState>;
  return <OptionsDay answer={answer} range={range} onRange={setRange} />;
}

function OptionsDay({ answer, range, onRange }: { answer: Extract<OptionsResponse, { status: "ready" }>; range: OptionRange; onRange: (range: OptionRange) => void }) {
  const { day, view, rank } = answer;
  return (
    <div className="tx-opt-body">
      <div className="tx-opt-head">
        <span>
          <strong>{answer.symbol}</strong> options · <span data-testid="options-day">{dayLabel(day.day)}</span>
        </span>
        {day.spot !== null && <span className="tx-dim">spot {formatPrice(day.spot)}</span>}
      </div>

      <section className="tx-opt-section">
        <h4>Implied volatility</h4>
        <TermGrid view={view} />
        <p className="tx-opt-line">
          {view.term.shape === null
            ? "Term structure: needs both expiries' ATM IV."
            : view.term.shape === "flat"
              ? `Term structure flat (${ivPoints(view.term.slope)} next vs near).`
              : view.term.shape === "upward"
                ? `Term structure upward (${ivPoints(view.term.slope)}): later expiries priced higher, the usual calm state.`
                : `Term structure inverted (${ivPoints(view.term.slope)}): the near expiry is priced richer — near-term stress or an event before it.`}
        </p>
        <RankLine rank={rank} hubPercentile={day.ivPercentile} />
      </section>

      <section className="tx-opt-section">
        <div className="tx-opt-chart-head">
          <h4>IV history</h4>
          <div className="tx-seg" role="tablist" aria-label="IV history range">
            {RANGES.map((entry) => (
              <button type="button" key={entry.id} role="tab" aria-selected={range === entry.id} className={range === entry.id ? "is-active" : ""} onClick={() => onRange(entry.id)}>
                {entry.label}
              </button>
            ))}
          </div>
        </div>
        <IvHistoryChart points={answer.history} />
      </section>

      <section className="tx-opt-section">
        <h4>Move priced to expiry</h4>
        {view.move ? (
          <>
            <p className="tx-opt-big" data-testid="options-move">
              ±{view.move.pct.toFixed(1)}% <span className="tx-dim">by {shortDate(view.move.expiry)} ({view.move.days} days)</span>
            </p>
            <p className="tx-opt-line">
              {formatPrice(view.move.low)} – {formatPrice(view.move.high)}: the ATM straddle ({formatPrice(view.move.straddle)}
              {day.near?.atmStrike ? ` at the ${formatPrice(day.near.atmStrike, 0)} strike` : ""}) around the forward {formatPrice(view.move.forward)}. One standard deviation is about ±{view.move.sigmaPct.toFixed(1)}%.
              {view.move.modelled && <span className="tx-opt-warn"> Partly modelled: an ATM leg didn&apos;t trade.</span>}
            </p>
          </>
        ) : (
          <p className="tx-opt-line tx-dim">No straddle for the near expiry that day.</p>
        )}
      </section>

      <section className="tx-opt-section">
        <h4>Skew{view.skew ? ` · ${shortDate(view.skew.expiry)}` : ""}</h4>
        {view.skew ? (
          <dl className="tx-opt-grid">
            <Fact label="25Δ put" value={ivText(view.skew.put25)} />
            <Fact label="25Δ call" value={ivText(view.skew.call25)} />
            <Fact label="Put − call" value={ivPoints(view.skew.skew25)} hint={view.skew.lean === "puts" ? "Downside protection priced richer (the usual state for indices)." : view.skew.lean === "calls" ? "Upside calls priced richer than puts." : undefined} />
            <Fact
              label="Call − put IV"
              value={ivPoints(view.skew.cpSpread, 2)}
              hint={view.skew.cpSpread === null ? "Only with a futures forward (a parity forward makes it ~0 by construction)." : "OI-weighted over strikes where both legs traded (Cremers & Weinbaum)."}
            />
          </dl>
        ) : (
          <p className="tx-opt-line tx-dim">No 25-delta strikes that day.</p>
        )}
      </section>

      <section className="tx-opt-section">
        <h4>Positioning</h4>
        <dl className="tx-opt-grid">
          <Fact label="PCR (OI)" value={num(view.pcr.oi)} hint="Put OI / call OI over every expiry." />
          <Fact label="PCR (volume)" value={num(view.pcr.volume)} hint="Put / call contracts traded that day." />
          <Fact label="Call OI change" value={signed(view.pcr.callChgOi)} hint="Shares, each contract's own change (an expired series isn't counted as unwound)." />
          <Fact label="Put OI change" value={signed(view.pcr.putChgOi)} />
          {view.optionToStock !== null && <Fact label="Options / stock vol" value={`${view.optionToStock.toFixed(1)}×`} hint="Shares traded in options (contracts × lot) over the cash market's volume." />}
        </dl>
      </section>

      {view.levels && (
        <section className="tx-opt-section">
          <h4>Levels · {shortDate(view.levels.expiry)} expiry</h4>
          <dl className="tx-opt-grid">
            <LevelFact label="Max pain" level={view.levels.maxPain} hint="The strike where option holders' payout at expiry, on that day's OI, is smallest." />
            <LevelFact label="Call wall" level={view.levels.callWall} hint="The strike with the most call OI (resistance, if it holds)." />
            <LevelFact label="Put wall" level={view.levels.putWall} hint="The strike with the most put OI (support, if it holds)." />
          </dl>
        </section>
      )}

      <ul className="tx-opt-notes">
        {[...view.notes, ...answer.notes, ...(answer.asOf?.notes ?? [])].map((note) => (
          <li key={note}>{note}</li>
        ))}
        <li>Information only, not scored: no option signal has passed the Signal Lab yet.</li>
      </ul>
    </div>
  );
}

const signed = (value: number) => (Number.isFinite(value) ? `${value >= 0 ? "+" : "−"}${formatCompact(Math.abs(value))}` : "—");

function Fact({ label, value, hint, sub }: { label: string; value: string; hint?: string; sub?: string }) {
  return (
    <div className="tx-opt-fact" title={hint}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {sub && <dd className="tx-opt-sub">{sub}</dd>}
    </div>
  );
}

function LevelFact({ label, level, hint }: { label: string; level: { strike: number; fromSpotPct: number | null; oi: number | null } | null; hint: string }) {
  return (
    <div className="tx-opt-fact" title={hint}>
      <dt>{label}</dt>
      <dd>
        {level ? formatPrice(level.strike, level.strike % 1 ? 2 : 0) : "—"}
        {level?.fromSpotPct !== null && level?.fromSpotPct !== undefined && <span className="tx-dim"> {pct(level.fromSpotPct)}</span>}
        {level?.oi ? <span className="tx-dim"> · {formatCompact(level.oi)} OI</span> : null}
      </dd>
    </div>
  );
}

function TermGrid({ view }: { view: OptionView }) {
  const { near, next, iv30 } = view.term;
  return (
    <dl className="tx-opt-grid tx-opt-term">
      <Fact label="Near ATM" value={ivText(near?.iv ?? null)} sub={near ? `${shortDate(near.expiry)} · ${near.days}d` : "—"} hint="ATM implied volatility of the first expiry after the day (Black-76)." />
      <Fact label="Next ATM" value={ivText(next?.iv ?? null)} sub={next ? `${shortDate(next.expiry)} · ${next.days}d` : "—"} hint="ATM implied volatility of the second expiry after the day." />
      <Fact label="30-day" value={ivText(iv30)} sub="constant maturity" hint="ATM IV at a constant 30 days, interpolating total variance between expiries (for NIFTY it sits just under India VIX, which also prices the wings)." />
    </dl>
  );
}

function RankLine({ rank, hubPercentile }: { rank: IvRank | null; hubPercentile: number | null }) {
  if (!rank)
    return (
      <p className="tx-opt-line tx-dim">
        IV rank needs 60 days with a 30-day IV in the year up to this day{hubPercentile !== null ? ` (the hub ranks it at the ${hubPercentile.toFixed(0)}th percentile)` : ""}.
      </p>
    );
  return (
    <p className="tx-opt-line" data-testid="options-rank">
      <strong>IV rank {rank.rank.toFixed(0)}</strong> · percentile {rank.percentile.toFixed(0)} — the 30-day IV against {rank.days} days of it from {dayLabel(rank.from)} (low {ivText(rank.low)}, high {ivText(rank.high)}).
    </p>
  );
}

// ------------------------------------------------------------------ IV history chart

const CHART_HEIGHT = 132;
const PAD = { top: 8, right: 40, bottom: 18, left: 4 };

/** iv30 (solid) and the near expiry's ATM IV (dashed), drawn as SVG at the element's width like the Lab's report-card charts. */
export function IvHistoryChart({ points }: { points: OptionPoint[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const geo = useMemo(() => {
    const usable = points.filter((point) => point.iv30 !== null || point.nearIv !== null);
    if (!width || usable.length < 2) return null;
    const values = usable.flatMap((point) => [point.iv30, point.nearIv].filter((value): value is number => value !== null));
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    const padding = (hi - lo) * 0.08 || 0.01;
    lo = Math.max(0, lo - padding);
    hi += padding;
    const t0 = usable[0].day;
    const t1 = usable.at(-1)!.day;
    const plotW = Math.max(10, width - PAD.left - PAD.right);
    const plotH = CHART_HEIGHT - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0 || 1)) * plotW;
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * plotH;
    const line = (pick: (point: OptionPoint) => number | null) => {
      let d = "";
      let open = false;
      for (const point of usable) {
        const value = pick(point);
        if (value === null) {
          open = false;
          continue;
        }
        d += `${open ? "L" : "M"}${x(point.day).toFixed(1)},${y(value).toFixed(1)}`;
        open = true;
      }
      return d;
    };
    const spanDays = (t1 - t0) / 86_400_000;
    const labels: number[] = [];
    const first = new Date(t0);
    if (spanDays > 3 * 365) for (let year = first.getUTCFullYear() + 1; year <= new Date(t1).getUTCFullYear(); year += 1) labels.push(Date.UTC(year, 0, 1));
    else for (let m = first.getUTCFullYear() * 12 + first.getUTCMonth() + 1; m <= new Date(t1).getUTCFullYear() * 12 + new Date(t1).getUTCMonth(); m += spanDays > 400 ? 6 : 3) labels.push(Date.UTC(Math.floor(m / 12), m % 12, 1));
    const step = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(plotW / 56))));
    return { usable, x, y, iv30: line((point) => point.iv30), near: line((point) => point.nearIv), ticks: niceTicks(lo, hi, 4), labels: labels.filter((_, i) => i % step === 0), spanDays, plotW };
  }, [points, width]);

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!geo) return;
    const px = event.clientX - event.currentTarget.getBoundingClientRect().left;
    let best = 0;
    for (let i = 1; i < geo.usable.length; i += 1) if (Math.abs(geo.x(geo.usable[i].day) - px) < Math.abs(geo.x(geo.usable[best].day) - px)) best = i;
    setHover(best);
  };

  const shown = geo ? geo.usable[hover ?? geo.usable.length - 1] : null;
  return (
    <div className="tx-opt-chart" ref={ref} data-testid="options-iv-chart">
      <div className="tx-opt-legend">
        <span className="is-iv30">30-day</span>
        <span className="is-near">near ATM</span>
        {shown && (
          <span className="tx-opt-legend-value">
            {dayLabel(shown.day)} · {ivText(shown.iv30)} / {ivText(shown.nearIv)}
            {shown.ivPercentile !== null ? ` · p${shown.ivPercentile.toFixed(0)}` : ""}
          </span>
        )}
      </div>
      {!geo ? (
        <p className="tx-dim tx-opt-line">{points.length < 2 ? "Too few option days to draw." : ""}</p>
      ) : (
        <svg width={width} height={CHART_HEIGHT} role="img" aria-label={`Implied volatility over ${geo.usable.length} option days`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {geo.ticks.map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={PAD.left + geo.plotW} y1={geo.y(tick)} y2={geo.y(tick)} className="tx-opt-grid-line" />
              <text x={PAD.left + geo.plotW + 4} y={geo.y(tick) + 3} className="tx-opt-tick">
                {(tick * 100).toFixed(0)}%
              </text>
            </g>
          ))}
          {geo.labels.map((t) => (
            <text key={t} x={geo.x(t)} y={CHART_HEIGHT - 4} className="tx-opt-tick" textAnchor="middle">
              {geo.spanDays > 3 * 365 ? new Date(t).getUTCFullYear() : new Date(t).toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" })}
            </text>
          ))}
          <path d={geo.near} className="tx-opt-line-near" />
          <path d={geo.iv30} className="tx-opt-line-iv30" />
          {hover !== null && shown && (
            <g pointerEvents="none">
              <line x1={geo.x(shown.day)} x2={geo.x(shown.day)} y1={PAD.top} y2={CHART_HEIGHT - PAD.bottom} className="tx-opt-cross" />
              {shown.iv30 !== null && <circle cx={geo.x(shown.day)} cy={geo.y(shown.iv30)} r={3} className="tx-opt-dot" />}
            </g>
          )}
        </svg>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the day's cross-section

type SortKey = "rank" | "iv" | "move" | "pcr";
const SORTS: Array<{ id: SortKey; label: string; value: (row: OptionsDayRow) => number | null; title: string }> = [
  { id: "rank", label: "IV rank", value: (row) => row.ivPercentile, title: "iv30's percentile against the symbol's own prior year (the hub's; needs 60 days)" },
  { id: "iv", label: "IV", value: (row) => row.iv30, title: "ATM IV at a constant 30 days" },
  { id: "move", label: "Move", value: (row) => row.movePct, title: "The near ATM straddle as % of the forward: the move priced to expiry" },
  { id: "pcr", label: "PCR", value: (row) => row.pcrOi, title: "Put OI / call OI over every expiry" },
];

function MarketOptions() {
  const answer = useOptionsDay(true);
  const [kind, setKind] = useState<"stock" | "index">("stock");
  const [sort, setSort] = useState<SortKey>("rank");
  const active = useTerminal((state) => state.cells[state.activeCell].symbol);
  const rows = useMemo(() => {
    if (!answer || answer.status !== "ready") return [];
    const value = SORTS.find((entry) => entry.id === sort)!.value;
    return answer.rows.filter((row) => row.kind === kind).sort((a, b) => (value(b) ?? -Infinity) - (value(a) ?? -Infinity) || a.symbol.localeCompare(b.symbol));
  }, [answer, kind, sort]);
  if (!answer || answer.status === "loading") return <PanelState>Loading the day&apos;s option summaries…</PanelState>;
  if (answer.status === "failed") return <PanelState tone="warn">Couldn&apos;t load option summaries: {answer.error}</PanelState>;
  if (answer.status === "unavailable")
    return (
      <PanelState tone={answer.reason === "error" ? "warn" : undefined}>
        <span data-testid="options-unavailable" data-reason={answer.reason}>
          {answer.message}
        </span>
      </PanelState>
    );
  const sortDef = SORTS.find((entry) => entry.id === sort)!;
  return (
    <>
      <div className="tx-opt-market-tools">
        <div className="tx-seg" role="tablist" aria-label="Underlyings">
          {(["stock", "index"] as const).map((entry) => (
            <button type="button" key={entry} role="tab" aria-selected={kind === entry} className={kind === entry ? "is-active" : ""} onClick={() => setKind(entry)}>
              {entry === "stock" ? "Stocks" : "Indices"}
            </button>
          ))}
        </div>
        <span className="tx-side-note" data-testid="options-market-day">
          {dayLabel(answer.day)} · {rows.length}
        </span>
      </div>
      <div className="tx-mk-cols tx-opt-cols">
        <span>Symbol</span>
        {SORTS.map((entry) => (
          <button type="button" key={entry.id} className={`tx-opt-sort ${sort === entry.id ? "is-active" : ""}`} title={entry.title} onClick={() => setSort(entry.id)}>
            {entry.label}
            {sort === entry.id && " ▼"}
          </button>
        ))}
      </div>
      {!rows.length && <PanelState>No {kind === "stock" ? "stock" : "index"} options that day.</PanelState>}
      {rows.map((row) => (
        <div
          key={row.symbol}
          role="button"
          tabIndex={0}
          className={`tx-mk-row tx-opt-row ${row.symbol === active ? "is-active" : ""}`}
          title={`${row.symbol}: ${sortDef.label} ${sortDef.value(row) ?? "—"}`}
          onClick={() => updateActiveCell({ symbol: row.symbol })}
          onKeyDown={(event) => event.key === "Enter" && updateActiveCell({ symbol: row.symbol })}
        >
          <span className="tx-wl-symbol">
            <SymbolLogo symbol={row.symbol} />
            <span className="tx-wl-symbol-text">{row.symbol}</span>
          </span>
          <span className="tx-opt-num">{row.ivPercentile !== null ? row.ivPercentile.toFixed(0) : "—"}</span>
          <span className="tx-opt-num">{ivText(row.iv30, 0)}</span>
          <span className="tx-opt-num">{row.movePct !== null ? `±${row.movePct.toFixed(1)}%` : "—"}</span>
          <span className="tx-opt-num">{num(row.pcrOi)}</span>
        </div>
      ))}
      {answer.notes.map((note) => (
        <p key={note} className="tx-opt-line tx-dim tx-opt-pad">
          {note}
        </p>
      ))}
    </>
  );
}
